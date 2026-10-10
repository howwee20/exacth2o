import { useMemo, useState } from "react";
import type { BenchLayoutVersion, PotBinding } from "../benchClient";
import { boardGroups, draftFromSchematic, layoutProblems, recordedLayout, schematicLayout, type BenchLayoutDocument, type BenchModel } from "../benchLayout";
import { defaultGrouping, experimentFactors, groupPattern, potGroups, potRangeText, type PotGroup } from "../experimentFactors";
import { experimentIsCompleted } from "../experimentMeasurement";
import type { PortalExperiment } from "../experimentRegistry";
import { silentExperimentPots } from "../homeExceptions";
import { formatMeasurementTime } from "../measurementFreshness";
import { navigatePortal } from "../portalRoute";
import type { PairingRow, SensorReading } from "../types";
import { PortalLink } from "./PortalLink";
import "./product.css";

function Glyph({ group, size = 14 }: { group: PotGroup | null; size?: number }) {
  if (!group) return <svg width={size} height={size} aria-hidden="true"><circle cx={size / 2} cy={size / 2} r={size / 2 - 2} fill="none" stroke="#77857c" strokeDasharray="2 2" /></svg>;
  const { color, marker } = group.pattern;
  const h = size / 2;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      {marker === "circle" ? <circle cx={h} cy={h} r={h - 1.5} fill={color} /> : null}
      {marker === "square" ? <rect x={1.5} y={1.5} width={size - 3} height={size - 3} fill={color} /> : null}
      {marker === "triangle" ? <path d={`M${h} 1 L${size - 1} ${size - 1.5} L1 ${size - 1.5} Z`} fill={color} /> : null}
      {marker === "diamond" ? <path d={`M${h} 0.5 L${size - 0.5} ${h} L${h} ${size - 0.5} L0.5 ${h} Z`} fill={color} /> : null}
      {marker === "ring" ? <circle cx={h} cy={h} r={h - 2.5} fill="none" stroke={color} strokeWidth={2.5} /> : null}
      {marker === "bar" ? <rect x={h - 2} y={1} width={4} height={size - 2} fill={color} /> : null}
    </svg>
  );
}

function latestByPot(readings: readonly SensorReading[]) {
  const map = new Map<string, number>();
  for (const reading of readings) {
    const at = Date.parse(reading.device_recorded_at);
    if (Number.isFinite(at) && at > (map.get(reading.pairing_name) ?? -Infinity)) map.set(reading.pairing_name, at);
  }
  return map;
}

/** Admin editor for a new recorded layout version: benches, then where each pot stands. */
function LayoutRecorder({
  pairings,
  start,
  onSave,
  onClose,
}: {
  pairings: readonly PairingRow[];
  start: BenchLayoutDocument;
  onSave: (document: BenchLayoutDocument, note: string | null) => Promise<void>;
  onClose: () => void;
}) {
  const [document, setDocument] = useState<BenchLayoutDocument>(start);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const problems = layoutProblems(document);
  const ordered = pairings.slice().sort((a, b) => a.zone - b.zone || a.pot_number - b.pot_number);
  const setBench = (index: number, patch: Partial<BenchLayoutDocument["benches"][number]>) =>
    setDocument((current) => ({ ...current, benches: current.benches.map((bench, i) => (i === index ? { ...bench, ...patch } : bench)) }));
  const setPosition = (pairingName: string, patch: Partial<BenchLayoutDocument["positions"][number]> | null) =>
    setDocument((current) => {
      const others = current.positions.filter((position) => position.pairing_name !== pairingName);
      if (patch === null) return { ...current, positions: others };
      const existing = current.positions.find((position) => position.pairing_name === pairingName) ?? { pairing_name: pairingName, bench: current.benches[0]?.id ?? "B1", row: 1, column: 1 };
      return { ...current, positions: [...others, { ...existing, ...patch }] };
    });
  return (
    <section className="px-card px-recorder" aria-label="Record bench layout">
      <div className="px-toolbar">
        <h2 className="px-section-label">Record where the pots stand</h2>
        <span className="px-spacer" />
        <button type="button" className="px-button is-small is-quiet" onClick={onClose}>Close</button>
      </div>
      <p className="px-muted px-small">This records a new layout version. Earlier versions stay in the record. A recorded layout is what a person noted on the bench; it does not change any pairing, sensor or valve and is not a physical verification.</p>
      <table className="px-table">
        <thead><tr><th>Bench id</th><th>Label</th><th>Rows</th><th>Columns</th><th /></tr></thead>
        <tbody>
          {document.benches.map((bench, index) => (
            <tr key={index}>
              <td><input value={bench.id} maxLength={40} onChange={(event) => setBench(index, { id: event.target.value })} aria-label={`Bench ${index + 1} id`} /></td>
              <td><input value={bench.label} maxLength={80} onChange={(event) => setBench(index, { label: event.target.value })} aria-label={`Bench ${index + 1} label`} /></td>
              <td><input type="number" min={1} max={100} value={bench.rows} onChange={(event) => setBench(index, { rows: Number(event.target.value) })} aria-label={`Bench ${index + 1} rows`} /></td>
              <td><input type="number" min={1} max={100} value={bench.columns} onChange={(event) => setBench(index, { columns: Number(event.target.value) })} aria-label={`Bench ${index + 1} columns`} /></td>
              <td><button type="button" className="px-button is-small is-quiet" disabled={document.benches.length < 2} onClick={() => setDocument((current) => ({ benches: current.benches.filter((_, i) => i !== index), positions: current.positions.filter((position) => position.bench !== bench.id) }))}>Remove</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <button type="button" className="px-button is-small" onClick={() => setDocument((current) => ({ ...current, benches: [...current.benches, { id: `B${current.benches.length + 1}`, label: `Bench ${current.benches.length + 1}`, rows: 3, columns: 8 }] }))}>Add bench</button>
      <div className="px-table-wrap" style={{ maxHeight: 360, overflowY: "auto" }}>
        <table className="px-table">
          <thead><tr><th>Pot</th><th>Bench</th><th>Row</th><th>Column</th><th /></tr></thead>
          <tbody>
            {ordered.map((pairing) => {
              const position = document.positions.find((item) => item.pairing_name === pairing.name);
              return (
                <tr key={pairing.name}>
                  <td className="px-num">{pairing.pot_number} <span className="px-muted">{pairing.name}</span></td>
                  <td>
                    <select value={position?.bench ?? ""} onChange={(event) => setPosition(pairing.name, event.target.value ? { bench: event.target.value } : null)} aria-label={`Bench for pot ${pairing.pot_number}`}>
                      <option value="">Not placed</option>
                      {document.benches.map((bench) => <option key={bench.id} value={bench.id}>{bench.label || bench.id}</option>)}
                    </select>
                  </td>
                  <td><input type="number" min={1} value={position?.row ?? ""} disabled={!position} onChange={(event) => setPosition(pairing.name, { row: Number(event.target.value) })} aria-label={`Row for pot ${pairing.pot_number}`} /></td>
                  <td><input type="number" min={1} value={position?.column ?? ""} disabled={!position} onChange={(event) => setPosition(pairing.name, { column: Number(event.target.value) })} aria-label={`Column for pot ${pairing.pot_number}`} /></td>
                  <td />
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <label className="px-select" style={{ display: "grid", gap: 4 }}>
        What changed (optional)
        <input value={note} maxLength={500} onChange={(event) => setNote(event.target.value)} placeholder="e.g. Bench C rotated end-to-end on Oct 8" />
      </label>
      {problems.length ? <ul className="px-notice" style={{ display: "block" }}>{problems.slice(0, 6).map((problem) => <li key={problem}>{problem}</li>)}</ul> : null}
      {error ? <p className="px-notice is-bad" role="alert">{error}</p> : null}
      <div className="px-note-actions">
        <button type="button" className="px-button is-primary" disabled={saving || problems.length > 0} onClick={async () => {
          setSaving(true);
          setError(null);
          try {
            await onSave(document, note.trim() || null);
          } catch (nextError) {
            setError(nextError instanceof Error ? nextError.message : "The layout could not be recorded.");
          } finally {
            setSaving(false);
          }
        }}>{saving ? "Recording…" : "Record this layout"}</button>
      </div>
    </section>
  );
}

/** Installation layout: every pot where it stands (or numbered, when no layout is recorded). */
export function BenchView({
  pairings,
  experiments,
  readings,
  bindings,
  layout,
  layoutVersions,
  layoutError,
  nowMs,
  asOfMs,
  canRecord,
  onRecord,
}: {
  pairings: readonly PairingRow[];
  experiments: readonly PortalExperiment[];
  readings: readonly SensorReading[];
  bindings: readonly PotBinding[];
  layout: BenchLayoutVersion | null;
  layoutVersions: number;
  layoutError: string | null;
  nowMs: number;
  asOfMs: number | null;
  canRecord: boolean;
  onRecord: (document: BenchLayoutDocument, note: string | null) => Promise<void>;
}) {
  const [filter, setFilter] = useState<string>("all");
  const [showBoards, setShowBoards] = useState(false);
  const [onlySilent, setOnlySilent] = useState(false);
  const [lookup, setLookup] = useState("");
  const [recording, setRecording] = useState(false);
  const model: BenchModel = useMemo(() => (layout ? recordedLayout(layout.layout, pairings) : schematicLayout(pairings)), [layout, pairings]);
  const running = experiments.filter((experiment) => !experimentIsCompleted(experiment, nowMs));
  const experimentByPot = useMemo(() => {
    const map = new Map<string, PortalExperiment>();
    for (const experiment of running) for (const name of experiment.pairingNames) if (!map.has(name)) map.set(name, experiment);
    return map;
  }, [running]);
  const selected = filter === "all" ? null : running.find((experiment) => experiment.id === filter) ?? null;
  // With every experiment shown, a glyph identifies the experiment; with one selected, its
  // treatment groups. Either way shape carries the meaning, not colour alone.
  const glyphGroups: PotGroup[] = useMemo(() => {
    if (selected) return potGroups(selected, defaultGrouping(experimentFactors(selected)));
    return running.map((experiment, index) => ({
      id: experiment.id,
      label: experiment.name,
      levels: {},
      pairingNames: [...experiment.pairingNames],
      potNumbers: [],
      plannedTargets: [],
      pattern: groupPattern(index),
    }));
  }, [running, selected]);
  const groupByPot = useMemo(() => {
    const map = new Map<string, PotGroup>();
    for (const group of glyphGroups) for (const name of group.pairingNames) if (!map.has(name)) map.set(name, group);
    return map;
  }, [glyphGroups]);
  const latest = useMemo(() => latestByPot(readings), [readings]);
  const silentNames = useMemo(() => {
    const names = new Set<string>();
    if (asOfMs == null) return names;
    for (const experiment of running) for (const pot of silentExperimentPots(experiment, pairings, latest, asOfMs)) names.add(pot.name);
    return names;
  }, [asOfMs, latest, pairings, running]);
  const boards = useMemo(() => boardGroups(pairings), [pairings]);
  const silentBoards = boards
    .map((board) => ({ ...board, silent: board.pairings.filter((pairing) => silentNames.has(pairing.name)) }))
    .filter((board) => board.silent.length);
  const confirmed = bindings.filter((binding) => binding.physicalStatus !== "software_only").length;
  const highlighted = new Set(selected ? selected.pairingNames : []);
  const lookupNumber = /^\d+$/.test(lookup.trim()) ? Number(lookup.trim()) : null;
  const lookupMatch = lookupNumber != null ? pairings.find((pairing) => pairing.pot_number === lookupNumber) ?? null : null;
  const legendGroups = glyphGroups;

  return (
    <section className="px-page is-wide" aria-label="Bench">
      <div className="px-exp-head">
        <h1 className="px-title">Bench</h1>
        {model.basis === "recorded" || confirmed ? <p className="px-subtitle">
          {model.basis === "recorded" && layout ? (
            <span>Recorded layout, version {layout.version}{layoutVersions > 1 ? ` of ${layoutVersions}` : ""} · {layout.author_label} · {formatMeasurementTime(layout.created_at)}{layout.note ? ` · “${layout.note}”` : ""}</span>
          ) : null}
          {confirmed ? <span>{confirmed} of {bindings.length} pots physically confirmed</span> : null}
        </p> : null}
      </div>
      {layoutError ? <p className="px-notice" role="status">The recorded layout could not be loaded ({layoutError}); showing the schematic layout.</p> : null}

      <div className="px-toolbar">
        <form className="px-select" onSubmit={(event) => {
          event.preventDefault();
          if (lookupMatch) navigatePortal({ view: "bench", pot: lookupMatch.name });
        }}>
          <label htmlFor="bench-lookup">Find pot</label>
          <input id="bench-lookup" inputMode="numeric" value={lookup} onChange={(event) => setLookup(event.target.value)} placeholder="17" style={{ width: 80 }} />
          <button type="submit" className="px-button is-small" disabled={!lookupMatch}>Open</button>
          {lookup.trim() && !lookupMatch ? <span className="px-muted">No pot {lookup.trim()} on this controller</span> : null}
        </form>
        <label className="px-select">
          Experiment
          <select value={filter} onChange={(event) => setFilter(event.target.value)}>
            <option value="all">All running experiments</option>
            {running.map((experiment) => <option key={experiment.id} value={experiment.id}>{experiment.name}</option>)}
          </select>
        </label>
        <label className="px-select"><input type="checkbox" checked={showBoards} onChange={(event) => setShowBoards(event.target.checked)} /> Show sensor boards</label>
        <label className="px-select"><input type="checkbox" checked={onlySilent} disabled={!silentNames.size && !onlySilent} onChange={(event) => setOnlySilent(event.target.checked)} /> Only pots without readings</label>
        <span className="px-spacer" />
        {canRecord ? <button type="button" className="px-button is-small" onClick={() => setRecording((value) => !value)}>{recording ? "Close recorder" : "Record layout…"}</button> : null}
      </div>

      {silentBoards.map((board) => (
        <p key={board.board} className="px-notice" role="status">
          <span className="px-notice-mark" aria-hidden="true">!</span>
          <span>
            {potRangeText(board.silent.map((pairing) => pairing.pot_number))} on sensor board {board.board} {board.silent.length === 1 ? "has" : "have"} no current reading.{" "}
            <button type="button" className="px-link-button" onClick={() => { setOnlySilent(true); setShowBoards(true); }}>Show on bench</button>
          </span>
        </p>
      ))}

      {recording && canRecord ? (
        <LayoutRecorder
          pairings={pairings}
          start={layout?.layout ?? draftFromSchematic(pairings)}
          onClose={() => setRecording(false)}
          onSave={async (document, note) => {
            await onRecord(document, note);
            setRecording(false);
          }}
        />
      ) : null}

      <div className="px-benches">
        {model.benches.map((bench) => {
          const benchBoards = showBoards ? Array.from(new Set(bench.cells.map((cell) => cell.sensorBoard ?? "?"))) : [];
          return (
            <article key={bench.id} className="px-bench" aria-label={bench.label}>
              <h2 className="px-section-label">{bench.label}</h2>
              <div className="px-bench-grid" style={{ gridTemplateColumns: `repeat(${bench.columns}, minmax(44px, 66px))` }}>
                {bench.cells.map((cell) => {
                  const experiment = experimentByPot.get(cell.pairingName) ?? null;
                  const group = groupByPot.get(cell.pairingName) ?? null;
                  const silent = silentNames.has(cell.pairingName);
                  const dim = (selected && !highlighted.has(cell.pairingName)) || (onlySilent && !silent);
                  const isLookup = lookupMatch?.name === cell.pairingName;
                  return (
                    <PortalLink
                      key={cell.pairingName}
                      to={{ view: "bench", pot: cell.pairingName }}
                      className={`px-bench-cell ${silent ? "is-silent" : ""} ${dim ? "is-dim" : ""} ${isLookup ? "is-match" : ""}`}
                      style={{ gridRow: cell.row, gridColumn: cell.column }}
                      aria-label={`Pot ${cell.potNumber}${experiment ? `, ${experiment.name}` : ", no visible running experiment"}${group && group.label !== "All pots" ? `, ${group.label}` : ""}${silent ? ", no current reading" : ""}`}
                    >
                      <Glyph group={experiment ? group : null} />
                      <b>{cell.potNumber}</b>
                      {silent ? <span className="px-bench-x" aria-hidden="true">×</span> : null}
                      {showBoards ? <span className="px-bench-board">{cell.sensorBoard ?? "?"}</span> : null}
                    </PortalLink>
                  );
                })}
              </div>
              {showBoards && benchBoards.length ? <p className="px-muted px-small">Sensor boards on this bench: {benchBoards.join(", ")}</p> : null}
            </article>
          );
        })}
      </div>

      {model.unplaced.length ? (
        <p className="px-notice is-info">{model.unplaced.length} {model.unplaced.length === 1 ? "pot is" : "pots are"} on the controller but not in the recorded layout: {potRangeText(model.unplaced.map((name) => pairings.find((pairing) => pairing.name === name)?.pot_number ?? 0).filter(Boolean))}.</p>
      ) : null}

      <div className="px-legend" aria-label="How pots are drawn">
        {legendGroups.map((group) => (
          <span key={`${group.label}-${group.pattern.marker}-${group.pattern.color}`} className="px-legend-item"><Glyph group={group} /> {group.label}</span>
        ))}
        <span className="px-legend-item"><Glyph group={null} /> no visible running experiment</span>
        <span className="px-legend-item"><span className="px-bench-cell is-silent px-swatch-cell" aria-hidden="true" /> no current reading</span>
        {selected ? <span className="px-legend-item">Shapes are {selected.name}'s treatment groups; other pots are dimmed.</span> : <span className="px-legend-item">Shapes mark each pot's running experiment; choose one to see its treatment groups.</span>}
      </div>
    </section>
  );
}
