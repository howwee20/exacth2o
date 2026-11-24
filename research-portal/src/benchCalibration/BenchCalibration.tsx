import { useEffect, useMemo, useRef, useState } from "react";
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
  sampleMean,
  type Cell,
  type FitMode,
  type Worksheet,
} from "./model";
import { CurvePlot } from "./CurvePlot";
import "./bench.css";

type Curve = { id: string; name: string; coefficients: number[]; worksheet: Worksheet };
type Probe = { key: string; id: number; label: string };
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
        label: `${p.sensor_key} · Pot ${p.pot_number}`,
      });
  }
  return [...options.values()].sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
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
        !sameCurve(row.coefficients, fit.coefficients) ||
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

  return (
    <section className="xb-section bench-calibration" aria-label="Soil calibration worksheet">
      <div className="xb-heading">
        <h3>Soil calibration</h3>
      </div>
      <p className="bench-hint">
        Measure each probe in the same reference sample. Each row pairs the known water content with the average
        raw reading.
      </p>
      <fieldset disabled={Boolean(working)} className="bench-fields">
        <label>
          Add probe
          <select
            aria-label="Add calibration probe"
            value=""
            onChange={(e) => {
              const key = e.target.value;
              if (key) setSheet((prev) => ({ ...prev, probes: [...prev.probes, key] }));
            }}
          >
            <option value="">Choose a connected probe</option>
            {inventory
              .filter((p) => !sheet.probes.includes(p.key))
              .map((p) => (
                <option value={p.key} key={p.key}>
                  {p.label}
                </option>
              ))}
          </select>
        </label>
        <div className="bench-scroll">
          <table>
            <thead>
              <tr>
                <th>Reference VWC (%)</th>
                {sheet.probes.map((key) => (
                  <th key={key}>
                    {key}{" "}
                    <button
                      type="button"
                      className="xb-link"
                      aria-label={`Remove probe ${key}`}
                      onClick={() =>
                        setSheet((prev) => ({ ...prev, probes: prev.probes.filter((p) => p !== key) }))
                      }
                    >
                      ×
                    </button>
                  </th>
                ))}
                <th>Average raw</th>
              </tr>
            </thead>
            <tbody>
              {sheet.rows.map((row, i) => (
                <tr key={row.id}>
                  <td>
                    <input
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
                            className="xb-link"
                            onClick={() => void run(row.id + key, () => capture(row.id, key))}
                          >
                            {working === row.id + key ? "Reading…" : canRead ? "Read now" : "Use latest logged"}
                          </button>
                        </div>
                        {cell?.capturedAt && (
                          <small>
                            {cell.source === "direct" ? "Measured" : "Logged"}{" "}
                            {new Date(cell.capturedAt).toLocaleString()}
                          </small>
                        )}
                      </td>
                    );
                  })}
                  <td>
                    {sampleMean(row, sheet.probes)?.toLocaleString(undefined, { maximumFractionDigits: 4 }) ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="bench-actions">
          <button
            type="button"
            disabled={sheet.rows.length >= 10}
            onClick={() =>
              setSheet((prev) => ({
                ...prev,
                rows: [...prev.rows, { id: crypto.randomUUID(), vwc: "", cells: {} }],
              }))
            }
          >
            Add row
          </button>
          <button
            type="button"
            disabled={sheet.rows.length <= 4}
            onClick={() => setSheet((prev) => ({ ...prev, rows: prev.rows.slice(0, -1) }))}
          >
            Remove last row
          </button>
        </div>
        <label>
          Fit model
          <select
            value={sheet.mode}
            onChange={(e) => setSheet((prev) => ({ ...prev, mode: e.target.value as FitMode }))}
          >
            <option value="linear">Linear</option>
            <option value="cubic">Cubic</option>
            <option value="manual">Manual coefficients</option>
          </select>
        </label>
        {sheet.mode === "manual" && (
          <div className="bench-manual">
            {sheet.manual.map((v, i) => (
              <label key={i}>
                {i === 0 ? "Constant" : `x^${i}`}
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
          <p className="bench-hint">{fit.error}</p>
        ) : (
          <div>
            <code>{equation(fit.coefficients)}</code>
            {fit.r2 !== null && (
              <p>
                R² {fit.r2.toFixed(4)} · {fit.points.length} reference samples
              </p>
            )}
          </div>
        )}
        <div className="bench-actions">
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
            disabled={!libraryReady || !fit.coefficients.length || !(name || experimentName).trim()}
            onClick={() => void run("save", save)}
          >
            Save calibration
          </button>
        </div>
      </fieldset>
      <div className="bench-library">
        <h4>Saved calibrations</h4>
        <label>
          Curve to assign
          <select
            value={choice}
            onChange={(e) => {
              choose(e.target.value);
              setReview("");
              setSubmitted(false);
              setMessage("");
            }}
          >
            <option value="">Select a saved curve</option>
            {names.map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>
        </label>
        {chosenCoefficients && <code>{equation(chosenCoefficients)}</code>}
        {saved && (
          <details>
            <summary>Saved worksheet · {saved.worksheet.probes.length} probes</summary>
            <div className="bench-scroll">
              <table>
                <thead>
                  <tr>
                    <th>VWC (%)</th>
                    {saved.worksheet.probes.map((k) => (
                      <th key={k}>{k}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {saved.worksheet.rows.map((r) => (
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
          </details>
        )}
        {choice && (
          <>
            <p className="bench-hint">
              {targets.length
                ? `Assign to the ${targets.length} pot${targets.length === 1 ? "" : "s"} selected in this experiment.`
                : "Select the destination pots in the experiment below."}
            </p>
            {!admin && <p>Administrator access is required to assign a controller calibration.</p>}
            {conflict && (
              <p role="alert">
                The controller has a different equation under this name. Save the worksheet with a new name.
              </p>
            )}
            {admin && !controllerState && <p>Waiting for current controller status.</p>}
            {!reviewOpen && (
              <button
                type="button"
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
            )}
          </>
        )}
        {reviewOpen && (
          <div className="bench-confirm">
            <strong>Apply {choice}?</strong>
            <p>{targets.join(", ")}</p>
            <p>
              {controllerState === "running"
                ? "The controller will briefly stop, apply the curve to these pots, then restart."
                : "The controller will apply the curve to these pots while stopped."}
            </p>
            <div className="bench-actions">
              <button
                type="button"
                disabled={commandBusy || Boolean(working)}
                onClick={() => void run("apply", apply)}
              >
                Confirm assignment
              </button>
              <button type="button" onClick={() => setReview("")}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
      {(error || (submitted && commandError)) && <p role="alert">{error || commandError}</p>}
      {message && <p role="status">{message}</p>}
      {submitted && progress && (
        <p role="status">
          {progress.title}. {progress.detail}
        </p>
      )}
    </section>
  );
}
