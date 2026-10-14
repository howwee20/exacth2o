import { useState } from 'react';
import type { PortalExperiment } from '../experimentRegistry';
import type { TimeBounds, TimeWindow } from '../portalTypes';
import { captureTraceRange, readTraceViews, restoreTraceView, type TraceView } from './traceViewStorage';

export function SavedTraceViews({ scope, experiment, names, visible, bounds, window, onApply }: {
  scope: string; experiment: PortalExperiment; names: string[]; visible: string[];
  bounds: TimeBounds | null; window: TimeWindow; onApply: (names: string[], window: TimeWindow) => void;
}) {
  const key = `exacth2o.traceViews.v1:${scope}`;
  const [saved, setSaved] = useState<TraceView[]>(() => { try { return readTraceViews(localStorage.getItem(key)); } catch { return []; } });
  const [selected, setSelected] = useState('');
  const [name, setName] = useState('');
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState('');
  const treatments = new Set(experiment.assignments?.map(a => a.treatment));
  const presets: TraceView[] = [
    ...(treatments.has('control') && treatments.has('drought') ? [{ id: 'preset-control', name: 'Control vs drought', pairingNames: experiment.assignments!.filter(a => a.treatment === 'control' || a.treatment === 'drought').map(a => a.pairing_name), range: null }] : []),
    ...(experiment.comparisonPresets ?? []).map((p, i) => ({ ...p, id: `preset-${i}`, range: null })),
  ];
  const selectedView = [...presets, ...saved].find(v => v.id === selected);
  const restoredSelection = selectedView ? restoreTraceView(selectedView, names, bounds) : null;
  const selectionMatches = Boolean(restoredSelection?.names && restoredSelection.window && restoredSelection.names.length === visible.length && restoredSelection.names.every(n => visible.includes(n)) && Math.abs(restoredSelection.window.start - window.start) < .001 && Math.abs(restoredSelection.window.end - window.end) < .001);
  function persist(next: TraceView[]) {
    try { localStorage.setItem(key, JSON.stringify(next)); setSaved(next); return true; }
    catch { setNotice('This browser could not save the view.'); return false; }
  }
  return <div className="px-saved-views">
    <div className="px-saved-view-row">
      <select aria-label="Comparison view" value={selectionMatches ? selected : ''} onChange={event => {
        const id = event.target.value; const view = [...presets, ...saved].find(v => v.id === id);
        setSelected(id); setNotice(''); if (!view) return;
        const restored = restoreTraceView(view, names, bounds);
        if (restored.error || !restored.names || !restored.window) { setNotice(restored.error ?? 'View unavailable.'); return; }
        onApply(restored.names, restored.window); setNotice(restored.warning ?? '');
      }}>
        <option value="">Comparison views</option>
        {presets.length ? <optgroup label="Suggested">{presets.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}</optgroup> : null}
        {saved.length ? <optgroup label="Saved on this browser">{saved.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}</optgroup> : null}
      </select>
      <button className="px-button is-small" type="button" disabled={!visible.length || !bounds} onClick={() => { setEditing(!editing); setNotice(''); }}>Save view</button>
    </div>
    {editing ? <form className="px-save-view-form" onSubmit={event => {
      event.preventDefault(); if (!name.trim() || !visible.length) return;
      const existing = saved.find(v => v.name.toLowerCase() === name.trim().toLowerCase());
      if (!existing && saved.length >= 12) { setNotice('Remove a saved view before adding another.'); return; }
      const replay = document.documentElement.dataset.portalMode === 'demo';
      const view = { id: existing?.id ?? `saved-${Date.now()}`, name: name.trim(), pairingNames: visible, range: replay ? null : captureTraceRange(bounds, window), ...(replay ? { replayWindow: window } : {}) };
      if (persist([...saved.filter(v => v.id !== view.id), view])) { setSelected(view.id); setName(''); setEditing(false); setNotice('Saved on this browser.'); }
    }}>
      <input aria-label="View name" placeholder="View name" maxLength={60} required value={name} onChange={e => setName(e.target.value)} autoFocus />
      <button className="px-button is-small" type="submit">Save</button>
      <button className="px-button is-small" type="button" onClick={() => setEditing(false)}>Cancel</button>
    </form> : null}
    {saved.some(v => v.id === selected) ? <button className="px-remove-view" type="button" onClick={() => { if (persist(saved.filter(v => v.id !== selected))) { setSelected(''); setNotice('View removed.'); } }}>Remove saved view</button> : null}
    {notice ? <p className="px-muted" role="status">{notice}</p> : null}
  </div>;
}
