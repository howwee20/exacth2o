// Pure planning for atomic pairing topology changes. The route handlers run these
// plans inside one database transaction, so a valve permutation of any size (up to
// every pot on the controller) is applied completely or not at all.
//
// A pairing's identity on this controller is (sensorId, valveId). Moving a pot to a
// different valve therefore deletes and recreates the row, carrying every other
// setting (name, group, target, pulse length, interval, calibration) unchanged.

export const MAX_TOPOLOGY_CHANGES = 200

export type PairingRecord = {
  sensorId: number
  valveId: number
  name: string | null
  groupId: number | null
  WTCPercentLimit: number | null
  ValveOpenTime: number | null
  MeasurementInterval: number | null
  calibrationId: number | null
}

export type RemapChange = {
  pairingName: string
  sensorId: number
  fromValveId: number
  toValveId: number
}

export type SettingsChange = {
  pairingName: string
  sensorId: number
  valveId: number
  WTCPercentLimit: number
  ValveOpenTime: number
  MeasurementInterval: number
}

type Plan<T> = { ok: true; value: T } | { ok: false; errors: string[] }

const key = (sensorId: number, valveId: number) => `${sensorId}/${valveId}`
const sameName = (a: string | null, b: string) => String(a ?? '').trim().toLowerCase() === b.trim().toLowerCase()

function integer(value: unknown) {
  return typeof value === 'number' && Number.isInteger(value) ? value : null
}

export function parseRemapChanges(raw: unknown): Plan<RemapChange[]> {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, errors: ['At least one valve change is required'] }
  if (raw.length > MAX_TOPOLOGY_CHANGES) return { ok: false, errors: [`At most ${MAX_TOPOLOGY_CHANGES} valve changes are allowed in one remap`] }
  const changes: RemapChange[] = []
  const errors: string[] = []
  raw.forEach((item: any, index) => {
    const pairingName = typeof item?.pairingName === 'string' ? item.pairingName.trim() : ''
    const sensorId = integer(item?.sensorId)
    const fromValveId = integer(item?.fromValveId)
    const toValveId = integer(item?.toValveId)
    if (!pairingName || sensorId == null || fromValveId == null || toValveId == null) {
      errors.push(`Change ${index + 1} needs a pairing name, sensor id, and both valve ids`)
      return
    }
    if (fromValveId === toValveId) errors.push(`${pairingName} already uses valve ${toValveId}`)
    changes.push({ pairingName, sensorId, fromValveId, toValveId })
  })
  return errors.length ? { ok: false, errors } : { ok: true, value: changes }
}

/**
 * Validates a valve permutation against the controller's current pairings. The set of
 * valves given away must equal the set received, so every pot in the change keeps
 * exactly one valve and no valve ends up shared with a pot outside the change.
 */
export function planRemap(existing: readonly PairingRecord[], changes: readonly RemapChange[]): Plan<{ deletes: PairingRecord[]; creates: PairingRecord[] }> {
  const errors: string[] = []
  const duplicates = (values: Array<string | number>) => values.filter((value, index) => values.indexOf(value) !== index)
  const names = duplicates(changes.map((change) => change.pairingName.toLowerCase()))
  if (names.length) errors.push(`Pairings appear more than once: ${Array.from(new Set(names)).join(', ')}`)
  const sensors = duplicates(changes.map((change) => change.sensorId))
  if (sensors.length) errors.push(`Sensors appear more than once: ${Array.from(new Set(sensors)).join(', ')}`)
  const given = duplicates(changes.map((change) => change.fromValveId))
  if (given.length) errors.push(`Valves are given away twice: ${Array.from(new Set(given)).join(', ')}`)
  const received = duplicates(changes.map((change) => change.toValveId))
  if (received.length) errors.push(`Valves are received twice: ${Array.from(new Set(received)).join(', ')}`)

  const from = new Set(changes.map((change) => change.fromValveId))
  const to = new Set(changes.map((change) => change.toValveId))
  for (const valve of to) if (!from.has(valve)) errors.push(`Valve ${valve} is received but no pot in this change gives it up`)
  for (const valve of from) if (!to.has(valve)) errors.push(`Valve ${valve} would be left without a pot; include the pot that receives it`)

  const byKey = new Map(existing.map((pairing) => [key(pairing.sensorId, pairing.valveId), pairing]))
  const deletes: PairingRecord[] = []
  const changing = new Set<string>()
  for (const change of changes) {
    const current = byKey.get(key(change.sensorId, change.fromValveId))
    if (!current) {
      errors.push(`${change.pairingName} is no longer on sensor ${change.sensorId} / valve ${change.fromValveId}; the configuration changed`)
      continue
    }
    if (!sameName(current.name, change.pairingName)) {
      errors.push(`Sensor ${change.sensorId} / valve ${change.fromValveId} is named ${current.name ?? 'unnamed'}, not ${change.pairingName}`)
      continue
    }
    deletes.push(current)
    changing.add(key(current.sensorId, current.valveId))
  }

  const outside = existing.filter((pairing) => !changing.has(key(pairing.sensorId, pairing.valveId)))
  for (const change of changes) {
    const sharing = outside.find((pairing) => pairing.valveId === change.toValveId)
    if (sharing) errors.push(`Valve ${change.toValveId} is also used by ${sharing.name ?? `sensor ${sharing.sensorId}`}, which is not part of this change`)
    const collision = outside.find((pairing) => pairing.sensorId === change.sensorId && pairing.valveId === change.toValveId)
    if (collision) errors.push(`A pairing for sensor ${change.sensorId} on valve ${change.toValveId} already exists`)
  }
  if (errors.length) return { ok: false, errors }

  const creates = changes.map((change) => {
    const current = deletes.find((pairing) => pairing.sensorId === change.sensorId)!
    return { ...current, valveId: change.toValveId }
  })
  return { ok: true, value: { deletes, creates } }
}

export function parseSettingsChanges(raw: unknown): Plan<SettingsChange[]> {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, errors: ['At least one pairing is required'] }
  if (raw.length > MAX_TOPOLOGY_CHANGES) return { ok: false, errors: [`At most ${MAX_TOPOLOGY_CHANGES} pairings are allowed in one settings change`] }
  const errors: string[] = []
  const changes: SettingsChange[] = []
  raw.forEach((item: any, index) => {
    const pairingName = typeof item?.pairingName === 'string' ? item.pairingName.trim() : ''
    const sensorId = integer(item?.sensorId)
    const valveId = integer(item?.valveId)
    const target = typeof item?.WTCPercentLimit === 'number' && Number.isFinite(item.WTCPercentLimit) ? item.WTCPercentLimit : null
    const openTime = integer(item?.ValveOpenTime)
    const interval = integer(item?.MeasurementInterval)
    if (!pairingName || sensorId == null || valveId == null || target == null || openTime == null || interval == null) {
      errors.push(`Pairing ${index + 1} needs its name, ids, target, pulse length and interval`)
      return
    }
    // -999999 is the controller's "watering disabled" target; otherwise 0-100.
    if (!(target === -999999 || (target >= 0 && target <= 100))) errors.push(`${pairingName}: target ${target} is not a valid percent`)
    if (openTime < 0 || openTime > 120_000) errors.push(`${pairingName}: pulse length must be 0-120000 ms`)
    if (interval < 30_000 || interval > 3_600_000) errors.push(`${pairingName}: interval must be 30000-3600000 ms`)
    changes.push({ pairingName, sensorId, valveId, WTCPercentLimit: target, ValveOpenTime: openTime, MeasurementInterval: interval })
  })
  const names = changes.map((change) => change.pairingName.toLowerCase())
  if (new Set(names).size !== names.length) errors.push('Each pairing may appear once')
  return errors.length ? { ok: false, errors } : { ok: true, value: changes }
}

export function planSettings(existing: readonly PairingRecord[], changes: readonly SettingsChange[]): Plan<SettingsChange[]> {
  const byKey = new Map(existing.map((pairing) => [key(pairing.sensorId, pairing.valveId), pairing]))
  const errors: string[] = []
  for (const change of changes) {
    const current = byKey.get(key(change.sensorId, change.valveId))
    if (!current) errors.push(`${change.pairingName} is no longer on sensor ${change.sensorId} / valve ${change.valveId}; the configuration changed`)
    else if (!sameName(current.name, change.pairingName)) errors.push(`Sensor ${change.sensorId} / valve ${change.valveId} is named ${current.name ?? 'unnamed'}, not ${change.pairingName}`)
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: [...changes] }
}
