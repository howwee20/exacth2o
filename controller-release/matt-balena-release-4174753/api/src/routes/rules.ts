import { FastifyReply, FastifyRequest } from 'fastify'
import { IRoute } from '../types/IRoute';
import Rule from '../models/rule'; // Import the Rule model
import { MySQLRowDataPacket } from '@fastify/mysql'
import { createGzip } from 'zlib'
import { EXPORT_CHUNK_SIZE, formatDateInCentralTime, escapeCsvValue, writeToGzip } from '../utils/csvExportUtils'

const getRules = async (request: FastifyRequest<any>, reply: FastifyReply) => {
  try {
    const rules = await Rule.findAll();
    reply.send(rules);
  } catch (error) {
    console.error(error);
    reply.code(500).send({ message: 'Internal Server Error' });
  }
}

const getRule = async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
  const { id } = request.params;
  try {
    const rule = await Rule.findByPk(id);
    if (rule) {
      reply.send(rule);
    } else {
      reply.code(404).send({ message: 'Rule not found' });
    }
  } catch (error) {
    console.error(error);
    reply.code(500).send({ message: 'Internal Server Error' });
  }
}

const createRule = async (request: FastifyRequest<{
  Body: {
    name: string,
    isActive: boolean,
    ruleJSON: string
  }
}>, reply: FastifyReply) => {
  const { name, isActive, ruleJSON } = request.body;
  try {
    const rule = await Rule.create({ name, isActive, ruleJSON });
    reply.send(rule);
  } catch (error) {
    console.error(error);
    reply.code(500).send({ message: 'Internal Server Error' });
  }
}

const updateRule = async (request: FastifyRequest<{
  Params: { id: string }, Body: {
    name: string,
    isActive: boolean,
    ruleJSON: string
  }
}>, reply: FastifyReply) => {
  const { id } = request.params;
  const { name, isActive, ruleJSON } = request.body;
  try {
    const rule = await Rule.findByPk(id);
    if (rule) {
      if (name) rule.name = name;
      if (isActive !== undefined) rule.isActive = isActive;
      if (ruleJSON) rule.ruleJSON = Buffer.from(ruleJSON);
      await rule.save();
      reply.send(rule);
    } else {
      reply.code(404).send({ message: 'Rule not found' });
    }
  } catch (error) {
    console.error(error);
    reply.code(500).send({ message: 'Internal Server Error' });
  }
}

const deleteRule = async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
  const { id } = request.params;
  try {
    const rule = await Rule.findByPk(id);
    if (rule) {
      await rule.destroy();
      reply.send({ message: 'Rule deleted successfully' });
    } else {
      reply.code(404).send({ message: 'Rule not found' });
    }
  } catch (error) {
    console.error(error);
    reply.code(500).send({ message: 'Internal Server Error' });
  }
}

export const getAllRulesRoute: IRoute = {
  method: 'GET',
  url: '/rules',
  handler: getRules
}

export const getRuleByIdRoute: IRoute = {
  method: 'GET',
  url: '/rules/:id',
  handler: getRule
}

export const createRuleRoute: IRoute = {
  method: 'POST',
  url: '/rules',
  handler: createRule
}

export const updateRuleRoute: IRoute = {
  method: 'PUT',
  url: '/rules/:id',
  handler: updateRule
}

export const deleteRuleRoute: IRoute = {
  method: 'DELETE',
  url: '/rules/:id',
  handler: deleteRule
}

// Streaming export functionality
interface ExportRuleRow extends MySQLRowDataPacket {
  id: number
  name: string
  isActive: boolean | number
  ruleJSON: Buffer | string
  createdAt: Date | string
  updatedAt: Date | string
}

const RULES_CSV_HEADERS = ['id', 'name', 'isActive', 'ruleJSON', 'createdAt', 'updatedAt']

const exportRulesStream = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const exportDate = new Date().toISOString().split('T')[0]
    const fileName = `rules-${exportDate}.csv.gz`

    reply.hijack()
    reply.raw.statusCode = 200
    reply.raw.setHeader('Content-Type', 'application/gzip')
    reply.raw.setHeader('Content-Disposition', `attachment; filename="${fileName}"`)
    reply.raw.setHeader('Cache-Control', 'no-store')

    const gzip = createGzip({ level: 6 })
    gzip.pipe(reply.raw)

    await writeToGzip(gzip, `${RULES_CSV_HEADERS.join(',')}\n`)

    let lastId = 0
    const sql = `SELECT id, name, isActive, ruleJSON, createdAt, updatedAt FROM rules WHERE id > ? ORDER BY id ASC LIMIT ?`

    while (true) {
      const [rows] = await request.server.mysql.query<ExportRuleRow[]>(sql, [lastId, EXPORT_CHUNK_SIZE])
      if (!rows || rows.length === 0) break

      const csvChunk = rows.map((row) => {
        // Convert ruleJSON Buffer to string if needed
        let ruleJSONStr = ''
        if (row.ruleJSON) {
          ruleJSONStr = Buffer.isBuffer(row.ruleJSON) ? row.ruleJSON.toString('utf8') : String(row.ruleJSON)
        }
        return [
          escapeCsvValue(row.id),
          escapeCsvValue(row.name),
          escapeCsvValue(row.isActive ? 'true' : 'false'),
          escapeCsvValue(ruleJSONStr),
          escapeCsvValue(formatDateInCentralTime(row.createdAt)),
          escapeCsvValue(formatDateInCentralTime(row.updatedAt))
        ].join(',')
      }).join('\n') + '\n'

      await writeToGzip(gzip, csvChunk)
      lastId = rows[rows.length - 1].id
    }

    gzip.end()
  } catch (error) {
    console.error('Error exporting rules:', error)
    if (!reply.raw.headersSent) {
      reply.code(500).send({ message: 'Failed to export rules' })
      return
    }
    reply.raw.destroy(error as Error)
  }
}

export const exportRulesStreamRoute: IRoute = {
  method: 'GET',
  url: '/rules/export-stream',
  handler: exportRulesStream
}