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
    expect(html).not.toContain('up;');
    expect(html).not.toContain('4/4 OK');
    expect(html).not.toContain('Stable');
  });
  it('shows current evidence again when the device reports within its freshness window',()=>{
    vi.useFakeTimers();vi.setSystemTime(new Date('2026-11-14T19:43:00Z'));
    const html=render();
    expect(html).toContain('Online.');
    expect(html).toContain('4/4 OK');
    expect(html).toContain('up;');
  });
});
