import { FastifyReply, FastifyRequest } from 'fastify'
import { IRoute } from '../types/IRoute';
import Log from '../models/log'; // Import the Log model
import { Op } from 'sequelize';
import { MySQLRowDataPacket } from '@fastify/mysql'
import { createGzip } from 'zlib'
import { EXPORT_CHUNK_SIZE, formatDateInCentralTime, escapeCsvValue, writeToGzip } from '../utils/csvExportUtils'
import { sendApiError, withTimeout } from '../utils/requestTimeout'

// only gets the last 1000 logs
const getLogs = async (request: FastifyRequest<any>, reply: FastifyReply) => {
  try {
    const logs = await withTimeout(
      Log.findAll({
        order: [['createdAt', 'DESC']],
        limit: 1000
      }),
      'logs database lookup'
    );
    reply.send(logs);
  } catch (error) {
    sendApiError(reply, error, 'Get logs');
  }
}

const getLogsPaginated = async (request: FastifyRequest<{
  Querystring: {
    page?: string,
    limit?: string
  }
}>, reply: FastifyReply) => {
  try {
    const page = parseInt(request.query.page || '1', 10);
    const limit = parseInt(request.query.limit || '1000', 10);

    // Validate pagination parameters
    if (page < 1) {
      reply.code(400).send({ message: 'Page must be greater than 0' });
      return;
    }

    if (limit < 1 || limit > 1000) {
      reply.code(400).send({ message: 'Limit must be between 1 and 1000' });
      return;
    }

    const offset = (page - 1) * limit;

    const { count, rows: logs } = await withTimeout(
      Log.findAndCountAll({
        order: [['createdAt', 'DESC']],
        limit,
        offset
      }),
      'paginated logs database lookup'
    );

    const totalPages = Math.ceil(count / limit);

    reply.send({
      data: logs,
      pagination: {
        currentPage: page,
        totalPages,
        totalItems: count,
        itemsPerPage: limit,
        hasNextPage: page < totalPages,
        hasPreviousPage: page > 1
      }
    });
  } catch (error) {
    sendApiError(reply, error, 'Get paginated logs');
  }
}



const getLog = async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
  const { id } = request.params;
  try {
    const log = await Log.findByPk(id);
    if (log) {
      reply.send(log);
    } else {
      reply.code(404).send({ message: 'Log not found' });
    }
  } catch (error) {
    console.error(error);
    reply.code(500).send({ message: 'Internal Server Error' });
  }
}

const createLog = async (request: FastifyRequest<{
  Body: {
    level: string,
    message: string,
    source?: string,
    data?: Record<string, unknown>
  }
}>, reply: FastifyReply) => {
  const { level, message, source, data } = request.body;
  try {
    const newLog = await Log.create({
      level,
      message,
      source,
      data: data || {}
    });
    reply.code(201).send(newLog);
  } catch (error) {
    console.error(error);
    reply.code(500).send({ message: 'Internal Server Error' });
  }
}

const deleteLog = async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
  const { id } = request.params;
  try {
    const log = await Log.findByPk(id);
    if (!log) {
      reply.code(404).send({ message: 'Log not found' });
      return;
    }
    await log.destroy();
    reply.send({ message: 'Log deleted successfully' });
  } catch (error) {
    console.error(error);
    reply.code(500).send({ message: 'Internal Server Error' });
  }
}

const searchLogs = async (request: FastifyRequest<{
  Body: {
    level?: string,
    message?: string,
    source?: string,
    startDate?: string,
    endDate?: string,
    limit?: number
  }
}>, reply: FastifyReply) => {
  const { level, message, source, startDate, endDate, limit = 100 } = request.body;

  try {
    const whereClause: any = {};

    if (level) {
      whereClause.level = level;
    }

    if (message) {
      const trimmedMessage = message.trim();
      whereClause.message = {
        [Op.like]: trimmedMessage === 'Opened Valve:' ? `${trimmedMessage}%` : `%${message}%`
      };
    }

    if (source) {
      whereClause.source = source;
    }

    if (startDate || endDate) {
      whereClause.createdAt = {};

      if (startDate) {
        whereClause.createdAt[Op.gte] = new Date(startDate);
      }

      if (endDate) {
        whereClause.createdAt[Op.lte] = new Date(endDate);
      }
    }

    const logs = await withTimeout(
      Log.findAll({
        where: whereClause,
        order: [['createdAt', 'DESC']],
        limit: Math.min(limit, 1000) // Limit to 1000 just in case
      }),
      'log search database lookup'
    );

    reply.send(logs);
  } catch (error) {
    sendApiError(reply, error, 'Search logs');
  }
}

const deleteLogs = async (request: FastifyRequest<{
  Querystring: {
    level?: string,
    source?: string,
    olderThan?: string
  }
}>, reply: FastifyReply) => {
  const { level, source, olderThan } = request.query;

  try {
    const whereClause: any = {};

    if (level) {
      whereClause.level = level;
    }

    if (source) {
      whereClause.source = source;
    }

    if (olderThan) {
      whereClause.createdAt = {
        [Op.lt]: new Date(olderThan)
      };
    }

    // Safety check - don't allow deleting all logs without any filter
    if (Object.keys(whereClause).length === 0) {
      reply.code(400).send({
        message: 'Cannot delete all logs. Please provide at least one filter criteria.'
      });
      return;
    }

    const deletedCount = await Log.destroy({
      where: whereClause
    });

    reply.send({ deletedCount });
  } catch (error) {
    console.error(error);
    reply.code(500).send({ message: 'Internal Server Error' });
  }
}

// Streaming export functionality
interface ExportLogRow extends MySQLRowDataPacket {
  id: number
  level: string
  message: string
  source: string | null
  data: string | object | null
  createdAt: Date | string
  updatedAt: Date | string
}

const LOGS_CSV_HEADERS = ['id', 'level', 'message', 'source', 'data', 'createdAt', 'updatedAt']

const exportLogsStream = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const exportDate = new Date().toISOString().split('T')[0]
    const fileName = `logs-${exportDate}.csv.gz`

    reply.hijack()
    reply.raw.statusCode = 200
    reply.raw.setHeader('Content-Type', 'application/gzip')
    reply.raw.setHeader('Content-Disposition', `attachment; filename="${fileName}"`)
    reply.raw.setHeader('Cache-Control', 'no-store')

    const gzip = createGzip({ level: 6 })
    gzip.pipe(reply.raw)

    await writeToGzip(gzip, `${LOGS_CSV_HEADERS.join(',')}\n`)

    let lastId = 0
    const sql = `SELECT id, level, message, source, data, createdAt, updatedAt FROM logs WHERE id > ? ORDER BY id ASC LIMIT ?`

    while (true) {
      const [rows] = await request.server.mysql.query<ExportLogRow[]>(sql, [lastId, EXPORT_CHUNK_SIZE])
      if (!rows || rows.length === 0) break

      const csvChunk = rows.map((row) => {
        // Convert data object to JSON string if needed
        let dataStr = ''
        if (row.data) {
          dataStr = typeof row.data === 'object' ? JSON.stringify(row.data) : String(row.data)
        }
        return [
          escapeCsvValue(row.id),
          escapeCsvValue(row.level),
          escapeCsvValue(row.message),
          escapeCsvValue(row.source),
          escapeCsvValue(dataStr),
          escapeCsvValue(formatDateInCentralTime(row.createdAt)),
          escapeCsvValue(formatDateInCentralTime(row.updatedAt))
        ].join(',')
      }).join('\n') + '\n'

      await writeToGzip(gzip, csvChunk)
      lastId = rows[rows.length - 1].id
    }

    gzip.end()
  } catch (error) {
    console.error('Error exporting logs:', error)
    if (!reply.raw.headersSent) {
      reply.code(500).send({ message: 'Failed to export logs' })
      return
    }
    reply.raw.destroy(error as Error)
  }
}

export const getLogsRoute: IRoute = {
  method: 'GET',
  url: '/logs',
  handler: getLogs
}

export const getLogsPaginatedRoute: IRoute = {
  method: 'GET',
  url: '/logs/paginated',
  handler: getLogsPaginated
}

// NOTE: export-stream must be registered BEFORE :id to avoid route collision
export const exportLogsStreamRoute: IRoute = {
  method: 'GET',
  url: '/logs/export-stream',
  handler: exportLogsStream
}

export const getLogRoute: IRoute = {
  method: 'GET',
  url: '/logs/:id',
  handler: getLog
}

export const createLogRoute: IRoute = {
  method: 'POST',
  url: '/logs',
  handler: createLog
}

export const deleteLogRoute: IRoute = {
  method: 'DELETE',
  url: '/logs/:id',
  handler: deleteLog
}

export const searchLogsRoute: IRoute = {
  method: 'POST',
  url: '/logs/search',
  handler: searchLogs
}

export const deleteLogsRoute: IRoute = {
  method: 'DELETE',
  url: '/logs',
  handler: deleteLogs
}

// Explicit ordered array to ensure deterministic route registration.
// export-stream MUST come before :id routes to avoid param route shadowing.
export const logsRoutes: IRoute[] = [
  getLogsRoute,
  getLogsPaginatedRoute,
  exportLogsStreamRoute, // Must be before getLogRoute to avoid :id collision
  getLogRoute,
  createLogRoute,
  deleteLogRoute,
  searchLogsRoute,
  deleteLogsRoute,
]
