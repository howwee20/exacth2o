// Real recorded study plus two explicitly simulated studies. No controller connections.
import { fixture as base, walkerSnapshot, mixer, sampleProfile } from '../applications-preview/fixtures';
import source from './data/binod-source.json';
export { walkerSnapshot, mixer, sampleProfile };
export const demoSource = source;
const now = Date.now(), minute = 60000, day = 86400000, step = 5 * minute;
const channels = Object.keys(source.channels) as (keyof typeof source.channels)[];
const droughtChannels = new Set(['B', 'C', 'G', 'M']);
// Reserve the final source day for genuine replay, at the original 3–4 minute cadence.
// Each reload starts at the same source position. No synthetic rows extend the real study.
export const replayIndex = source.minutes.findLastIndex(t => t <= source.minutes.at(-1)! - 1440);
export const sourceShiftMs = now - source.minutes[replayIndex] * minute - Date.parse(source.dates[0].replace(' ', 'T') + 'Z');
const startFor = (id: string) => id === 'experiment-1' ? now - source.minutes[replayIndex] * minute : now - (id === 'experiment-2' ? 7 : 10) * day;
const sourceAt = (index: number) => startFor('experiment-1') + source.minutes[index] * minute;
const stamp = (at: number) => new Date(at).toISOString();
const sourceIndex = (minutes: number) => {
  let lo = 0, hi = source.minutes.length - 1;
  while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (source.minutes[mid] <= minutes) lo = mid; else hi = mid - 1; }
  return lo;
};
const sourceValue = (channel: keyof typeof source.channels, hours: number) => source.channels[channel].moisture[sourceIndex(hours * 60)];
const sourceResidual = (id: number, elapsedHours: number) => {
  const channel = (['A', 'E', 'H', 'L', 'N', 'O'] as const)[id % 6];
  const series = source.channels[channel].moisture;
  const index = sourceIndex((elapsedHours * 60 + id * 97) % source.minutes.at(-1)!);
  // A bounded short-timescale difference borrows texture, not an entire duplicate trace.
  return Math.max(-.18, Math.min(.18, (series[index] - series[Math.max(0, index - 3)]) * .35));
};
const realAssignments = channels.map((channel, i) => ({
  pairing_name: `Pot ${61 + i}`, pot_number: 61 + i, zone: Math.floor(i / 6) + 1,
  crop: null, treatment: droughtChannels.has(channel) ? 'drought' : 'control',
  target_vwc_percent: null, measurement_interval_minutes: 4, source_channel: channel,
  block: null, substrate: null, notes: `Recorded channel ${channel}; treatment inferred from its moisture trajectory. Crop and target not supplied.`,
}));
const recoveryAssignments = Array.from({ length: 24 }, (_, i) => ({
  pairing_name: `Pot ${i + 1}`, pot_number: i + 1, zone: Math.floor(i / 6) + 1,
  crop: null, treatment: i < 6 ? 'control' : 'drought', target_vwc_percent: 25,
  measurement_interval_minutes: 5, block: null, substrate: null,
  recovery: ['watered control', 'early rewatering', 'delayed rewatering', 'gradual rewatering'][Math.floor(i / 6)],
  notes: `Simulation: ${['watered control', 'early rewatering from hour 108', 'delayed rewatering from hour 144', 'gradual rewatering from hour 126'][Math.floor(i / 6)]}.`,
}));
const cropAssignments = Array.from({ length: 24 }, (_, i) => ({
  pairing_name: `Pot ${101 + i}`, pot_number: 101 + i, zone: Math.floor(i / 8) + 1,
  crop: ['maize', 'soybean', 'sorghum'][Math.floor(i / 8)], treatment: 'control',
  target_vwc_percent: 25, measurement_interval_minutes: 5, block: null, substrate: null,
  notes: 'Illustrative crop water-use scenario, not a measured species response or prediction.',
}));
export const experiments: any[] = [
  { id: 'experiment-1', name: 'Drought response', mode: 'observation', wateringState: 'off',
    shortDescription: 'Recorded data · droughted and well-watered channels · Binod’s July–August 2023 study', assignments: realAssignments },
  { id: 'experiment-2', name: 'Recovery after drought', mode: 'controlled', wateringState: 'controller_managed',
    shortDescription: 'Simulated from recorded patterns · early, delayed and gradual rewatering', assignments: recoveryAssignments },
  { id: 'experiment-3', name: 'Crop comparison', mode: 'controlled', wateringState: 'controller_managed',
    shortDescription: 'Illustrative maize, soybean and sorghum · different water use at a shared 25% target', assignments: cropAssignments },
].map(e => ({ ...e, databaseId: `demo-${e.id}`, currentVersion: 1, currentRevisionId: `revision-${e.id}`,
  status: e.id === 'experiment-1' ? 'published_sensing' : 'active', startedAt: stamp(startFor(e.id)),
  count: e.assignments.length, groupNames: [e.id], pairingNames: e.assignments.map(a => a.pairing_name),
  assignments: e.assignments.map(a => ({ ...a, sensor_key_snapshot: `sample:${a.pot_number}`, valve_key_snapshot: `sample-valve:${a.pot_number}` })),
}));
for (const e of experiments) e.currentSpec = { name: e.name, description: e.shortDescription, mode: e.mode,
  start_date: e.startedAt, visibility_roles: ['admin', 'researcher'], controller_changes_requested: false,
  questions: [], assignments: e.assignments.map((a: any) => ({ ...a, watering_enabled: e.id !== 'experiment-1', valve_open_seconds: e.id === 'experiment-1' ? null : 2 })) };
const assignments = new Map<number, any>(experiments.flatMap(e => e.assignments.map((a: any) => [a.pot_number, a])));
const pairings = experiments.flatMap(e => e.assignments.map((a: any) => ({
  id: a.pot_number, name: a.pairing_name, zone: a.zone, pot_number: a.pot_number, group_name: e.id,
  source_sensor_id: a.pot_number, sensor_key: `sample:${a.pot_number}`,
  source_valve_id: a.pot_number, valve_key: `sample-valve:${a.pot_number}`,
  wtc_percent_limit: e.id === 'experiment-1' ? -999999 : a.target_vwc_percent,
  valve_open_time_ms: e.id === 'experiment-1' ? 0 : 2000,
  measurement_interval_ms: a.measurement_interval_minutes * minute,
  calibration_name: e.id === 'experiment-1' ? null : 'Simulated VWC (no raw calibration)',
})));
const realLastIndex = new Map<number, number>();
const states = new Map<number, any>();
function realReading(p: any, index: number) {
  const channel = assignments.get(p.id).source_channel as keyof typeof source.channels;
  const at = stamp(sourceAt(index));
  return { id: p.id * 10000000 + index, event_id: `live-device:recorded:${channel}:${source.measurementIds[index]}`,
    organization_id: 'sample', project_id: 'sample', device_id: 'sample', pairing_name: p.name, sensor_key: p.sensor_key,
    calibrated_value: source.channels[channel].moisture[index], temperature: source.channels[channel].temperature[index],
    raw_value: null, electrical_conductivity: null, device_recorded_at: at, server_received_at: at,
    source_date: source.dates[index], source_measurement_id: source.measurementIds[index], source_channel: channel, provenance: 'recorded' };
}
function random(s: any) { s.seed = (Math.imul(1664525, s.seed) + 1013904223) >>> 0; return s.seed / 4294967296; }
export function nextDemoSample(p: any, atMs: number) {
  if (p.group_name === 'experiment-1') {
    const index = sourceIndex((atMs - startFor(p.group_name)) / minute);
    if (index <= (realLastIndex.get(p.id) ?? -1)) return null;
    realLastIndex.set(p.id, index);
    return { reading: realReading(p, index), event: null };
  }
  const a = assignments.get(p.id), elapsed = (atMs - startFor(p.group_name)) / 3600000;
  let s = states.get(p.id);
  if (!s) {
    s = { seed: (Math.imul(p.id, 2654435761) + 19371) >>> 0, count: 0, last: atMs, lastWater: -Infinity, pending: 0, noise: 0 };
    s.factor = .84 + random(s) * .32;
    s.phase = random(s) * Math.PI * 2;
    s.level = 25.4 + random(s) * .5;
    s.dryChannel = (['B', 'C', 'G', 'M'] as const)[p.id % 4];
    s.dryInitial = sourceValue(s.dryChannel, 0);
    s.recoveryHour = a.recovery === 'early rewatering' ? 108 : a.recovery === 'delayed rewatering' ? 144 : 126;
    s.recoveryHour += (p.id % 6) * 1.25;
    s.uptake = (p.group_name === 'experiment-3' ? { maize: .16, soybean: .10, sorghum: .055 }[a.crop as 'maize']! : .09) * s.factor;
    states.set(p.id, s);
  }
  const hours = Math.max(0, (atMs - s.last) / 3600000);
  // Relative source clock makes profiles identical across browser/OS timezones.
  const hour = (elapsed + 8) % 24, daylight = Math.max(0, Math.sin((hour - 6) / 12 * Math.PI));
  let enabled = true;
  if (p.group_name === 'experiment-2' && a.treatment === 'drought' && elapsed <= s.recoveryHour) {
    enabled = false;
    // Preserve the shape of a real dry-down, time-compressed and scaled for this hypothetical protocol.
    s.level = 25.6 * sourceValue(s.dryChannel, elapsed * 1.3 * s.factor) / s.dryInitial;
  } else {
    s.level -= s.uptake * (.22 + 1.45 * daylight) * (1 + .10 * Math.sin(elapsed / 16 + s.phase)) * hours;
    const absorbed = s.pending * (1 - Math.exp(-hours / .22));
    s.pending -= absorbed; s.level += absorbed;
  }
  const gradual = p.group_name === 'experiment-2' && a.recovery === 'gradual rewatering' && elapsed < s.recoveryHour + 24;
  const threshold = gradual ? Math.min(25, 10 + Math.max(0, elapsed - s.recoveryHour) * 15 / 24) : 25;
  let event: any = null;
  if (enabled && s.level < threshold && s.pending < .08 && elapsed - s.lastWater > (gradual ? 1.5 : .5)) {
    const recoveryPulse = p.group_name === 'experiment-2' && s.level < 23;
    const gain = recoveryPulse ? Math.min(gradual ? 1.5 : 4.8, threshold + .55 - s.level) : .45 + random(s) * .4;
    s.pending += gain; s.lastWater = elapsed;
    event = { id: p.id * 10000000 + s.count, event_id: `simulated-water:${p.id}:${s.count}`,
      organization_id: 'sample', project_id: 'sample', device_id: 'sample', pairing_name: p.name,
      valve_key: p.valve_key, source_valve_id: p.id, action: 'open', duration_ms: Math.round(1200 + gain * 900),
      device_recorded_at: stamp(atMs), server_received_at: stamp(atMs), provenance: 'simulated' };
  }
  s.noise = s.noise * .8 + (random(s) - .5) * .025;
  const value = Number(Math.max(.45, s.level + s.noise + sourceResidual(p.id, elapsed)).toFixed(3));
  const tempChannel = channels[p.id % channels.length];
  const tempIndex = sourceIndex((elapsed * 60 + p.id * 97) % source.minutes.at(-1)!);
  const reading = { id: p.id * 10000000 + ++s.count, event_id: `live-device:simulated:${p.id}:${s.count}`,
    organization_id: 'sample', project_id: 'sample', device_id: 'sample', pairing_name: p.name, sensor_key: p.sensor_key,
    calibrated_value: value, raw_value: null, electrical_conductivity: null,
    temperature: Number((source.channels[tempChannel].temperature[tempIndex] + .2 * Math.sin(elapsed / 8 + s.phase)).toFixed(1)),
    device_recorded_at: stamp(atMs), server_received_at: stamp(atMs), provenance: 'simulated' };
  s.last = atMs;
  return { reading, event };
}
// No invented stale sensors, gaps, calibration changes or valve events in the recorded study.
export function sampleReadingAvailable(p: any, atMs: number) {
  return p.group_name !== 'experiment-1' || sourceIndex((atMs - startFor(p.group_name)) / minute) > (realLastIndex.get(p.id) ?? -1);
}
const readings: any[] = [], valveEvents: any[] = [];
for (const p of pairings) {
  if (p.group_name === 'experiment-1') {
    for (let index = 0; index <= replayIndex; index++) readings.push(realReading(p, index));
    realLastIndex.set(p.id, replayIndex);
  } else for (let at = startFor(p.group_name); at <= now; at += step) {
    const sample = nextDemoSample(p, at)!; readings.push(sample.reading); if (sample.event) valveEvents.push(sample.event);
  }
}
readings.sort((a, b) => a.device_recorded_at.localeCompare(b.device_recorded_at) || a.id - b.id);
valveEvents.sort((a, b) => a.device_recorded_at.localeCompare(b.device_recorded_at));
const start = startFor('experiment-1');
const runtime = { project_id: 'sample', device_id: 'sample', device_name: 'Research controller', source: 'demo',
  controller_state: 'running', controller_state_raw: 'running', controller_state_updated_at: stamp(start),
  get state_observed_at() { return stamp(Date.now()); }, get state_fresh_until() { return stamp(Date.now() + 120000); },
  get owner_checked_at() { return stamp(Date.now()); }, overall_status: 'operational', api_status: 'OK', pi_online: true,
  public_url_reachable: true, watering_enabled: true, watering_disabled: [], watering_last_event: 'Simulated irrigation pulse',
  get watering_last_event_at() { return valveEvents.at(-1)?.device_recorded_at ?? null; },
  get watering_events_last_24h() { return valveEvents.filter(e => Date.parse(e.device_recorded_at) > Date.now() - day).length; },
  scheduler_jobs_loaded: pairings.length, sensors_expected: pairings.length, sensors_current: pairings.length, sensors_stale: 0, sensors_missing: 0,
  get last_sensor_reading_at() { return readings.at(-1)?.device_recorded_at; }, config_hash: 'demo-binod-58-pots-v1',
  raw_status: { state: 'running', watering_enabled: true }, raw_health: {}, raw_system: {}, get updated_at() { return stamp(Date.now()); } };
const config = { project_id: 'sample', device_id: 'sample', device_name: 'Research controller', source: 'demo',
  get observed_at() { return stamp(Date.now()); }, pairings, calibrations: [],
  board_config: [{ address: '0x20' }, { address: '0x24' }, { address: '0x26' }],
  sensors: pairings.map(p => ({ id: p.id, name: p.name, sensor_key: p.sensor_key })),
  valves: pairings.map(p => ({ id: p.id, name: p.name, valve_key: p.valve_key })), groups: experiments.map(e => ({ name: e.name })),
  pairing_count: pairings.length, calibration_count: 0, board_count: 3, sensor_count: pairings.length, valve_count: pairings.length,
  group_count: 3, config_hash: runtime.config_hash, endpoint_status: {}, raw_config: {}, get updated_at() { return stamp(Date.now()); } };
export const storedReadings = readings;
const recent = readings.filter(r => Date.parse(r.device_recorded_at) >= now - 72 * 3600000).slice(-50000);
export const fixture = { ...base, runtime, config, experiments, valveEvents,
  health: { ...base.health, sensors_expected: pairings.length, sensors_current: pairings.length, sensors_stale: 0, stale_sensors: [],
    scheduler_jobs_loaded: pairings.length, watering_events_last_24h: runtime.watering_events_last_24h,
    watering_last_event: runtime.watering_last_event, watering_last_event_at: runtime.watering_last_event_at },
  data: { ...base.data, pairings, readings: recent, totalImportedReadings: 0, totalLiveReadings: recent.length, latestLiveReading: readings.at(-1) } };
const provenance = `Source: Binod Basyal, ExactH2O_dummy_interface.csv, received 12 October 2026. Original clock: ${source.dates[0]} through ${source.dates.at(-1)} (timezone not supplied). Display dates are shifted uniformly by ${sourceShiftMs} ms from the literal source clock for demo playback; measurement values and intervals are unchanged. Replay starts at source ${source.dates[replayIndex]} and advances through the remaining day at the recorded cadence; it stops when the file ends. Reload restarts the replay. No raw signal, EC, crop, target, calibration or valve records were supplied.`;
const descriptions: Record<string, string> = {
  'experiment-1': `${provenance} Selected channels A, B, C, E, G, H, L, M, N, O. B/C/G/M are inferred drought channels; the others are a stable watered subset. K duplicates E exactly; D/F/I/J/P are omitted from this display subset to focus on tighter watered traces, not because their measurements were proved invalid. No formal precision claim is made.`,
  'experiment-2': 'SIMULATED DEMO, informed by Binod’s recorded dry-down shapes and short-term watered fluctuations. Pots 1–6: watered controls. Pots 7–12: early rewatering from hour 108. Pots 13–18: delayed rewatering from hour 144. Pots 19–24: gradual rewatering from hour 126 over 24 hours. Replicates have staggered starts and different uptake. Valve markers and temperature are simulated; raw signal and EC are unavailable.',
  'experiment-3': 'SIMULATED DEMO, not measured crop results or crop predictions. Pots 101–108: illustrative maize, faster daytime water use. Pots 109–116: illustrative soybean, intermediate water use. Pots 117–124: illustrative sorghum, slower water use. All use the same 25% VWC target, with different drying and irrigation intervals. Texture is informed by Binod’s watered traces; irrigation and temperature are simulated. Raw signal and EC are unavailable.',
};
export const recordTables: Record<string, any[]> = {
  experiment_revisions: experiments.map(e => ({ id: e.currentRevisionId, experiment_id: e.databaseId, version: 1,
    source: e.id === 'experiment-1' ? 'recorded source replay' : 'derived demo simulation', created_at: e.startedAt, created_by: 'demo-account' })),
  project_control_commands: [],
  experiment_assignments: experiments.flatMap(e => e.assignments.map((a: any) => ({ ...a, experiment_id: e.databaseId,
    revision_id: e.currentRevisionId, calibration_name_snapshot: null }))),
  experiment_audit_events: experiments.map(e => ({ id: `audit-${e.id}`, experiment_id: e.databaseId, revision_id: e.currentRevisionId,
    event_type: 'revision_created', details: { summary: e.shortDescription }, created_at: e.startedAt, actor_id: 'demo-account' })),
  portal_pot_notes: experiments.flatMap(e => e.assignments.map((a: any, index: number) => ({ id: `note-${e.id}-${a.pot_number}`, project_id: 'sample', device_id: 'sample',
    pairing_name: a.pairing_name, tags: [e.id === 'experiment-1' ? 'Recorded source' : 'Simulated demo'], recorded_at: stamp(now - minute),
    research_pot_id: null, experiment_id: e.databaseId, supersedes_id: null, client_context: {},
    body: `${a.notes} ${index === 0 ? descriptions[e.id] : e.id === "experiment-1" ? "Unchanged recorded VWC and temperature; dates shifted for playback. Full source details are in the experiment Record on Pot 61." : "Derived demo simulation informed by Binod’s source data; not measured experimental results."}`, observed_at: stamp(now - minute), created_at: stamp(now - minute), updated_at: stamp(now - minute),
    author_label: 'Demo data provenance', created_by: 'demo-account', deleted_at: null }))),
};
