import { FastifyReply, FastifyRequest } from 'fastify'
import { IRoute } from '../types/IRoute';
import { MySQLRowDataPacket } from '@fastify/mysql'
import { Valve } from '../models';
import { createGzip } from 'zlib'
import { EXPORT_CHUNK_SIZE, formatDateInCentralTime, escapeCsvValue, writeToGzip } from '../utils/csvExportUtils'
import { CRON_REQUEST_TIMEOUT_MS, fetchWithTimeout, sendApiError, withTimeout } from '../utils/requestTimeout'
import { secretsMatch } from '../utils/controllerMutationAuth'

const getValves = async (request: FastifyRequest<any>, reply: FastifyReply) => {
  try {
    const valves = await withTimeout(Valve.findAll(), 'valves database lookup')
    reply.send(valves)
  } catch (error) {
    sendApiError(reply, error, 'Get valves')
  }
}

const getValve = async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
  // Get the Valve id from the request
  const { id } = request.params

  try {
    const valve = await withTimeout(Valve.findByPk(id), `valve ${id} database lookup`)
    if (valve) {
      reply.send(valve)
    } else {
      reply.code(404).send({ message: 'Valve not found' })
    }
  } catch (error) {
    sendApiError(reply, error, 'Get valve')
  }
}

const createValve = async (request: FastifyRequest<{ Body: { address: string, relayAddress: string } }>, reply: FastifyReply) => {
  // Get the Valve name from the request
  const { address, relayAddress } = request.body
  try {
    const valve = await Valve.create({ address, relayAddress })
    reply.send(valve)
  } catch (error) {
    console.error(error)
    reply.code(500).send({ message: 'Internal Server Error' })
  }
}

const updateValve = async (request: FastifyRequest<{ Params: { id: string }, Body: { address: string, relayAddress: string, boardSerialId: string } }>, reply: FastifyReply) => {
  // Get the Valve id and name from the request
  const { id } = request.params
  const { address, relayAddress, boardSerialId } = request.body
  const server = request.server
  const sqlUpdateValve = `UPDATE valves SET address = ?, relayAddress = ?, boardSerialId = ? WHERE id = ?`
  try {
    const [rows, fields] = await server.mysql.query<MySQLRowDataPacket[]>(sqlUpdateValve, [address, relayAddress, boardSerialId, id])
    reply.send(rows[0])
  } catch (error) {
    console.error(error)
    reply.code(500).send({ message: 'Internal Server Error' })
  }
}

const deleteValve = async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
  // Get the Valve id from the request
  const { id } = request.params
  const server = request.server
  const sqlDeleteValve = `DELETE FROM valves WHERE id = ?`
  try {
    const [rows, fields] = await server.mysql.query<MySQLRowDataPacket[]>(sqlDeleteValve, [id])
    reply.send(rows)
  } catch (error) {
    console.error(error)
    reply.code(500).send({ message: 'Internal Server Error' })
  }
}

const operateValve = async (request: FastifyRequest<{ Body: { operation: string, address: string, relayAddress: string } }>, reply: FastifyReply) => {
  const { address, relayAddress, operation } = request.body
  try {
    // Make sure operation is valid (open or close)
    if (operation !== 'OPEN' && operation !== 'CLOSE') {
      reply.code(400).send({ message: 'Invalid operation. Must be "OPEN" or "CLOSE"' })
      return
    }

    // Raw, unauthenticated OPEN requests have no automatic close guarantee.
    // Automatic irrigation uses the scheduler directly, while portal manual
    // watering uses the authenticated, duration-bounded /valves/pulse route.
    if (operation === 'OPEN') {
      reply.code(410).send({
        message: 'Legacy valve OPEN is disabled. Use the authenticated timed pulse route.'
      })
      return
    }

    //post(`/${pathPrefix}/valves`, async (request: FastifyRequest<{ Body: { relayAddress: string, address: number, state: 'OPEN' | 'CLOSE' } }>
    const response = await fetchWithTimeout(
      `${process.env.CRON_URL}/valves`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-exacth2o-controller-secret': String(
            process.env.EXACTH2O_CONTROLLER_COMMAND_SECRET || ''
          ),
        },
        body: JSON.stringify({ relayAddress, address, state: operation })
      },
      'cron valve operation',
      CRON_REQUEST_TIMEOUT_MS
    )

    reply.code(200).send(response)

  } catch (error) {
    sendApiError(reply, error, 'Operate valve')
  }
}

const pulseValve = async (request: FastifyRequest<{
  Body: {
    relayAddress: string | number
    address: number
    durationMilliseconds: number
    pulseId: string
    commandId: string
  }
}>, reply: FastifyReply) => {
  const expectedSecret = String(process.env.EXACTH2O_CONTROLLER_COMMAND_SECRET || '')
  const suppliedSecret = String(request.headers['x-exacth2o-controller-secret'] || '')
  const authenticated = secretsMatch(suppliedSecret, expectedSecret)
  if (!authenticated) {
    reply.code(401).send({ message: 'Controller command authentication required' })
    return
  }

  try {
    const response = await fetchWithTimeout(
      `${process.env.CRON_URL}/valves/pulse`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-exacth2o-controller-secret': expectedSecret,
        },
        body: JSON.stringify(request.body),
      },
      'cron timed valve pulse',
      Math.max(CRON_REQUEST_TIMEOUT_MS, 10_000),
    )
    const text = await response.text()
    let body: unknown = text
    try {
      body = text ? JSON.parse(text) : {}
    } catch {
      // Retain the text body for a definite controller rejection.
    }
    reply.code(response.status).send(body)
  } catch (error) {
    sendApiError(reply, error, 'Pulse valve')
  }
}


export const getAllValvesRoute: IRoute = {
  method: 'GET',
  url: '/valves',
  handler: getValves
}

export const getValveByIdRoute: IRoute = {
  method: 'GET',
  url: '/valves/:id',
  handler: getValve
}

export const createValveRoute: IRoute = {
  method: 'POST',
  url: '/valves',
  handler: createValve
}

export const updateValveRoute: IRoute = {
  method: 'PUT',
  url: '/valves/:id',
  handler: updateValve
}

export const deleteValveRoute: IRoute = {
  method: 'DELETE',
  url: '/valves/:id',
  handler: deleteValve
}

export const operateValveRoute: IRoute = {
  method: 'POST',
  url: '/valves/operate',
  handler: operateValve
}

export const pulseValveRoute: IRoute = {
  method: 'POST',
  url: '/valves/pulse',
  handler: pulseValve,
}

// Streaming export functionality
interface ExportValveRow extends MySQLRowDataPacket {
  id: number
  address: string
  relayAddress: string
  createdAt: Date | string
  updatedAt: Date | string
}

const VALVES_CSV_HEADERS = ['id', 'address', 'relayAddress', 'createdAt', 'updatedAt']

const exportValvesStream = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const exportDate = new Date().toISOString().split('T')[0]
    const fileName = `valves-${exportDate}.csv.gz`

    reply.hijack()
    reply.raw.statusCode = 200
    reply.raw.setHeader('Content-Type', 'application/gzip')
    reply.raw.setHeader('Content-Disposition', `attachment; filename="${fileName}"`)
    reply.raw.setHeader('Cache-Control', 'no-store')

    const gzip = createGzip({ level: 6 })
    gzip.pipe(reply.raw)

    await writeToGzip(gzip, `${VALVES_CSV_HEADERS.join(',')}\n`)

    let lastId = 0
    const sql = `SELECT id, address, relayAddress, createdAt, updatedAt FROM valves WHERE id > ? ORDER BY id ASC LIMIT ?`

    while (true) {
      const [rows] = await request.server.mysql.query<ExportValveRow[]>(sql, [lastId, EXPORT_CHUNK_SIZE])
      if (!rows || rows.length === 0) break

      const csvChunk = rows.map((row) => [
        escapeCsvValue(row.id),
        escapeCsvValue(row.address),
        escapeCsvValue(row.relayAddress),
        escapeCsvValue(formatDateInCentralTime(row.createdAt)),
        escapeCsvValue(formatDateInCentralTime(row.updatedAt))
      ].join(',')).join('\n') + '\n'

      await writeToGzip(gzip, csvChunk)
      lastId = rows[rows.length - 1].id
    }

    gzip.end()
  } catch (error) {
    console.error('Error exporting valves:', error)
    if (!reply.raw.headersSent) {
      reply.code(500).send({ message: 'Failed to export valves' })
      return
    }
    reply.raw.destroy(error as Error)
  }
}

export const exportValvesStreamRoute: IRoute = {
  method: 'GET',
  url: '/valves/export-stream',
  handler: exportValvesStream
}
