// Offline UI test: no account, network calls or physical controller.
import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { DirectExperiment } from '../src/product/DirectExperiment';
import { TimeRangeControl } from '../src/charts/TimeRangeControl';
import type { PairingRow } from '../src/types';
import type { PortalExperiment } from '../src/experimentRegistry';
import { useExperimentReadings } from '../src/useExperimentReadings';
import '../src/styles.css';
import '../src/product/product.css';

const pairings: PairingRow[] = [65, 66].map((n, i) => ({ id: n, name: `Pot${n}`, pot_number: n, zone: 3, source_sensor_id: n, source_valve_id: n, sensor_key: `sensor:${n}`, valve_key: `valve:${n}`, wtc_percent_limit: i ? 30 : 10, measurement_interval_ms: 600000, valve_open_time_ms: 2000 }));
const experiment: PortalExperiment = { id: 'trial', name: 'Trial', shortDescription: '', mode: 'controlled', status: 'active', groupNames: [], pairingNames: pairings.map(p => p.name), assignments: pairings.map(p => ({ pairing_name: p.name, pot_number: p.pot_number, zone: 3, crop: 'Maize', treatment: p.pot_number === 65 ? 'Drought' : 'Control', target_vwc_percent: p.wtc_percent_limit })) };
function Harness() {
  const [range, setRange] = useState({ start: 0, end: 100 });
  const [end, setEnd] = useState(Date.parse('2026-10-26T12:00:00Z'));
  return <main className="px-shell" style={{ padding: 20 }}><DirectExperiment experiment={experiment} pairings={pairings} projectId="offline" inventoryUpdatedAt={null} canEdit={false} demo onRefresh={async () => {}}>{state => <>
    <div style={{ position: 'relative', height: 400, width: '100%' }}>{state.targetLayer?.({ left: 20, right: 300, top: 10, bottom: 380, low: 0, high: 80, pixelsPerPercent: 4, yScale: value => 360 - value * 4 })}</div>
    <output aria-label="Applied targets">{state.lines.map(line => line.label).join(', ')}</output>
  </>}</DirectExperiment><TimeRangeControl bounds={{ startMs: Date.parse('2026-01-01T00:00:00Z'), endMs: end }} value={range} onChange={setRange} /><button onClick={() => setEnd(value => value + 86400000)}>Next reading</button></main>;
}
function HistoryHarness() {
  const result = useExperimentReadings(experiment, 'test-project', 'test-device', true);
  return <main>{result.loading ? <p role="status">Loading</p> : result.error ? <p role="alert">{result.error}</p> : <output aria-label="Reading count">{result.readings.length}</output>}<button onClick={result.retry}>Retry</button></main>;
}
createRoot(document.getElementById('root')!).render(new URLSearchParams(location.search).has('history') ? <HistoryHarness /> : <Harness />);
