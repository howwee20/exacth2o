import { FastifyReply, FastifyRequest } from 'fastify'
import { IRoute } from '../types/IRoute';
import Reading from '../models/reading'; // Import the Reading model
import { Op } from 'sequelize';
import { MySQLRowDataPacket } from '@fastify/mysql'
import { createGzip } from 'zlib'
import { EXPORT_CHUNK_SIZE, formatDateInCentralTime, escapeCsvValue, writeToGzip } from '../utils/csvExportUtils'

const getReadings = async (request: FastifyRequest<{ Querystring: { page?: number, pageSize?: number } }>, reply: FastifyReply) => {
  try {
    const page = request.query.page ? parseInt(request.query.page as any) : 1;
    const pageSize = request.query.pageSize ? parseInt(request.query.pageSize as any) : 100;
    const offset = (page - 1) * pageSize;

    const { count, rows } = await Reading.findAndCountAll({
      limit: pageSize,
      offset: offset,
      order: [['createdAt', 'DESC']]
    });

    const totalPages = Math.ceil(count / pageSize);

    reply.send({
      data: rows,
      pagination: {
        total: count,
        page: page,
        pageSize: pageSize,
        totalPages: totalPages
      }
    });
  } catch (error) {
    console.error(error);
    reply.code(500).send({ message: 'Internal Server Error' });
  }
}

const getReading = async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
  const { id } = request.params;
  try {
    const reading = await Reading.findByPk(id);
    if (reading) {
      reply.send(reading);
    } else {
      reply.code(404).send({ message: 'Reading not found' });
    }
  } catch (error) {
    console.error(error);
    reply.code(500).send({ message: 'Internal Server Error' });
  }
}

const getReadingsWithFilters = async (request: FastifyRequest<{
  Body: {
    sensorIds?: string[],
    startDate?: string,
    endDate?: string,
    page?: number,
    pageSize?: number
  }
}>, reply: FastifyReply) => {
  const { sensorIds, startDate, endDate, page: rawPage, pageSize: rawPageSize } = request.body;
  const page = rawPage ? parseInt(rawPage as any) : 1;
  const pageSize = rawPageSize ? parseInt(rawPageSize as any) : 100;
  const offset = (page - 1) * pageSize;

  const whereClause = {
    ...(sensorIds && { sensorId: { [Op.in]: sensorIds } }),

    ...((startDate || endDate) && {
      createdAt: {
        ...(startDate ? { [Op.gte]: new Date(startDate) } : {}),
        ...(endDate ? { [Op.lte]: new Date(endDate) } : {})
      }
    })
  }
  try {
    const { count, rows } = await Reading.findAndCountAll({
      where: whereClause,
      order: [['createdAt', 'DESC']],
      limit: pageSize,
      offset: offset,
    });

    const totalPages = Math.ceil(count / pageSize);

    reply.send({
      data: rows,
      pagination: {
        total: count,
        page: page,
        pageSize: pageSize,
        totalPages: totalPages
      }
    });
  } catch (error) {
    console.error(error);
    reply.code(500).send({ message: 'Internal Server Error' });
  }
}

// Get first and last reading timestamps
const getReadingTimeRange = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const oldestReading = await Reading.findOne({
      order: [['createdAt', 'ASC']]
    });

    const newestReading = await Reading.findOne({
      order: [['createdAt', 'DESC']]
    });

    reply.send({
      oldest: oldestReading ? oldestReading.createdAt : null,
      newest: newestReading ? newestReading.createdAt : null
    });
  } catch (error) {
    console.error(error);
    reply.code(500).send({ message: 'Internal Server Error' });
  }
}

const createReading = async (request: FastifyRequest<{ Body: { sensorId: string, rawValue: number, calibratedValue: number, temperature?: number | null, electricalConductivity?: number | null } }>, reply: FastifyReply) => {
  const { sensorId, rawValue, calibratedValue, temperature, electricalConductivity } = request.body;
  try {
    const reading = await Reading.create({ sensorId, rawValue, calibratedValue, temperature, electricalConductivity });
    reply.send(reading);
  } catch (error) {
    console.error(error);
    reply.code(500).send({ message: 'Internal Server Error' });
  }
}

const updateReading = async (request: FastifyRequest<{ Params: { id: string }, Body: { sensorId?: number, rawValue?: number, calibratedValue?: number, temperature?: number | null, electricalConductivity?: number | null } }>, reply: FastifyReply) => {
  const { id } = request.params;
  const { sensorId, rawValue, calibratedValue, temperature, electricalConductivity } = request.body;
  try {
    const reading = await Reading.findByPk(id);
    if (reading) {
      if (sensorId !== undefined) reading.sensorId = sensorId;
      if (rawValue !== undefined) reading.rawValue = rawValue;
      if (calibratedValue !== undefined) reading.calibratedValue = calibratedValue;
      if (temperature !== undefined) reading.temperature = temperature;
      if (electricalConductivity !== undefined) reading.electricalConductivity = electricalConductivity;
      await reading.save();
      reply.send(reading);
    } else {
      reply.code(404).send({ message: 'Reading not found' });
    }
  } catch (error) {
    console.error(error);
    reply.code(500).send({ message: 'Internal Server Error' });
  }
}

const deleteReading = async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
  const { id } = request.params;
  try {
    const reading = await Reading.findByPk(id);
    if (reading) {
      await reading.destroy();
      reply.send({ message: 'Reading deleted successfully' });
    } else {
      reply.code(404).send({ message: 'Reading not found' });
    }
  } catch (error) {
    console.error(error);
    reply.code(500).send({ message: 'Internal Server Error' });
  }
}

interface ExportReadingRow extends MySQLRowDataPacket {
  id: number
  sensorId: number
  rawValue: number
  calibratedValue: number | null
  temperature: number | null
  electricalConductivity: number | null
  createdAt: Date | string
  updatedAt: Date | string
}

const CSV_HEADERS = [
  'sensorId',
  'rawValue',
  'calibratedValue',
  'temperature',
  'electricalConductivity',
  'createdAt',
  'updatedAt'
]

const buildExportSql = (sensorIds: number[], hasStartDate: boolean, hasEndDate: boolean) => {
  const filters: string[] = ['(createdAt > ? OR (createdAt = ? AND id > ?))']

  if (sensorIds.length > 0) {
    filters.push(`sensorId IN (${sensorIds.map(() => '?').join(',')})`)
  }

  if (hasStartDate) {
    filters.push('createdAt >= ?')
  }

  if (hasEndDate) {
    filters.push('createdAt <= ?')
  }

  return `
    SELECT id, sensorId, rawValue, calibratedValue, temperature, electricalConductivity, createdAt, updatedAt
    FROM readings
    WHERE ${filters.join(' AND ')}
    ORDER BY createdAt ASC, id ASC
    LIMIT ?
  `
}

const exportReadingsStream = async (request: FastifyRequest<{
  Querystring: {
    sensorIds?: string,
    startDate?: string,
    endDate?: string
  }
}>, reply: FastifyReply) => {
  try {
    const { sensorIds, startDate, endDate } = request.query

    const parsedSensorIds = sensorIds
      ? sensorIds
          .split(',')
          .map((value) => Number.parseInt(value.trim(), 10))
          .filter((value) => Number.isInteger(value) && value > 0)
      : []

    if (sensorIds && parsedSensorIds.length === 0) {
      reply.code(400).send({ message: 'Invalid sensorIds query parameter' })
      return
    }

    if (startDate && Number.isNaN(Date.parse(startDate))) {
      reply.code(400).send({ message: 'Invalid startDate query parameter' })
      return
    }

    if (endDate && Number.isNaN(Date.parse(endDate))) {
      reply.code(400).send({ message: 'Invalid endDate query parameter' })
      return
    }

    const startDateParam = startDate ? new Date(startDate) : undefined
    const endDateParam = endDate ? new Date(endDate) : undefined

    const exportDate = new Date().toISOString().split('T')[0]
    const fileName = `sensor-readings-${exportDate}.csv.gz`

    reply.hijack()
    reply.raw.statusCode = 200
    reply.raw.setHeader('Content-Type', 'application/gzip')
    reply.raw.setHeader('Content-Disposition', `attachment; filename="${fileName}"`)
    reply.raw.setHeader('Cache-Control', 'no-store')

    const gzip = createGzip({ level: 6 })
    gzip.pipe(reply.raw)

    await writeToGzip(gzip, `${CSV_HEADERS.join(',')}\n`)

    let lastCreatedAt = startDateParam ? new Date(startDateParam) : new Date(0)
    let lastId = 0
    const sql = buildExportSql(parsedSensorIds, Boolean(startDateParam), Boolean(endDateParam))

    while (true) {
      const params: (number | Date)[] = [lastCreatedAt, lastCreatedAt, lastId]

      if (parsedSensorIds.length > 0) {
        params.push(...parsedSensorIds)
      }

      if (startDateParam) {
        params.push(startDateParam)
      }

      if (endDateParam) {
        params.push(endDateParam)
      }

      params.push(EXPORT_CHUNK_SIZE)

      const [rows] = await request.server.mysql.query<ExportReadingRow[]>(sql, params)

      if (!rows || rows.length === 0) {
        break
      }

      const csvChunk = `${rows.map((row) => {
        return [
          escapeCsvValue(row.sensorId),
          escapeCsvValue(row.rawValue),
          escapeCsvValue(row.calibratedValue),
          escapeCsvValue(row.temperature),
          escapeCsvValue(row.electricalConductivity),
          escapeCsvValue(formatDateInCentralTime(row.createdAt)),
          escapeCsvValue(formatDateInCentralTime(row.updatedAt))
        ].join(',')
      }).join('\n')}\n`

      await writeToGzip(gzip, csvChunk)

      const lastRow = rows[rows.length - 1]
      lastCreatedAt = new Date(lastRow.createdAt)
      lastId = lastRow.id
    }

    gzip.end()
  } catch (error) {
    console.error('Error exporting readings:', error)

    if (!reply.raw.headersSent) {
      reply.code(500).send({ message: 'Failed to export readings' })
      return
    }

    reply.raw.destroy(error as Error)
  }
}

export const getAllReadingsRoute: IRoute = {
  method: 'GET',
  url: '/readings',
  handler: getReadings
}

export const getReadingByIdRoute: IRoute = {
  method: 'GET',
  url: '/readings/:id',
  handler: getReading
}

export const getReadingsWithFiltersRoute: IRoute = {
  method: 'POST',
  url: '/readings/filtered',
  handler: getReadingsWithFilters
}

export const getReadingTimeRangeRoute: IRoute = {
  method: 'GET',
  url: '/readings/timerange',
  handler: getReadingTimeRange
}

export const createReadingRoute: IRoute = {
  method: 'POST',
  url: '/readings',
  handler: createReading
}

export const updateReadingRoute: IRoute = {
  method: 'PUT',
  url: '/readings/:id',
  handler: updateReading
}

export const deleteReadingRoute: IRoute = {
  method: 'DELETE',
  url: '/readings/:id',
  handler: deleteReading
}

export const exportReadingsStreamRoute: IRoute = {
  method: 'GET',
  url: '/readings/export-stream',
  handler: exportReadingsStream
}
