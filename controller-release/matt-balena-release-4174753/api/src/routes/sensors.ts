import { FastifyReply, FastifyRequest } from 'fastify'
import { IRoute } from '../types/IRoute';
import Sensor from '../models/sensor'; // Import the Sensor model
import { MySQLRowDataPacket } from '@fastify/mysql'
import { createGzip } from 'zlib'
import { EXPORT_CHUNK_SIZE, formatDateInCentralTime, escapeCsvValue, writeToGzip } from '../utils/csvExportUtils'
import {
  SENSOR_READ_TIMEOUT_MS,
  fetchWithTimeout,
  sendApiError,
  withTimeout,
} from '../utils/requestTimeout'

const getSensors = async (request: FastifyRequest<any>, reply: FastifyReply) => {
  try {
    const sensors = await withTimeout(Sensor.findAll(), 'sensors database lookup');
    reply.send(sensors);
  } catch (error) {
    sendApiError(reply, error, 'Get sensors');
  }
}

const getSensor = async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
  const { id } = request.params;
  try {
    const sensor = await withTimeout(Sensor.findByPk(id), `sensor ${id} database lookup`);
    if (sensor) {
      reply.send(sensor);
    } else {
      reply.code(404).send({ message: 'Sensor not found' });
    }
  } catch (error) {
    sendApiError(reply, error, 'Get sensor');
  }
}

const createSensor = async (request: FastifyRequest<{ Body: { name: string, type: string, description?: string, address?: string, boardSerialId?: string } }>, reply: FastifyReply) => {
  const { name, type, description, address, boardSerialId } = request.body;
  try {
    const sensor = await Sensor.create({ name, type, description, address, boardSerialId });
    reply.send(sensor);
  } catch (error) {
    console.error(error);
    reply.code(500).send({ message: 'Internal Server Error' });
  }
}

const updateSensor = async (request: FastifyRequest<{ Params: { id: string }, Body: { name: string, type: string, description?: string, address?: string, boardSerialId?: string } }>, reply: FastifyReply) => {
  const { id } = request.params;
  const { name, type, description, address, boardSerialId } = request.body;
  try {
    const sensor = await withTimeout(Sensor.findByPk(id), `sensor ${id} database lookup`);
    if (sensor) {
      if (name) sensor.name = name;
      if (type) sensor.type = type;
      if (description) sensor.description = description;
      if (address) sensor.address = address;
      if (boardSerialId) sensor.boardSerialId = boardSerialId;
      await sensor.save();
      reply.send(sensor);
    } else {
      reply.code(404).send({ message: 'Sensor not found' });
    }
  } catch (error) {
    console.error(error);
    reply.code(500).send({ message: 'Internal Server Error' });
  }
}

const deleteSensor = async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
  const { id } = request.params;
  try {
    const sensor = await Sensor.findByPk(id);
    if (sensor) {
      await sensor.destroy();
      reply.send({ message: 'Sensor deleted successfully' });
    } else {
      reply.code(404).send({ message: 'Sensor not found' });
    }
  } catch (error) {
    console.error(error);
    reply.code(500).send({ message: 'Internal Server Error' });
  }
}

const getSensorDirectReading = async (request: FastifyRequest<{ Params: { id: string, measurements?: number } }>, reply: FastifyReply) => {
  const { id, measurements = 1 } = request.params
  try {
    // Validate measurements parameter
    if (measurements < 1 || measurements > 10) {
      reply.code(400).send({ message: 'Measurements must be between 1 and 10' })
      return
    }

    // Find the sensor to get its address
    const sensor = await Sensor.findByPk(id);
    if (!sensor) {
      reply.code(404).send({ message: 'Sensor not found' })
      return
    }

    if (!sensor.address) {
      reply.code(400).send({ message: 'Sensor does not have an address configured' })
      return
    }

    //get(`/${pathPrefix}/sensors`, async (request: FastifyRequest<{ Params: { boardSerialId: string, sensorAddress: string, measurements?: number } }>
    const response = await fetchWithTimeout(
      `${process.env.CRON_URL}/sensors?boardSerialId=${sensor.boardSerialId}&sensorAddress=${sensor.address}&measurements=${measurements}`,
      {},
      `sensor ${id} direct reading`,
      SENSOR_READ_TIMEOUT_MS
    )
    const data = await response.json()

    reply.code(200).send({
      value: data,
      sensorId: id,
      timestamp: new Date().toISOString(),
      measurements
    })
  } catch (error) {
    sendApiError(reply, error, 'Get sensor direct reading')
  }
}


export const getAllSensorsRoute: IRoute = {
  method: 'GET',
  url: '/sensors',
  handler: getSensors
}

export const getSensorByIdRoute: IRoute = {
  method: 'GET',
  url: '/sensors/:id',
  handler: getSensor
}

export const createSensorRoute: IRoute = {
  method: 'POST',
  url: '/sensors',
  handler: createSensor
}

export const updateSensorRoute: IRoute = {
  method: 'PUT',
  url: '/sensors/:id',
  handler: updateSensor
}

export const deleteSensorRoute: IRoute = {
  method: 'DELETE',
  url: '/sensors/:id',
  handler: deleteSensor
}

export const getSensorRawReadingRoute: IRoute = {
  method: 'GET',
  url: '/sensors/:id/direct-reading/:measurements',
  handler: getSensorDirectReading
}

// Streaming export functionality
interface ExportSensorRow extends MySQLRowDataPacket {
  id: number
  name: string
  type: string
  description: string | null
  address: string | null
  boardSerialId: string | null
  createdAt: Date | string
  updatedAt: Date | string
}

const SENSORS_CSV_HEADERS = ['id', 'name', 'type', 'description', 'address', 'boardSerialId', 'createdAt', 'updatedAt']

const exportSensorsStream = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const exportDate = new Date().toISOString().split('T')[0]
    const fileName = `sensors-${exportDate}.csv.gz`

    reply.hijack()
    reply.raw.statusCode = 200
    reply.raw.setHeader('Content-Type', 'application/gzip')
    reply.raw.setHeader('Content-Disposition', `attachment; filename="${fileName}"`)
    reply.raw.setHeader('Cache-Control', 'no-store')

    const gzip = createGzip({ level: 6 })
    gzip.pipe(reply.raw)

    await writeToGzip(gzip, `${SENSORS_CSV_HEADERS.join(',')}\n`)

    let lastId = 0
    const sql = `SELECT id, name, type, description, address, boardSerialId, createdAt, updatedAt FROM sensors WHERE id > ? ORDER BY id ASC LIMIT ?`

    while (true) {
      const [rows] = await request.server.mysql.query<ExportSensorRow[]>(sql, [lastId, EXPORT_CHUNK_SIZE])
      if (!rows || rows.length === 0) break

      const csvChunk = rows.map((row) => [
        escapeCsvValue(row.id),
        escapeCsvValue(row.name),
        escapeCsvValue(row.type),
        escapeCsvValue(row.description),
        escapeCsvValue(row.address),
        escapeCsvValue(row.boardSerialId),
        escapeCsvValue(formatDateInCentralTime(row.createdAt)),
        escapeCsvValue(formatDateInCentralTime(row.updatedAt))
      ].join(',')).join('\n') + '\n'

      await writeToGzip(gzip, csvChunk)
      lastId = rows[rows.length - 1].id
    }

    gzip.end()
  } catch (error) {
    console.error('Error exporting sensors:', error)
    if (!reply.raw.headersSent) {
      reply.code(500).send({ message: 'Failed to export sensors' })
      return
    }
    reply.raw.destroy(error as Error)
  }
}

export const exportSensorsStreamRoute: IRoute = {
  method: 'GET',
  url: '/sensors/export-stream',
  handler: exportSensorsStream
}
