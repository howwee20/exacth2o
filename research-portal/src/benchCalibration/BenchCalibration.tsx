import { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import type { DeviceConfigState, QueueSettingsPlan } from "../portalTypes";
import type { PairingRow } from "../types";
import type { CommandProgress } from "../commandLifecycle";
import { functionErrorMessage } from "../portalFormat";
import { supabase } from "../supabase";
import {
  analyze,
  controllerLibrary,
  emptyWorksheet,
  equation,
  isWorksheet,
  sameCurve,
  sameStoredCurve,
  sampleMean,
  type Cell,
  type FitMode,
  type Worksheet,
} from "./model";
import { CurvePlot } from "./CurvePlot";
import "./bench.css";

type Curve = { id: string; name: string; coefficients: number[]; worksheet: Worksheet };
type Probe = { key: string; id: number; label: string; pot?: number };
const FIT_MODES: [FitMode, string][] = [["linear", "Linear"], ["cubic", "Cubic"], ["manual", "Manual"]];
const POWERS = ["Constant", "x", "x²", "x³", "x⁴", "x⁵"];

// A reading taken today shows its time. An older logged one shows its date as well.
function stamp(cell: Cell) {
  const taken = new Date(cell.capturedAt ?? "");
  const today = taken.toDateString() === new Date().toDateString();
  const when = taken.toLocaleString([], today ? { hour: "numeric", minute: "2-digit" } : { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  return `${cell.source === "direct" ? "Read" : "Logged"} ${when}`;
}
type Props = {
  choice: string;
  choose: (name: string) => void;
  projectId: string;
  deviceId: string;
  experimentName: string;
  pairings: PairingRow[];
  targets: string[];
  config: DeviceConfigState | null;
  admin: boolean;
  controllerState: string | null;
  queue: QueueSettingsPlan;
  commandBusy: boolean;
  commandError: string | null;
  progress: CommandProgress | null;
};

function worksheetIdentity(sheet: Worksheet) {
  return JSON.stringify([
    sheet.mode, sheet.manual, sheet.probes,
    sheet.rows.map(row => [row.id, row.vwc, Object.keys(row.cells).sort().map(key => {
      const cell = row.cells[key];
      return [key, cell.value, cell.source, cell.capturedAt];
    })]),
  ]);
}

function probeOptions(config: DeviceConfigState | null, pairings: PairingRow[]) {
  const options = new Map<string, Probe>();
  for (const item of config?.sensors ?? []) {
    if (!item || typeof item !== "object") continue;
    const s = item as Record<string, unknown>;
    if (typeof s.boardSerialId !== "string" || s.address == null || !Number.isInteger(s.id)) continue;
    const key = s.boardSerialId + ":" + s.address;
    options.set(key, { key, id: Number(s.id), label: key });
  }
  for (const p of pairings) {
    if (p.sensor_key && p.source_sensor_id > 0)
      options.set(p.sensor_key, {
        key: p.sensor_key,
        id: p.source_sensor_id,
        label: `Pot ${p.pot_number} · ${p.sensor_key}`,
        pot: p.pot_number,
      });
  }
  // Probes in pots come first, in pot order.
  return [...options.values()].sort(
    (a, b) =>
      Number(a.pot == null) - Number(b.pot == null) || a.label.localeCompare(b.label, undefined, { numeric: true }),
  );
}

export function BenchCalibration({
  choice,
  choose,
  projectId,
  deviceId,
  experimentName,
  pairings,
  targets,
  config,
  admin,
  controllerState,
  queue,
  commandBusy,
  commandError,
  progress,
}: Props) {
  const [sheet, setSheet] = useState<Worksheet>(emptyWorksheet);
  const [name, setName] = useState("");
  const [curves, setCurves] = useState<Curve[]>([]);
  const [canRead, setCanRead] = useState(false);
  const [working, setWorking] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [review, setReview] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [libraryReady, setLibraryReady] = useState(false);
  const busyRef = useRef(false);
  const mounted = useRef(true);
  const inventory = useMemo(() => probeOptions(config, pairings), [config, pairings]);
  const installed = useMemo(() => controllerLibrary(config?.calibrations ?? []), [config]);
  const fit = useMemo(() => analyze(sheet), [sheet]);
  const saved = curves.find((curve) => curve.name === choice);
  const chosenCoefficients = saved?.coefficients ?? installed.get(choice);
  const names = [...new Set([...curves.map((curve) => curve.name), ...installed.keys()])].sort();
  const hash = config?.config_hash ?? "";
  const installedName = [...installed.keys()].find((n) => n.toLowerCase() === choice.toLowerCase());
  const deviceCurve = installedName ? installed.get(installedName) : undefined;
  const conflict = Boolean(deviceCurve && chosenCoefficients && !sameCurve(deviceCurve, chosenCoefficients));
  const signature = JSON.stringify([choice, chosenCoefficients, targets, hash, controllerState]);
  const reviewOpen = review === signature;
  const creating = !choice;
  const probeByKey = useMemo(() => new Map(inventory.map((p) => [p.key, p])), [inventory]);
  const savedFit = useMemo(() => (saved ? analyze(saved.worksheet) : null), [saved]);
  const savedRows = saved?.worksheet.rows.filter((r) => Object.values(r.cells).some((c) => c.value.trim())) ?? [];

  useEffect(() => {
    mounted.current = true;
    let current = true;
    async function load() {
      const result = await supabase
        .from("soil_bench_calibrations")
        .select("id,name,coefficients,worksheet")
        .eq("project_id", projectId)
        .eq("device_id", deviceId)
        .order("created_at", { ascending: false });
      if (!current) return;
      if (result.error) setError(result.error.message);
      else {
        const readable = result.data.filter(
          (row) =>
            isWorksheet(row.worksheet) &&
            Array.isArray(row.coefficients) &&
            row.coefficients.every(Number.isFinite),
        );
        setCurves(readable as Curve[]);
        if (readable.length !== result.data.length) setError("Some saved worksheets could not be read.");
        setLibraryReady(true);
      }
    }
    void load();
    void supabase.functions
      .invoke("bench-sensor-read", { body: { projectId, deviceId, capabilities: true } })
      .then(({ data }) => {
        if (current) setCanRead(data?.singleProbe === true);
      });
    return () => {
      current = false;
      mounted.current = false;
    };
  }, [projectId, deviceId]);

  function setCell(rowId: string, key: string, cell: Cell) {
    setSheet((prev) => ({
      ...prev,
      rows: prev.rows.map((r) => (r.id === rowId ? { ...r, cells: { ...r.cells, [key]: cell } } : r)),
    }));
  }

  async function run(label: string, action: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setWorking(label);
    setError("");
    setMessage("");
    try {
      await action();
    } catch (err) {
      if (mounted.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      busyRef.current = false;
      if (mounted.current) setWorking("");
    }
  }

  async function capture(rowId: string, key: string) {
    const probe = inventory.find((p) => p.key === key);
    if (!probe) throw new Error("Refresh the probe inventory.");
    if (canRead) {
      const { data, error } = await supabase.functions.invoke("bench-sensor-read", {
        body: { projectId, deviceId, sensorId: probe.id, sensorKey: key },
      });
      if (error) throw new Error(await functionErrorMessage(error));
      if (data?.sensorKey !== key || !Number.isFinite(data?.rawValue)) throw new Error("No raw reading received.");
      if (mounted.current)
        setCell(rowId, key, { value: String(data.rawValue), source: "direct", capturedAt: data.capturedAt });
    } else {
      const { data, error } = await supabase
        .from("sensor_readings")
        .select("raw_value,device_recorded_at")
        .eq("project_id", projectId)
        .eq("device_id", deviceId)
        .eq("sensor_key", key)
        .not("raw_value", "is", null)
        .order("device_recorded_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error || !data || !Number.isFinite(data.raw_value))
        throw new Error(error?.message ?? "No logged raw reading for this probe.");
      if (mounted.current)
        setCell(rowId, key, {
          value: String(data.raw_value),
          capturedAt: data.device_recorded_at,
          source: "logged",
        });
    }
  }

  async function save() {
    const curveName = (name || experimentName).trim();
    if (!curveName || !fit.coefficients.length) throw new Error("Name the calibration and complete its equation.");
    if (names.some((n) => n.toLowerCase() === curveName.toLowerCase()))
      throw new Error("That calibration name already exists. Choose a new name.");
    const result = await supabase
      .from("soil_bench_calibrations")
      .insert({
        project_id: projectId,
        device_id: deviceId,
        name: curveName,
        coefficients: fit.coefficients,
        worksheet: sheet,
      })
      .select("id,name,coefficients,worksheet")
      .single();
    let stored = result.data as Curve | null;
    if (result.error?.code === "23505") {
      const existing = await supabase
        .from("soil_bench_calibrations")
        .select("id,name,coefficients,worksheet")
        .eq("project_id", projectId)
        .eq("device_id", deviceId)
        .eq("name", curveName)
        .maybeSingle();
      const row = existing.data as Curve | null;
      if (
        !row ||
        !sameStoredCurve(row.coefficients, fit.coefficients) ||
        !isWorksheet(row.worksheet) ||
        worksheetIdentity(row.worksheet) !== worksheetIdentity(sheet)
      ) {
        throw new Error("That calibration name is already saved. Choose a new name.");
      }
      stored = row;
    } else if (result.error) throw new Error(result.error.message);
    if (!stored) throw new Error("Could not confirm the saved calibration.");
    const confirmed = stored;
    if (mounted.current) {
      setCurves((prev) => [confirmed, ...prev.filter((c) => c.id !== confirmed.id)]);
      choose(curveName);
      setMessage(`Saved “${curveName}” to the calibration library.`);
    }
  }

  async function apply() {
    if (!reviewOpen || !chosenCoefficients || !admin || !targets.length || conflict || !hash) return;
    setReview("");
    setSubmitted(true);
    const create = !deviceCurve;
    const result = await queue(
      {
        summary: `Apply soil calibration “${choice}” to ${targets.join(", ")}`,
        commands: [
          ...(create
            ? [
                {
                  command_type: "create_calibration" as const,
                  payload: { name: choice, mode: "manual", function_text: chosenCoefficients.join(",") },
                  effect: `Install “${choice}”`,
                },
              ]
            : []),
          {
            command_type: "apply_calibration",
            payload: { calibration_name: choice, pairing_names: targets },
            effect: `Assign to ${targets.join(", ")}`,
          },
        ],
        questions: [],
      },
      hash,
    );
    if (result && mounted.current)
      setMessage("Calibration assignment queued. Follow the controller status below.");
  }

  const assignNote = !admin
    ? "Administrator access is required to assign a calibration."
    : conflict
      ? "The controller has a different equation under this name. Save the worksheet with a new name."
      : !targets.length
        ? "Select pots below to assign this curve."
        : !controllerState
          ? "Waiting for current controller status."
          : `Assign to the ${targets.length} pot${targets.length === 1 ? "" : "s"} selected below.`;

  return (
    <section className="xb-section bench-calibration" aria-label="Soil calibration worksheet">
      <div className="xb-heading">
        <h3>Soil calibration</h3>
        {creating && <span>Read every probe in the same reference sample.</span>}
        {names.length > 0 && (
          <div className="xb-heading-tools">
            <label className="bench-curve">
              Curve
              <select
                aria-label="Curve to assign"
                value={choice}
                onChange={(e) => {
                  choose(e.target.value);
                  setReview("");
                  setSubmitted(false);
                  setMessage("");
                }}
              >
                <option value="">New curve</option>
                {names.map((n) => (
                  <option key={n}>{n}</option>
                ))}
              </select>
            </label>
          </div>
        )}
      </div>
      {creating ? (
        <fieldset disabled={Boolean(working)} className="bench-fields">
          <div className="bench-grid">
            <div className="bench-card">
              <header className="bench-card-head">
                <h4>Reference samples</h4>
                <select
                  className="bench-add"
                  aria-label="Add calibration probe"
                  value=""
                  onChange={(e) => {
                    const key = e.target.value;
                    if (key) setSheet((prev) => ({ ...prev, probes: [...prev.probes, key] }));
                  }}
                >
                  <option value="">Add probe</option>
                  {inventory
                    .filter((p) => !sheet.probes.includes(p.key))
                    .map((p) => (
                      <option value={p.key} key={p.key}>
                        {p.label}
                      </option>
                    ))}
                </select>
              </header>
              <div className="bench-scroll">
                <table className="bench-table">
                  <thead>
                    <tr>
                      <th>VWC %</th>
                      {sheet.probes.map((key) => {
                        const pot = probeByKey.get(key)?.pot;
                        return (
                          <th key={key}>
                            <span className="bench-probe">
                              <span>
                                {pot ? `Pot ${pot}` : key}
                                {pot ? <small>{key}</small> : null}
                              </span>
                              <button
                                type="button"
                                className="bench-x"
                                aria-label={`Remove probe ${key}`}
                                onClick={() =>
                                  setSheet((prev) => ({ ...prev, probes: prev.probes.filter((p) => p !== key) }))
                                }
                              >
                                <X size={14} aria-hidden="true" />
                              </button>
                            </span>
                          </th>
                        );
                      })}
                      {sheet.probes.length ? <th className="is-number">Average</th> : <th>Raw reading</th>}
                      <th aria-hidden="true" />
                    </tr>
                  </thead>
                  <tbody>
                    {sheet.rows.map((row, i) => (
                      <tr key={row.id}>
                        <td>
                          <input
                            className="bench-vwc"
                            type="number"
                            min="0"
                            max="100"
                            step="any"
                            aria-label={`Reference VWC row ${i + 1}`}
                            value={row.vwc}
                            onChange={(e) =>
                              setSheet((prev) => ({
                                ...prev,
                                rows: prev.rows.map((r) => (r.id === row.id ? { ...r, vwc: e.target.value } : r)),
                              }))
                            }
                          />
                        </td>
                        {sheet.probes.map((key) => {
                          const cell = row.cells[key];
                          const reading = working === row.id + key;
                          return (
                            <td key={key}>
                              <div className="bench-cell">
                                <input
                                  type="number"
                                  step="any"
                                  aria-label={`${key} raw row ${i + 1}`}
                                  value={cell?.value ?? ""}
                                  onChange={(e) => setCell(row.id, key, { value: e.target.value })}
                                />
                                <button
                                  type="button"
                                  aria-label={canRead ? "Read now" : "Use latest logged"}
                                  onClick={() => void run(row.id + key, () => capture(row.id, key))}
                                >
                                  {reading ? "Reading…" : canRead ? "Read" : "Latest"}
                                </button>
                              </div>
                              {cell?.capturedAt && (
                                <small title={new Date(cell.capturedAt).toLocaleString()}>{stamp(cell)}</small>
                              )}
                            </td>
                          );
                        })}
                        {sheet.probes.length ? (
                          <td className="is-number">
                            {sampleMean(row, sheet.probes)?.toLocaleString(undefined, { maximumFractionDigits: 1 }) ??
                              "—"}
                          </td>
                        ) : (
                          <td className="bench-muted">{i === 0 ? "Add a probe to start" : ""}</td>
                        )}
                        <td className="bench-row-tools">
                          {sheet.probes.length > 1 && (
                            <button
                              type="button"
                              className="xb-link"
                              aria-label={`${canRead ? "Read" : "Use latest logged for"} every probe in row ${i + 1}`}
                              onClick={() =>
                                void run(row.id, async () => {
                                  for (const key of sheet.probes) await capture(row.id, key);
                                })
                              }
                            >
                              {working === row.id ? "Reading…" : "Read row"}
                            </button>
                          )}
                          {sheet.rows.length > 4 && (
                            <button
                              type="button"
                              className="bench-x"
                              aria-label={`Remove row ${i + 1}`}
                              onClick={() =>
                                setSheet((prev) => ({ ...prev, rows: prev.rows.filter((r) => r.id !== row.id) }))
                              }
                            >
                              <X size={14} aria-hidden="true" />
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {sheet.rows.length < 10 && (
                <footer className="bench-card-foot">
                  <button
                    type="button"
                    className="xb-link"
                    onClick={() =>
                      setSheet((prev) => ({
                        ...prev,
                        rows: [...prev.rows, { id: crypto.randomUUID(), vwc: "", cells: {} }],
                      }))
                    }
                  >
                    Add row
                  </button>
                </footer>
              )}
            </div>
            <div className="bench-card bench-fit">
              <header className="bench-card-head">
                <h4>Curve</h4>
                <div className="xb-segment bench-segment" role="group" aria-label="Fit model">
                  {FIT_MODES.map(([mode, label]) => (
                    <button
                      type="button"
                      key={mode}
                      className={sheet.mode === mode ? "is-selected" : ""}
                      aria-pressed={sheet.mode === mode}
                      onClick={() => setSheet((prev) => ({ ...prev, mode }))}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </header>
              {sheet.mode === "manual" && (
                <div className="bench-manual">
                  {sheet.manual.map((v, i) => (
                    <label key={i}>
                      {POWERS[i]}
                      <input
                        type="number"
                        step="any"
                        value={v}
                        placeholder="0"
                        onChange={(e) =>
                          setSheet((prev) => ({
                            ...prev,
                            manual: prev.manual.map((old, j) => (j === i ? e.target.value : old)),
                          }))
                        }
                      />
                    </label>
                  ))}
                </div>
              )}
              <CurvePlot points={fit.points} coefficients={fit.coefficients} />
              {fit.error ? (
                <p className="bench-empty">{fit.error}</p>
              ) : (
                <div className="bench-result">
                  <code>{equation(fit.coefficients)}</code>
                  {fit.r2 !== null && (
                    <span>
                      R² {fit.r2.toFixed(4)} · {fit.points.length} reference samples
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>
          <div className="bench-save">
            <label>
              Calibration name
              <input
                maxLength={120}
                value={name}
                placeholder={experimentName || "e.g. Greenhouse peat mix"}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <button
              type="button"
              className="is-secondary"
              disabled={!libraryReady || !fit.coefficients.length || !(name || experimentName).trim()}
              onClick={() => void run("save", save)}
            >
              {working === "save" ? "Saving…" : "Save calibration"}
            </button>
          </div>
        </fieldset>
      ) : (
        <>
          <div className={savedRows.length ? "bench-grid" : "bench-grid is-single"}>
            {saved && savedRows.length > 0 && (
              <div className="bench-card">
                <header className="bench-card-head">
                  <h4>Reference samples</h4>
                  <span className="bench-muted">
                    {saved.worksheet.probes.length} probe{saved.worksheet.probes.length === 1 ? "" : "s"}
                  </span>
                </header>
                <div className="bench-scroll">
                  <table className="bench-table is-readonly">
                    <thead>
                      <tr>
                        <th>VWC %</th>
                        {saved.worksheet.probes.map((k) => (
                          <th key={k}>{k}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {savedRows.map((r) => (
                        <tr key={r.id}>
                          <td>{r.vwc}</td>
                          {saved.worksheet.probes.map((k) => (
                            <td key={k}>{r.cells[k]?.value || "—"}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
            <div className="bench-card bench-fit">
              <header className="bench-card-head">
                <h4>{choice}</h4>
                {!saved && deviceCurve && <span className="bench-muted">On the controller</span>}
              </header>
              {chosenCoefficients ? (
                <>
                  <CurvePlot points={savedFit?.points ?? []} coefficients={chosenCoefficients} />
                  <div className="bench-result">
                    <code>{equation(chosenCoefficients)}</code>
                  </div>
                </>
              ) : (
                <p className="bench-empty">{libraryReady ? "This curve is no longer saved." : "Loading…"}</p>
              )}
            </div>
          </div>
          {reviewOpen ? (
            <div className="bench-confirm">
              <div>
                <strong>Apply {choice}?</strong>
                <p>{targets.join(", ")}</p>
                <p>
                  {controllerState === "running"
                    ? "The controller will briefly stop, apply the curve to these pots, then restart."
                    : "The controller will apply the curve to these pots while stopped."}
                </p>
              </div>
              <div className="bench-actions">
                <button type="button" className="is-secondary" onClick={() => setReview("")}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="is-primary"
                  disabled={commandBusy || Boolean(working)}
                  onClick={() => void run("apply", apply)}
                >
                  Confirm assignment
                </button>
              </div>
            </div>
          ) : (
            <div className="bench-assign">
              <p role={admin && conflict ? "alert" : undefined}>{assignNote}</p>
              <button
                type="button"
                className="is-secondary"
                disabled={
                  !admin ||
                  !targets.length ||
                  !controllerState ||
                  !hash ||
                  conflict ||
                  commandBusy ||
                  Boolean(working) ||
                  (submitted && progress !== null && !progress.terminal)
                }
                onClick={() => {
                  setReview(signature);
                  setSubmitted(false);
                  setMessage("");
                }}
              >
                Review assignment
              </button>
            </div>
          )}
        </>
      )}
      {(error || (submitted && commandError)) && (
        <p className="bench-note" role="alert">
          {error || commandError}
        </p>
      )}
      {message && (
        <p className="bench-note" role="status">
          {message}
        </p>
      )}
      {submitted && progress && (
        <p className="bench-note" role="status">
          {progress.title}. {progress.detail}
        </p>
      )}
    </section>
  );
}
