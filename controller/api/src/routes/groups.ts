import { FastifyReply, FastifyRequest } from 'fastify'
import { IRoute } from '../types/IRoute';
import { Group } from '../models'; // Import the Group model
import { MySQLRowDataPacket } from '@fastify/mysql'
import { createGzip } from 'zlib'
import { EXPORT_CHUNK_SIZE, formatDateInCentralTime, escapeCsvValue, writeToGzip } from '../utils/csvExportUtils'

const getGroups = async (request: FastifyRequest<any>, reply: FastifyReply) => {
  try {
    const groups = await Group.findAll();
    reply.send(groups);
  } catch (error) {
    console.error(error);
    reply.code(500).send({ message: 'Internal Server Error' });
  }
}

const getGroup = async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
  const { id } = request.params;
  try {
    const group = await Group.findByPk(id);
    if (group) {
      reply.send(group);
    } else {
      reply.code(404).send({ message: 'Group not found' });
    }
  } catch (error) {
    console.error(error);
    reply.code(500).send({ message: 'Internal Server Error' });
  }
}

const createGroup = async (request: FastifyRequest<{ Body: { name: string, type: string | undefined } }>, reply: FastifyReply) => {
  const { name, type } = request.body;
  try {
    // Check if a group with this name already exists
    const existingGroup = await Group.findOne({ where: { name } });
    if (existingGroup) {
      reply.code(400).send({ message: 'Group name already exists' });
      return;
    }

    const group = await Group.create({ name, type });
    reply.send(group);
  } catch (error) {
    console.error(error);
    reply.code(500).send({ message: 'Internal Server Error' });
  }
}

const updateGroup = async (request: FastifyRequest<{ Params: { id: string }, Body: { name: string, type: string | undefined } }>, reply: FastifyReply) => {
  const { id } = request.params;
  const { name, type } = request.body;
  try {
    const group = await Group.findByPk(id);
    if (group) {
      // Check if a group with this name already exists (excluding current group)
      if (name && name !== group.name) {
        const existingGroup = await Group.findOne({ where: { name } });
        if (existingGroup) {
          reply.code(400).send({ message: 'Group name already exists' });
          return;
        }
      }

      if (name) {
        group.name = name;
      }
      if (type) {
        group.type = type;
      }
      await group.save();
      reply.send(group);
    } else {
      reply.code(404).send({ message: 'Group not found' });
    }
  } catch (error) {
    console.error(error);
    reply.code(500).send({ message: 'Internal Server Error' });
  }
}

const deleteGroup = async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
  const { id } = request.params;
  try {
    const group = await Group.findByPk(id);
    if (group) {
      await group.destroy();
      reply.send({ message: 'Group deleted successfully', numRowsDeleted: 1 });
    } else {
      reply.code(404).send({ message: 'Group not found' });
    }
  } catch (error) {
    console.error(error);
    reply.code(500).send({ message: 'Internal Server Error' });
  }
}

export const getAllGroupsRoute: IRoute = {
  method: 'GET',
  url: '/groups',
  handler: getGroups
}

export const getGroupByIdRoute: IRoute = {
  method: 'GET',
  url: '/groups/:id',
  handler: getGroup
}

export const createGroupRoute: IRoute = {
  method: 'POST',
  url: '/groups',
  handler: createGroup
}

export const updateGroupRoute: IRoute = {
  method: 'PUT',
  url: '/groups/:id',
  handler: updateGroup
}

export const deleteGroupRoute: IRoute = {
  method: 'DELETE',
  url: '/groups/:id',
  handler: deleteGroup
}

// Streaming export functionality
interface ExportGroupRow extends MySQLRowDataPacket {
  id: number
  name: string
  type: string
  createdAt: Date | string
  updatedAt: Date | string
}

const GROUPS_CSV_HEADERS = ['id', 'name', 'type', 'createdAt', 'updatedAt']

const exportGroupsStream = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const exportDate = new Date().toISOString().split('T')[0]
    const fileName = `groups-${exportDate}.csv.gz`

    reply.hijack()
    reply.raw.statusCode = 200
    reply.raw.setHeader('Content-Type', 'application/gzip')
    reply.raw.setHeader('Content-Disposition', `attachment; filename="${fileName}"`)
    reply.raw.setHeader('Cache-Control', 'no-store')

    const gzip = createGzip({ level: 6 })
    gzip.pipe(reply.raw)

    await writeToGzip(gzip, `${GROUPS_CSV_HEADERS.join(',')}\n`)

    let lastId = 0
    const sql = `SELECT id, name, type, createdAt, updatedAt FROM \`groups\` WHERE id > ? ORDER BY id ASC LIMIT ?`

    while (true) {
      const [rows] = await request.server.mysql.query<ExportGroupRow[]>(sql, [lastId, EXPORT_CHUNK_SIZE])
      if (!rows || rows.length === 0) break

      const csvChunk = rows.map((row) => [
        escapeCsvValue(row.id),
        escapeCsvValue(row.name),
        escapeCsvValue(row.type),
        escapeCsvValue(formatDateInCentralTime(row.createdAt)),
        escapeCsvValue(formatDateInCentralTime(row.updatedAt))
      ].join(',')).join('\n') + '\n'

      await writeToGzip(gzip, csvChunk)
      lastId = rows[rows.length - 1].id
    }

    gzip.end()
  } catch (error) {
    console.error('Error exporting groups:', error)
    if (!reply.raw.headersSent) {
      reply.code(500).send({ message: 'Failed to export groups' })
      return
    }
    reply.raw.destroy(error as Error)
  }
}

export const exportGroupsStreamRoute: IRoute = {
  method: 'GET',
  url: '/groups/export-stream',
  handler: exportGroupsStream
}