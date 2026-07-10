import { FastifyReply, FastifyRequest } from 'fastify'
import { IRoute } from '../types/IRoute';
import { Pairing, System, Sensor, Valve } from '../models';
import { MachineState } from '../models/system';
import Calibration from '../models/calibration';
import { MySQLRowDataPacket } from '@fastify/mysql'
import { createGzip } from 'zlib'
import { EXPORT_CHUNK_SIZE, formatDateInCentralTime, escapeCsvValue, writeToGzip } from '../utils/csvExportUtils'
import { sendApiError, withTimeout } from '../utils/requestTimeout'

async function stopIfSystemStateIsRunning(reply: FastifyReply): Promise<boolean> {
  const system = await withTimeout(System.findOne({ where: { id: 1 } }), 'system state database lookup')
  if (system?.state === MachineState.RUNNING) {
    reply.code(400).send({ message: 'Action blocked. System state is "running"' })
    return true; // reply sent
  }
  return false; // reply not sent
}

const getPairings = async (request: FastifyRequest<any>, reply: FastifyReply) => {
  try {
    const pairings = await withTimeout(
      Pairing.findAll({
        include: [
          {
            model: Sensor,
            attributes: ['address', 'type', 'boardSerialId']
          },
          {
            model: Valve,
            attributes: ['address', 'relayAddress']
          },
          {
            model: Calibration,
            attributes: ['name', 'polynomialCoefficientsCommaDelimited']
          }
        ]
      }),
      'pairings database lookup'
    );
    console.log('pairings', pairings);
    reply.send(pairings);
  } catch (error) {
    sendApiError(reply, error, 'Get pairings');
  }
}

const getPairing = async (request: FastifyRequest<{ Params: { sensorId: number, valveId: number } }>, reply: FastifyReply) => {
  const { sensorId, valveId } = request.params;
  try {
    const pairing = await withTimeout(
      Pairing.findOne({
        where: { sensorId, valveId },
        include: [
          {
            model: Sensor,
            attributes: ['address', 'type', 'boardSerialId']
          },
          {
            model: Valve,
            attributes: ['address', 'relayAddress']
          },
          {
            model: Calibration,
            attributes: ['name', 'polynomialCoefficientsCommaDelimited']
          }
        ]
      }),
      `pairing ${sensorId}/${valveId} database lookup`
    );
    if (pairing) {
      reply.send(pairing);
    } else {
      reply.code(404).send({ message: 'Pairing not found' });
    }
  } catch (error) {
    sendApiError(reply, error, 'Get pairing');
  }
}

const getPairingBySensorId = async (request: FastifyRequest<{ Params: { sensorId: number } }>, reply: FastifyReply) => {
  const { sensorId } = request.params;
  try {
    const pairings = await withTimeout(Pairing.findAll({ where: { sensorId } }), `sensor ${sensorId} pairings database lookup`);
    reply.send(pairings);
  } catch (error) {
    sendApiError(reply, error, 'Get pairings by sensor');
  }
}

const createPairing = async (request: FastifyRequest<{
  Body: {
    sensorId: number,
    valveId: number,
    groupId?: number,
    name?: string,
    WTCPercentLimit?: number,
    ValveOpenTime?: number,
    MeasurementInterval?: number,
    calibrationId?: number
  }
}>, reply: FastifyReply) => {
  if (await stopIfSystemStateIsRunning(reply)) return;

  const {
    sensorId,
    valveId,
    groupId,
    name,
    WTCPercentLimit,
    ValveOpenTime,
    MeasurementInterval,
    calibrationId
  } = request.body;

  try {
    const pairing = await Pairing.create({
      sensorId,
      valveId,
      groupId,
      name,
      WTCPercentLimit,
      ValveOpenTime,
      MeasurementInterval,
      calibrationId
    });
    reply.send(pairing);
  } catch (error) {
    console.error(error);
    reply.code(500).send({ message: 'Internal Server Error' });
  }
}

const updatePairing = async (request: FastifyRequest<{
  Params: { sensorId: number, valveId: number }, Body: {
    groupId?: number,
    name?: string,
    WTCPercentLimit?: number,
    ValveOpenTime?: number,
    MeasurementInterval?: number,
    calibrationId?: number,
  }
}>, reply: FastifyReply) => {
  if (await stopIfSystemStateIsRunning(reply)) return;

  const { sensorId, valveId } = request.params;
  const {
    groupId,
    name,
    WTCPercentLimit,
    ValveOpenTime,
    MeasurementInterval,
    calibrationId,
  } = request.body;
  try {
    const pairing = await Pairing.findOne({ where: { sensorId, valveId } });
    if (pairing) {
      if (groupId !== undefined) pairing.groupId = groupId;
      if (name !== undefined) pairing.name = name;
      if (WTCPercentLimit !== undefined) pairing.WTCPercentLimit = WTCPercentLimit;
      if (ValveOpenTime !== undefined) pairing.ValveOpenTime = ValveOpenTime;
      if (MeasurementInterval !== undefined) pairing.MeasurementInterval = MeasurementInterval;
      if (calibrationId !== undefined) pairing.calibrationId = calibrationId;
      await pairing.save();
      reply.send(pairing);
    } else {
      reply.code(404).send({ message: 'Pairing not found' });
    }
  } catch (error) {
    console.error(error);
    reply.code(500).send({ message: 'Internal Server Error' });
  }
}

const deletePairing = async (request: FastifyRequest<{ Params: { sensorId: number, valveId: number } }>, reply: FastifyReply) => {
  if (await stopIfSystemStateIsRunning(reply)) return;

  const { sensorId, valveId } = request.params;
  try {
    const pairing = await Pairing.findOne({ where: { sensorId, valveId } });

    if (pairing) {
      await pairing.destroy();
      reply.send({ message: 'Pairing deleted successfully' });
    } else {
      reply.code(404).send({ message: 'Pairing not found' });
    }
  } catch (error) {
    console.error(error);
    reply.code(500).send({ message: 'Internal Server Error' });
  }
}

export const getAllPairingsRoute: IRoute = {
  method: 'GET',
  url: '/pairings',
  handler: getPairings
}

export const getPairingByIdRoute: IRoute = {
  method: 'GET',
  url: '/pairings/:sensorId/:valveId',
  handler: getPairing
}

export const getPairingBySensorIdRoute: IRoute = {
  method: 'GET',
  url: '/pairings/sensor/:sensorId',
  handler: getPairingBySensorId
}

export const createPairingRoute: IRoute = {
  method: 'POST',
  url: '/pairings',
  handler: createPairing
}

export const updatePairingRoute: IRoute = {
  method: 'PUT',
  url: '/pairings/:sensorId/:valveId',
  handler: updatePairing
}

export const deletePairingRoute: IRoute = {
  method: 'DELETE',
  url: '/pairings/:sensorId/:valveId',
  handler: deletePairing
}

// Streaming export functionality
interface ExportPairingRow extends MySQLRowDataPacket {
  sensorId: number
  valveId: number
  calibrationId: number | null
  groupId: number | null
  name: string | null
  WTCPercentLimit: number | null
  ValveOpenTime: number | null
  MeasurementInterval: number | null
  createdAt: Date | string
  updatedAt: Date | string
}

const PAIRINGS_CSV_HEADERS = ['sensorId', 'valveId', 'calibrationId', 'groupId', 'name', 'WTCPercentLimit', 'ValveOpenTime', 'MeasurementInterval', 'createdAt', 'updatedAt']

const exportPairingsStream = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const exportDate = new Date().toISOString().split('T')[0]
    const fileName = `pairings-${exportDate}.csv.gz`

    reply.hijack()
    reply.raw.statusCode = 200
    reply.raw.setHeader('Content-Type', 'application/gzip')
    reply.raw.setHeader('Content-Disposition', `attachment; filename="${fileName}"`)
    reply.raw.setHeader('Cache-Control', 'no-store')

    const gzip = createGzip({ level: 6 })
    gzip.pipe(reply.raw)

    await writeToGzip(gzip, `${PAIRINGS_CSV_HEADERS.join(',')}\n`)

    let lastSensorId = 0
    let lastValveId = 0
    const sql = `SELECT sensorId, valveId, calibrationId, groupId, name, WTCPercentLimit, ValveOpenTime, MeasurementInterval, createdAt, updatedAt FROM pairings WHERE (sensorId > ? OR (sensorId = ? AND valveId > ?)) ORDER BY sensorId ASC, valveId ASC LIMIT ?`

    while (true) {
      const [rows] = await request.server.mysql.query<ExportPairingRow[]>(sql, [lastSensorId, lastSensorId, lastValveId, EXPORT_CHUNK_SIZE])
      if (!rows || rows.length === 0) break

      const csvChunk = rows.map((row) => [
        escapeCsvValue(row.sensorId),
        escapeCsvValue(row.valveId),
        escapeCsvValue(row.calibrationId),
        escapeCsvValue(row.groupId),
        escapeCsvValue(row.name),
        escapeCsvValue(row.WTCPercentLimit),
        escapeCsvValue(row.ValveOpenTime),
        escapeCsvValue(row.MeasurementInterval),
        escapeCsvValue(formatDateInCentralTime(row.createdAt)),
        escapeCsvValue(formatDateInCentralTime(row.updatedAt))
      ].join(',')).join('\n') + '\n'

      await writeToGzip(gzip, csvChunk)
      const lastRow = rows[rows.length - 1]
      lastSensorId = lastRow.sensorId
      lastValveId = lastRow.valveId
    }

    gzip.end()
  } catch (error) {
    console.error('Error exporting pairings:', error)
    if (!reply.raw.headersSent) {
      reply.code(500).send({ message: 'Failed to export pairings' })
      return
    }
    reply.raw.destroy(error as Error)
  }
}

export const exportPairingsStreamRoute: IRoute = {
  method: 'GET',
  url: '/pairings/export-stream',
  handler: exportPairingsStream
}
