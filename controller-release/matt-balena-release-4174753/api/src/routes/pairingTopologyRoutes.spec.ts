// Route-level checks for the atomic remap and settings endpoints. The models and the
// transaction are in-memory fakes; a thrown error inside the transaction restores the
// snapshot taken when it began, as the database does.

type Row = { sensorId: number; valveId: number; name: string; groupId: number | null; WTCPercentLimit: number; ValveOpenTime: number; MeasurementInterval: number; calibrationId: number | null }

let table: Row[] = []
let failCreateAt: number | null = null
let creates = 0

jest.mock('../database', () => ({
  sequelize: {
    transaction: async (work: (transaction: any) => Promise<unknown>) => {
      const snapshot = table.map((row) => ({ ...row }))
      try {
        return await work({ LOCK: { UPDATE: 'UPDATE' } })
      } catch (error) {
        table = snapshot
        throw error
      }
    },
  },
}))

jest.mock('../models', () => {
  const matches = (row: Row, where: any) => row.sensorId === where.sensorId && row.valveId === where.valveId
  return {
    Pairing: {
      findAll: async () => table.map((row) => ({ ...row })),
      destroy: async ({ where }: any) => { table = table.filter((row) => !matches(row, where)) },
      create: async (values: Row) => {
        creates += 1
        if (failCreateAt != null && creates === failCreateAt) throw new Error('disk full')
        table.push({ ...values })
      },
      update: async (values: Partial<Row>, { where }: any) => { table = table.map((row) => (matches(row, where) ? { ...row, ...values } : row)) },
    },
    System: { findOne: async () => ({ state: 'STOPPED' }) },
    Sensor: {},
    Valve: {},
  }
})
jest.mock('../models/calibration', () => ({ __esModule: true, default: {} }))
jest.mock('../models/system', () => ({ MachineState: { RUNNING: 'RUNNING', STOPPED: 'STOPPED' } }))

import * as routes from './pairings'

const reply = () => {
  const response: any = { statusCode: 200, body: null }
  response.code = (status: number) => { response.statusCode = status; return response }
  response.send = (body: unknown) => { response.body = body; return response }
  return response
}

const leaseCalls: string[] = []
beforeEach(() => {
  table = Array.from({ length: 100 }, (_, index) => ({
    sensorId: index + 1, valveId: 1001 + index, name: `Zone${Math.floor(index / 25) + 1}-Pot${index + 1}`,
    groupId: 1, WTCPercentLimit: -999999, ValveOpenTime: 3000, MeasurementInterval: 60_000, calibrationId: 2,
  }))
  creates = 0
  failCreateAt = null
  leaseCalls.length = 0
  process.env.CRON_URL = 'http://cron.test/v1'
  global.fetch = jest.fn(async (_url: any, init: any) => {
    leaseCalls.push(JSON.parse(init.body).action)
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  }) as any
})

const cycle = () => table.map((row, index) => ({ pairingName: row.name, sensorId: row.sensorId, fromValveId: row.valveId, toValveId: 1001 + ((index + 1) % 100) }))

describe('atomic pairing routes', () => {
  it('applies a 100-pot cycle in one transaction under a topology lease', async () => {
    const response = reply()
    await (routes.remapPairingsRoute.handler as any)({ body: { remapId: 'run-1', changes: cycle() } }, response)
    expect(response.statusCode).toBe(200)
    expect(response.body).toMatchObject({ ok: true, applied: 100 })
    expect(table.find((row) => row.sensorId === 100)?.valveId).toBe(1001)
    expect(table.find((row) => row.sensorId === 1)?.valveId).toBe(1002)
    expect(table).toHaveLength(100)
    expect(leaseCalls).toEqual(['begin', 'end'])
  })

  it('rolls back completely when any write fails midway, leaving the original topology', async () => {
    const before = JSON.stringify(table)
    failCreateAt = 57
    const response = reply()
    await (routes.remapPairingsRoute.handler as any)({ body: { remapId: 'run-2', changes: cycle() } }, response)
    expect(response.statusCode).toBe(500)
    expect(JSON.stringify(table)).toBe(before)
    expect(leaseCalls).toEqual(['begin', 'end'])
  })

  it('refuses when a hold is active (lease refused) without touching the pairings', async () => {
    global.fetch = jest.fn(async () => new Response(JSON.stringify({ message: 'manual watering is in progress' }), { status: 409 })) as any
    const before = JSON.stringify(table)
    const response = reply()
    await (routes.remapPairingsRoute.handler as any)({ body: { remapId: 'run-3', changes: cycle() } }, response)
    expect(response.statusCode).toBe(409)
    expect(response.body.message).toMatch(/manual watering is in progress/)
    expect(JSON.stringify(table)).toBe(before)
  })

  it('restores 100 distinct settings atomically', async () => {
    const pairings = table.map((row, index) => ({ pairingName: row.name, sensorId: row.sensorId, valveId: row.valveId, WTCPercentLimit: 10 + index * 0.5, ValveOpenTime: 1000 + index, MeasurementInterval: 600_000 }))
    const response = reply()
    await (routes.updatePairingSettingsRoute.handler as any)({ body: { pairings } }, response)
    expect(response.statusCode).toBe(200)
    expect(table.map((row) => row.WTCPercentLimit)).toEqual(pairings.map((item) => item.WTCPercentLimit))
    expect(table.every((row) => row.calibrationId === 2 && row.groupId === 1)).toBe(true)
  })
})
