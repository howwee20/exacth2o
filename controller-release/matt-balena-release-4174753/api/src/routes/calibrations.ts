import { FastifyReply, FastifyRequest } from 'fastify'
import { IRoute } from '../types/IRoute';
import Calibration from '../models/calibration';
import { MySQLRowDataPacket } from '@fastify/mysql'
import { createGzip } from 'zlib'
import { EXPORT_CHUNK_SIZE, formatDateInCentralTime, escapeCsvValue, writeToGzip } from '../utils/csvExportUtils'
import { sendApiError, withTimeout } from '../utils/requestTimeout'

const getCalibrations = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const calibrations = await withTimeout(Calibration.findAll(), 'calibrations database lookup');
    reply.send(calibrations);
  } catch (error) {
    sendApiError(reply, error, 'Get calibrations');
  }
}

const getCalibration = async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
  const { id } = request.params;
  try {
    const calibration = await withTimeout(Calibration.findByPk(id), `calibration ${id} database lookup`);
    if (calibration) {
      reply.send(calibration);
    } else {
      reply.code(404).send({ message: 'Calibration not found' });
    }
  } catch (error) {
    sendApiError(reply, error, 'Get calibration');
  }
}

const checkCalibrationName = async (request: FastifyRequest<{ Params: { name: string } }>, reply: FastifyReply) => {
  const { name } = request.params;
  try {
    const calibration = await Calibration.findOne({
      where: { name }
    });

    reply.send({ exists: !!calibration });
  } catch (error) {
    console.error(error);
    reply.code(500).send({ message: 'Internal Server Error' });
  }
}

const createCalibration = async (request: FastifyRequest<{
  Body: {
    name: string,
    polynomialCoefficientsCommaDelimited: string,
    readingsJSONString: string
  }
}>, reply: FastifyReply) => {
  const { name, polynomialCoefficientsCommaDelimited, readingsJSONString } = request.body;

  // Validation
  if (!name || typeof name !== 'string' || name.trim() === '') {
    reply.code(400).send({ message: 'Name is required' });
    return;
  }

  if (!polynomialCoefficientsCommaDelimited || typeof polynomialCoefficientsCommaDelimited !== 'string' || polynomialCoefficientsCommaDelimited.trim() === '') {
    reply.code(400).send({ message: 'Polynomial coefficients are required' });
    return;
  }

  if (!readingsJSONString || typeof readingsJSONString !== 'string' || readingsJSONString.trim() === '') {
    reply.code(400).send({ message: 'Readings JSON is required' });
    return;
  }

  try {
    // Check if name already exists
    const existingCalibration = await Calibration.findOne({
      where: { name }
    });

    if (existingCalibration) {
      reply.code(400).send({ message: 'A calibration with this name already exists' });
      return;
    }

    // Create calibration
    const calibration = await Calibration.create({
      name,
      polynomialCoefficientsCommaDelimited,
      readingsJSONString
    });

    reply.code(201).send(calibration);
  } catch (error) {
    console.error(error);
    reply.code(500).send({ message: 'Internal Server Error' });
  }
}

const deleteCalibration = async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
  const { id } = request.params;
  try {
    const calibration = await Calibration.findByPk(id);
    if (calibration) {
      await calibration.destroy();
      reply.send({ message: 'Calibration deleted successfully' });
    } else {
      reply.code(404).send({ message: 'Calibration not found' });
    }
  } catch (error) {
    console.error(error);
    reply.code(500).send({ message: 'Internal Server Error' });
  }
}

export const getAllCalibrationsRoute: IRoute = {
  method: 'GET',
  url: '/calibrations',
  handler: getCalibrations
}

export const getCalibrationByIdRoute: IRoute = {
  method: 'GET',
  url: '/calibrations/:id',
  handler: getCalibration
}

export const checkCalibrationNameRoute: IRoute = {
  method: 'GET',
  url: '/calibrations/check-name/:name',
  handler: checkCalibrationName
}

export const createCalibrationRoute: IRoute = {
  method: 'POST',
  url: '/calibrations',
  handler: createCalibration
}

export const deleteCalibrationRoute: IRoute = {
  method: 'DELETE',
  url: '/calibrations/:id',
  handler: deleteCalibration
}

// Streaming export functionality
interface ExportCalibrationRow extends MySQLRowDataPacket {
  id: number
  name: string
  polynomialCoefficientsCommaDelimited: string
  readingsJSONString: string
  createdAt: Date | string
  updatedAt: Date | string
}

const CALIBRATIONS_CSV_HEADERS = ['id', 'name', 'polynomialCoefficientsCommaDelimited', 'readingsJSONString', 'createdAt', 'updatedAt']

const exportCalibrationsStream = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const exportDate = new Date().toISOString().split('T')[0]
    const fileName = `calibrations-${exportDate}.csv.gz`

    reply.hijack()
    reply.raw.statusCode = 200
    reply.raw.setHeader('Content-Type', 'application/gzip')
    reply.raw.setHeader('Content-Disposition', `attachment; filename="${fileName}"`)
    reply.raw.setHeader('Cache-Control', 'no-store')

    const gzip = createGzip({ level: 6 })
    gzip.pipe(reply.raw)

    await writeToGzip(gzip, `${CALIBRATIONS_CSV_HEADERS.join(',')}\n`)

    let lastId = 0
    const sql = `SELECT id, name, polynomialCoefficientsCommaDelimited, readingsJSONString, createdAt, updatedAt FROM calibrations WHERE id > ? ORDER BY id ASC LIMIT ?`

    while (true) {
      const [rows] = await request.server.mysql.query<ExportCalibrationRow[]>(sql, [lastId, EXPORT_CHUNK_SIZE])
      if (!rows || rows.length === 0) break

      const csvChunk = rows.map((row) => [
        escapeCsvValue(row.id),
        escapeCsvValue(row.name),
        escapeCsvValue(row.polynomialCoefficientsCommaDelimited),
        escapeCsvValue(row.readingsJSONString),
        escapeCsvValue(formatDateInCentralTime(row.createdAt)),
        escapeCsvValue(formatDateInCentralTime(row.updatedAt))
      ].join(',')).join('\n') + '\n'

      await writeToGzip(gzip, csvChunk)
      lastId = rows[rows.length - 1].id
    }

    gzip.end()
  } catch (error) {
    console.error('Error exporting calibrations:', error)
    if (!reply.raw.headersSent) {
      reply.code(500).send({ message: 'Failed to export calibrations' })
      return
    }
    reply.raw.destroy(error as Error)
  }
}

export const exportCalibrationsStreamRoute: IRoute = {
  method: 'GET',
  url: '/calibrations/export-stream',
  handler: exportCalibrationsStream
}
