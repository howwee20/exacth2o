import { useEffect, useRef, useState, type FormEvent } from "react";
import { createWalkerExperiment, loadWalkerSensorOptions, type WalkerSensorOption } from "../walkerExperimentClient";
import type { WalkerPortalExperiment } from "../walkerExperiments";

export function WalkerCreateExperiment({ onClose, onCreated }: { onClose: () => void; onCreated: (experiment: WalkerPortalExperiment) => void }) {
  const [name, setName] = useState("");
  const [sensors, setSensors] = useState<WalkerSensorOption[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requestId] = useState(() => crypto.randomUUID());
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => {
    let active = true;
    void loadWalkerSensorOptions().then(items => {
      if (active) { setSensors(items); setSelected(new Set(items.map(item => item.source_sensor_id))); }
    }).catch(() => { if (active) setError("Could not load Walker sensors. Close and try again."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (saving || loading || !name.trim() || !selected.size) return;
    setSaving(true); setError(null);
    try { onCreated(await createWalkerExperiment(name.trim(), [...selected], requestId)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not create the experiment. Try again."); }
    finally { setSaving(false); }
  };
  return <dialog ref={dialog} className="px-walker-create" aria-labelledby="walker-create-title" onCancel={event => { if (saving) event.preventDefault(); else onClose(); }}>
    <form onSubmit={event => void save(event)}>
      <h2 id="walker-create-title">Create experiment</h2><p>Walker Pi</p>
      <label htmlFor="walker-experiment-name">Experiment name</label>
      <input autoFocus id="walker-experiment-name" value={name} maxLength={120} required disabled={saving} onChange={event => setName(event.target.value)} />
      <div className="px-walker-sensor-heading"><strong>Sensors · {selected.size}</strong>
        <button type="button" disabled={saving || loading} onClick={() => setSelected(selected.size === sensors.length ? new Set() : new Set(sensors.map(sensor => sensor.source_sensor_id)))}>{selected.size === sensors.length ? "Clear" : "Select all"}</button>
      </div>
      {loading ? <p role="status">Loading sensors…</p> : <div className="px-walker-sensor-grid">{sensors.map(sensor => <label key={sensor.source_sensor_id}>
        <input type="checkbox" disabled={saving} checked={selected.has(sensor.source_sensor_id)} onChange={() => setSelected(current => { const next = new Set(current); if (next.has(sensor.source_sensor_id)) next.delete(sensor.source_sensor_id); else next.add(sensor.source_sensor_id); return next; })} />
        {sensor.display_label}
      </label>)}</div>}
      <p className="px-walker-create-note">Records selected sensors from now. Sensor and watering settings stay unchanged.</p>
      {error ? <p className="px-walker-create-error" role="alert">{error}</p> : null}
      <div className="px-walker-create-actions"><button type="button" className="px-button" disabled={saving} onClick={onClose}>Cancel</button>
        <button type="submit" className="px-button is-primary" disabled={saving || loading || !name.trim() || !selected.size}>{saving ? "Creating…" : "Create experiment"}</button></div>
    </form>
  </dialog>;
}
