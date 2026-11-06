import { PairingRecord, parseRemapChanges, parseSettingsChanges, planRemap, planSettings } from './pairingTopology'

// 100 pots: sensor i on valve 1000 + i, named Zone<z>-Pot<i>.
const installation = (count = 100): PairingRecord[] => Array.from({ length: count }, (_, index) => ({
  sensorId: index + 1,
  valveId: 1001 + index,
  name: `Zone${Math.floor(index / 25) + 1}-Pot${index + 1}`,
  groupId: (index % 4) + 1,
  WTCPercentLimit: 20 + (index % 30),
  ValveOpenTime: 2000 + index * 10,
  MeasurementInterval: 60_000,
  calibrationId: index % 3 === 0 ? 7 : null,
}))

describe('atomic topology planning', () => {
  it('plans a full 100-pot permutation cycle, carrying every other setting unchanged', () => {
    const existing = installation()
    // Pot i receives the valve of pot i+1 (pot 100 receives pot 1's): one 100-element cycle.
    const changes = existing.map((pairing, index) => ({
      pairingName: pairing.name!, sensorId: pairing.sensorId, fromValveId: pairing.valveId, toValveId: existing[(index + 1) % 100].valveId,
    }))
    const plan = planRemap(existing, changes)
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.value.deletes).toHaveLength(100)
    expect(plan.value.creates).toHaveLength(100)
    const created = new Map(plan.value.creates.map((row) => [row.sensorId, row]))
    for (const [index, pairing] of existing.entries()) {
      const row = created.get(pairing.sensorId)!
      expect(row.valveId).toBe(existing[(index + 1) % 100].valveId)
      expect({ ...row, valveId: pairing.valveId }).toEqual(pairing)
    }
    expect(new Set(plan.value.creates.map((row) => row.valveId)).size).toBe(100)
  })

  it('accepts a cross-zone swap of two pots', () => {
    const existing = installation()
    const plan = planRemap(existing, [
      { pairingName: 'Zone1-Pot3', sensorId: 3, fromValveId: 1003, toValveId: 1097 },
      { pairingName: 'Zone4-Pot97', sensorId: 97, fromValveId: 1097, toValveId: 1003 },
    ])
    expect(plan.ok).toBe(true)
  })

  it('refuses a change set that is not closed, so no valve is orphaned or doubled', () => {
    const existing = installation()
    const open = planRemap(existing, [{ pairingName: 'Zone1-Pot3', sensorId: 3, fromValveId: 1003, toValveId: 1004 }])
    expect(open.ok).toBe(false)
    if (open.ok) return
    expect(open.errors.join(' ')).toMatch(/1004 is received but no pot in this change gives it up/)
    expect(open.errors.join(' ')).toMatch(/1003 would be left without a pot/)
  })

  it('rejects stale plans when the configuration changed since review', () => {
    const existing = installation()
    existing[2] = { ...existing[2], valveId: 1500 }
    const plan = planRemap(existing, [
      { pairingName: 'Zone1-Pot3', sensorId: 3, fromValveId: 1003, toValveId: 1004 },
      { pairingName: 'Zone1-Pot4', sensorId: 4, fromValveId: 1004, toValveId: 1003 },
    ])
    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.errors[0]).toMatch(/no longer on sensor 3 \/ valve 1003/)
  })

  it('refuses a valve that a pot outside the change also uses', () => {
    const existing = [...installation(), { ...installation()[9], sensorId: 500, name: 'Zone9-Pot500' }]
    const plan = planRemap(existing, [
      { pairingName: 'Zone1-Pot3', sensorId: 3, fromValveId: 1003, toValveId: 1010 },
      { pairingName: 'Zone1-Pot10', sensorId: 10, fromValveId: 1010, toValveId: 1003 },
    ])
    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.errors.join(' ')).toMatch(/1010 is also used by Zone9-Pot500/)
  })

  it('validates request shape and the 200-change bound', () => {
    expect(parseRemapChanges([]).ok).toBe(false)
    expect(parseRemapChanges(Array.from({ length: 201 }, () => ({ pairingName: 'x', sensorId: 1, fromValveId: 1, toValveId: 2 }))).ok).toBe(false)
    expect(parseRemapChanges([{ pairingName: 'Zone1-Pot1', sensorId: 1, fromValveId: 5, toValveId: 5 }]).ok).toBe(false)
    expect(parseRemapChanges([{ pairingName: 'Huiqiao-Zone3-Pot68', sensorId: 1, fromValveId: 5, toValveId: 6 }]).ok).toBe(true)
  })

  it('restores 100 different original settings in one plan, and refuses unknown pairings', () => {
    const existing = installation()
    const raw = existing.map((pairing, index) => ({
      pairingName: pairing.name, sensorId: pairing.sensorId, valveId: pairing.valveId,
      WTCPercentLimit: index % 10 === 0 ? -999999 : 15 + index * 0.25, ValveOpenTime: 1000 + index * 37, MeasurementInterval: 30_000 + index * 1000,
    }))
    const parsed = parseSettingsChanges(raw)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const plan = planSettings(existing, parsed.value)
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(new Set(plan.value.map((change) => `${change.WTCPercentLimit}/${change.ValveOpenTime}/${change.MeasurementInterval}`)).size).toBe(100)
    const stale = planSettings(existing.slice(1), parsed.value)
    expect(stale.ok).toBe(false)
    expect(parseSettingsChanges([{ ...raw[1], WTCPercentLimit: 140 }]).ok).toBe(false)
    expect(parseSettingsChanges([{ ...raw[1], MeasurementInterval: 10 }]).ok).toBe(false)
  })
})
