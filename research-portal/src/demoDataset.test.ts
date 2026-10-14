import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { ModuleKind, transpileModule } from 'typescript';
import { describe, expect, it } from 'vitest';

const root = new URL('../../demo-preview/', import.meta.url);
const csv = readFileSync(new URL('data/ExactH2O_dummy_interface.csv', root), 'utf8');
const [header, ...lines] = csv.trim().split(/\r?\n/).map(line => line.split(','));
const source = JSON.parse(readFileSync(new URL('data/binod-source.json', root), 'utf8'));
const now = Date.UTC(2026, 9, 13, 12);
class FixtureDate extends Date { static now() { return now; } }
const code = transpileModule(readFileSync(new URL('fixtures.ts', root), 'utf8'), {
  compilerOptions: { module: ModuleKind.CommonJS, esModuleInterop: true },
}).outputText;
const data: any = {};
runInNewContext(code, {
  exports: data, Date: FixtureDate, Map, Set, Math,
  require: (name: string) => {
    if (name.endsWith('binod-source.json')) return source;
    if (name === '../applications-preview/fixtures') return { fixture: { data: {}, health: {} } };
    throw new Error(`Unexpected data dependency ${name}`);
  },
});
const pairs = data.fixture.data.pairings;
const rows = data.storedReadings;
const ofPot = (name: string) => rows.filter((row: any) => row.pairing_name === name);
const atHour = (name: string, hour: number) => {
  const values = ofPot(name);
  return values[Math.round(hour * 12)].calibrated_value;
};

describe('recorded and derived demo datasets', () => {
  it('keeps source details at experiment level without repeated pot notes', () => {
    expect(data.recordTables.portal_pot_notes).toEqual([]);
    expect(data.experiments[0].sourceNote).toContain('measurement values and intervals are unchanged');
    expect(data.experiments[1].sourceNote).toContain('simulated');
    expect(data.experiments[2].sourceNote).toContain('not measured crop results');
    expect(data.recordTables.experiment_audit_events[0].details.summary).toContain('Binod');
  });

  it('losslessly packages every selected source measurement and retains source clocks/IDs', () => {
    expect(source.sha256).toBe(createHash('sha256').update(csv).digest('hex'));
    expect(lines).toHaveLength(12753);
    expect(source.dates).toEqual(lines.map(row => row[0]));
    expect(source.measurementIds).toEqual(lines.map(row => Number(row[1])));
    for (const channel of Object.keys(source.channels)) {
      expect(source.channels[channel].moisture).toEqual(lines.map(row => Number(row[header.indexOf(`${channel}_vwc`)])));
      expect(source.channels[channel].temperature).toEqual(lines.map(row => Number(row[header.indexOf(`${channel}_temp`)])));
    }
    expect(Object.keys(source.channels)).toEqual(['A', 'B', 'C', 'E', 'G', 'H', 'L', 'M', 'N', 'O']);
    expect(lines.every(row => row[header.indexOf('E_vwc')] === row[header.indexOf('K_vwc')])).toBe(true);
  });

  it('serves exact recorded values with one constant date offset and no fabricated fields or events', () => {
    const real = rows.filter((row: any) => row.provenance === 'recorded');
    expect(real).toHaveLength((data.replayIndex + 1) * 10);
    expect(real.length).toBeGreaterThan(50000);
    for (const p of pairs.filter((p: any) => p.group_name === 'experiment-1')) {
      const values = ofPot(p.name), channel = values[0].source_channel;
      expect(values.map((row: any) => row.calibrated_value)).toEqual(source.channels[channel].moisture.slice(0, data.replayIndex + 1));
      expect(values.map((row: any) => row.temperature)).toEqual(source.channels[channel].temperature.slice(0, data.replayIndex + 1));
      expect(values.every((row: any) => row.raw_value === null && row.electrical_conductivity === null)).toBe(true);
      for (const index of [0, 147, data.replayIndex]) {
        expect(Date.parse(values[index].device_recorded_at) - Date.parse(source.dates[index].replace(' ', 'T') + 'Z')).toBe(data.sourceShiftMs);
      }
      expect(data.fixture.valveEvents.some((e: any) => e.pairing_name === p.name)).toBe(false);
    }
    expect(data.recordTables.project_control_commands).toEqual([]);
  });

  it('replays actual next rows at source cadence and stops at source exhaustion without synthesizing', () => {
    const p = pairs.find((p: any) => p.group_name === 'experiment-1');
    expect(data.nextDemoSample(p, now + 30000)).toBeNull();
    const index = data.replayIndex + 1;
    const nextTime = now + (source.minutes[index] - source.minutes[data.replayIndex]) * 60000;
    const next = data.nextDemoSample(p, nextTime);
    expect(next.reading.source_measurement_id).toBe(source.measurementIds[index]);
    expect(next.reading.calibrated_value).toBe(source.channels.A.moisture[index]);
    expect(next.event).toBeNull();
    expect(data.nextDemoSample(p, nextTime + 1000)).toBeNull();
    const last = data.nextDemoSample(p, now + 3 * 86400000);
    expect(last.reading.calibrated_value).toBe(source.channels.A.moisture.at(-1));
    expect(Date.parse(last.reading.device_recorded_at)).toBeLessThan(now + 2 * 86400000);
    expect(data.nextDemoSample(p, now + 4 * 86400000)).toBeNull();
  });

  it('gives early, delayed and gradual recovery genuinely different trajectories in the recent window', () => {
    // Controls stay watered; early pots recover while delayed pots are still dry.
    expect(atHour('Pot 1', 120)).toBeGreaterThan(24);
    expect(atHour('Pot 7', 120)).toBeGreaterThan(24);
    expect(atHour('Pot 13', 120)).toBeLessThan(15);
    expect(atHour('Pot 19', 138)).toBeGreaterThan(14);
    expect(atHour('Pot 19', 138)).toBeLessThan(23);
    for (const name of ['Pot 7', 'Pot 13', 'Pot 19']) expect(ofPot(name).at(-1).calibrated_value).toBeGreaterThan(24);
    for (const p of pairs.filter((p: any) => p.group_name === 'experiment-2' && p.id > 6)) {
      const firstEvent = data.fixture.valveEvents.find((e: any) => e.pairing_name === p.name);
      const hours = (Date.parse(firstEvent.device_recorded_at) - (now - 7 * 86400000)) / 3600000;
      const threshold = p.id <= 12 ? 108 : p.id <= 18 ? 144 : 126;
      expect(hours).toBeGreaterThanOrEqual(threshold);
    }
  });

  it('produces three crop irrigation frequencies at the same target without duplicate pot traces', () => {
    const counts = [101, 109, 117].map(first => data.fixture.valveEvents.filter((event: any) => {
      const id = Number(event.pairing_name.replace('Pot ', ''));
      return id >= first && id < first + 8 && Date.parse(event.device_recorded_at) > now - 3 * 86400000;
    }).length);
    expect(counts[0]).toBeGreaterThan(counts[1] * 1.25);
    expect(counts[1]).toBeGreaterThan(counts[2] * 1.25);
    const hashes = pairs.map((p: any) => createHash('sha256').update(JSON.stringify(ofPot(p.name).map((row: any) => row.calibrated_value))).digest('hex'));
    expect(new Set(hashes).size).toBe(58);
    expect(new Set(rows.map((row: any) => row.id)).size).toBe(rows.length);
    expect(rows.every((row: any) => Number.isFinite(row.calibrated_value) && row.calibrated_value >= 0 && row.calibrated_value <= 100)).toBe(true);
    expect(data.fixture.health.sensors_stale).toBe(0);
  });
});
