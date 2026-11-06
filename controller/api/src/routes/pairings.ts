import { FastifyReply, FastifyRequest } from 'fastify'
import { IRoute } from '../types/IRoute';
import { Pairing, System, Sensor, Valve } from '../models';
import { MachineState } from '../models/system';
import Calibration from '../models/calibration';
import { MySQLRowDataPacket } from '@fastify/mysql'
import { createGzip } from 'zlib'
import { EXPORT_CHUNK_SIZE, formatDateInCentralTime, escapeCsvValue, writeToGzip } from '../utils/csvExportUtils'
import { sendApiError, withTimeout, fetchWithTimeout, SYSTEM_CRON_TIMEOUT_MS } from '../utils/requestTimeout'
import { sequelize } from '../database'
import { PairingRecord, parseRemapChanges, parseSettingsChanges, planRemap, planSettings } from '../utils/pairingTopology'

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

const topologyRecord = (row: any): PairingRecord => ({
  sensorId: Number(row.sensorId),
  valveId: Number(row.valveId),
  name: row.name ?? null,
  groupId: row.groupId ?? null,
  WTCPercentLimit: row.WTCPercentLimit ?? null,
  ValveOpenTime: row.ValveOpenTime ?? null,
  MeasurementInterval: row.MeasurementInterval ?? null,
  calibrationId: row.calibrationId ?? null,
})

class TopologyConflict extends Error {
  constructor(readonly errors: string[]) {
    super(errors.join('; '))
  }
}

/** Ask cron to refuse new hold-to-water sessions while the topology is rewritten. */
async function topologyLease(action: 'begin' | 'end', id: string) {
  const response = await fetchWithTimeout(`${process.env.CRON_URL}/valves/config-rewrite`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-exacth2o-controller-secret': process.env.EXACTH2O_CONTROLLER_COMMAND_SECRET || '' },
    body: JSON.stringify({ action, id, ttlMs: 120_000 }),
  }, 'topology rewrite lease', SYSTEM_CRON_TIMEOUT_MS)
  if (!response.ok) {
    const body: any = await response.json().catch(() => ({}))
    throw new Error(body?.message || `lease ${action} refused with HTTP ${response.status}`)
  }
}

const pairingReadback = async (sensorIds: number[]) => {
  const rows = await withTimeout(Pairing.findAll({
    include: [
      { model: Sensor, attributes: ['address', 'type', 'boardSerialId'] },
      { model: Valve, attributes: ['address', 'relayAddress'] },
      { model: Calibration, attributes: ['name', 'polynomialCoefficientsCommaDelimited'] },
    ],
  }), 'topology readback')
  const wanted = new Set(sensorIds)
  return rows.filter((row: any) => wanted.has(Number(row.sensorId)))
}

/**
 * Moves many pots to different valves in ONE transaction: every change applies or
 * none does, so a crash or error can never leave a half-applied permutation.
 */
const remapPairings = async (request: FastifyRequest<{ Body: { remapId?: string; changes?: unknown } }>, reply: FastifyReply) => {
  if (await stopIfSystemStateIsRunning(reply)) return
  const parsed = parseRemapChanges(request.body?.changes)
  if (!parsed.ok) return reply.code(400).send({ message: parsed.errors.join('; '), errors: parsed.errors })
  const leaseId = String(request.body?.remapId || '').trim().slice(0, 120) || `remap-${Date.now()}`
  try {
    await topologyLease('begin', leaseId)
  } catch (error: any) {
    return reply.code(409).send({ message: `Topology change refused: ${error?.message || error}` })
  }
  try {
    await sequelize.transaction(async (transaction) => {
      const rows = await Pairing.findAll({ transaction, lock: transaction.LOCK.UPDATE })
      const plan = planRemap(rows.map(topologyRecord), parsed.value)
      if (!plan.ok) throw new TopologyConflict(plan.errors)
      for (const row of plan.value.deletes) {
        await Pairing.destroy({ where: { sensorId: row.sensorId, valveId: row.valveId }, transaction })
      }
      for (const row of plan.value.creates) {
        await Pairing.create({ ...row }, { transaction })
      }
    })
    const pairings = await pairingReadback(parsed.value.map((change) => change.sensorId))
    return reply.send({ ok: true, applied: parsed.value.length, pairings })
  } catch (error: any) {
    if (error instanceof TopologyConflict) return reply.code(409).send({ message: error.message, errors: error.errors })
    console.error('Atomic remap failed and was rolled back', error)
    return reply.code(500).send({ message: 'Remap failed; the transaction was rolled back' })
  } finally {
    await topologyLease('end', leaseId).catch((error) => console.error('Could not end topology lease', error))
  }
}

/** Restores (or sets) per-pot watering settings for many pots in ONE transaction. */
const updatePairingSettings = async (request: FastifyRequest<{ Body: { pairings?: unknown } }>, reply: FastifyReply) => {
  if (await stopIfSystemStateIsRunning(reply)) return
  const parsed = parseSettingsChanges(request.body?.pairings)
  if (!parsed.ok) return reply.code(400).send({ message: parsed.errors.join('; '), errors: parsed.errors })
  try {
    await sequelize.transaction(async (transaction) => {
      const rows = await Pairing.findAll({ transaction, lock: transaction.LOCK.UPDATE })
      const plan = planSettings(rows.map(topologyRecord), parsed.value)
      if (!plan.ok) throw new TopologyConflict(plan.errors)
      for (const change of plan.value) {
        await Pairing.update({
          WTCPercentLimit: change.WTCPercentLimit,
          ValveOpenTime: change.ValveOpenTime,
          MeasurementInterval: change.MeasurementInterval,
        }, { where: { sensorId: change.sensorId, valveId: change.valveId }, transaction })
      }
    })
    const pairings = await pairingReadback(parsed.value.map((change) => change.sensorId))
    return reply.send({ ok: true, applied: parsed.value.length, pairings })
  } catch (error: any) {
    if (error instanceof TopologyConflict) return reply.code(409).send({ message: error.message, errors: error.errors })
    console.error('Bulk settings change failed and was rolled back', error)
    return reply.code(500).send({ message: 'Settings change failed; the transaction was rolled back' })
  }
}

export const remapPairingsRoute: IRoute = {
  method: 'POST',
  url: '/pairings/remap',
  handler: remapPairings
}

export const updatePairingSettingsRoute: IRoute = {
  method: 'POST',
  url: '/pairings/settings',
  handler: updatePairingSettings
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
