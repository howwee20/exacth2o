import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SystemHealthView } from './SystemHealthView';
import type { DeviceHealthSnapshot, DeviceRuntimeState } from '../portalTypes';

const at = '2026-11-14T19:42:00Z';
const snapshot = {
  id:'sample',captured_at:at,created_at:at,pi_online:true,api_status:'ok',uptime_seconds:3000,
  cpu_temp_c:37,undervoltage:false,ethernet_link:false,
  sensors_expected:4,sensors_current:4,sensors_stale:0,sensors_missing:0,last_sensor_reading_at:at,
  raw_status:{},raw_health:{},raw_history:null,
} as DeviceHealthSnapshot;
const runtime = {
  device_id:'testbed',state_observed_at:at,state_fresh_until:'2026-11-14T19:44:30Z',
  pi_online:true,api_status:'OK',sensors_current:4,sensors_expected:4,sensors_stale:0,sensors_missing:0,
  raw_health:{},raw_status:{},
} as DeviceRuntimeState;
function render() {
  return renderToStaticMarkup(<SystemHealthView snapshot={snapshot} history={[snapshot]}
    runtimeState={runtime} error={null} onBackHome={()=>{}} />);
}
afterEach(()=>vi.useRealTimers());
describe('health observation freshness',()=>{
  it('labels expired readings as recorded data, never current health',()=>{
    vi.useFakeTimers();vi.setSystemTime(new Date('2026-11-14T20:15:00Z'));
    const html=render();
    expect(html).toContain('Offline.');
    expect(html).toContain('at last report');
    expect(html).toContain('Last uptime');
    expect(html).not.toContain('Up ');
    expect(html).not.toContain('All reporting');
    expect(html).not.toContain('Stable');
  });
  it('shows current evidence again when the device reports within its freshness window',()=>{
    vi.useFakeTimers();vi.setSystemTime(new Date('2026-11-14T19:43:00Z'));
    const html=render();
    expect(html).toContain('Online.');
    expect(html).toContain('All reporting');
    expect(html).toContain('<strong>Up 51 m</strong>');
  });
});

it('uses the complete pairing report for group and node counts and keeps old summary history scoped', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(at));
  const row = (name: string, groupName: string, sensor: string, time: string | null) => ({
    actualName: name, groupName, actualSensor: sensor, MeasurementInterval: 600_000,
    latestReading: time && { createdAt: time },
  });
  const rows = [
    row('Pan 65', 'Pan', 'D30GQN2E:a', at),
    row('Pan 66', 'Pan', 'D30GQN2E:b', at),
    row('Pot 41', 'Matt', 'D30GQN2D:c', null),
    row('Pot 42', 'Matt', 'D30GQN2D:d', '2026-11-14T17:00:00Z'),
  ];
  const rawHealth = { piLocal: { available: true, ethernet: { speed: 1000, duplex: 'full' } },
    ownerStatus: { throttled_flags: { available: false } },
    api: { pairings: { ok: true, count: 4 }, pairingReadings: { ok: true, rows }, researcherMap: {} } };
  const renderReport = () => renderToStaticMarkup(<SystemHealthView snapshot={snapshot} history={[snapshot]}
    runtimeState={{ ...runtime, raw_health: rawHealth }} error={null} onBackHome={() => {}} />);
  let html = renderReport();
  expect(html).toContain('<strong>2 / 4</strong>');
  expect(html).toContain('2 not reporting');
  expect(html).toContain('1000 Mbps · full duplex');
  expect(html).not.toContain('Unavailable on controller');
  rawHealth.api.pairings.count = 5;
  html = renderReport();
  expect(html).toContain('<span>Sensors</span><strong>Not synced</strong>');
  expect(html).not.toContain('All reporting');
});

it('shows only the temperature graph and marks a restart on it', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-14T19:43:00Z'));
  const sample = (time: string, uptimeSeconds: number) => ({ t: time, uptimeSeconds, ethUp: true, cpuTempC: 40 });
  const records = [sample('2026-11-14T19:00:00Z', 9000), sample('2026-11-14T19:10:00Z', 9600),
    sample('2026-11-14T19:30:00Z', 300), sample('2026-11-14T19:40:00Z', 900)];
  const html = renderToStaticMarkup(<SystemHealthView snapshot={{ ...snapshot, raw_history: { records } } as DeviceHealthSnapshot}
    history={[snapshot]} runtimeState={runtime} error={null} onBackHome={() => {}} />);
  expect(html.match(/class="sh-chart /g)).toHaveLength(1);
  expect(html).toContain('aria-label="Temperature over time"');
  expect(html).not.toContain('aria-label="Network over time"');
  expect(html.match(/class="sh-chart-mark"/g)).toHaveLength(1);
  expect(html).toContain('Restart ');
  expect(html).not.toContain('Sensors not reporting');
});
