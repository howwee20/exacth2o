import { useEffect, useMemo, useState } from "react";
import { controllerLibrary, equation, isWorksheet, sameCurve, sampleMean } from "../benchCalibration/model";
import type { Worksheet } from "../benchCalibration/model";
import type { PortalExperiment } from "../experimentRegistry";
import type { DeviceConfigState } from "../portalTypes";
import { supabase } from "../supabase";
import type { PairingRow } from "../types";
import { soilCurveUse } from "./soilCurveUse";

type SavedCurve = { name: string; coefficients: number[]; worksheet: Worksheet };
type Library = { key: string; curves: SavedCurve[]; error?: string };

export function ExperimentSoilCalibration({ experiment, projectId, deviceId, config, pairings }: {
  experiment: PortalExperiment; projectId: string; deviceId?: string;
  config: DeviceConfigState | null; pairings: PairingRow[];
}) {
  const [library, setLibrary] = useState<Library | null>(null);
  const scope = JSON.stringify([projectId, deviceId]);
  useEffect(() => {
    if (!deviceId) return;
    let active = true;
    async function load() {
      try {
        const { data, error } = await supabase.from("soil_bench_calibrations")
          .select("name,coefficients,worksheet").eq("project_id", projectId).eq("device_id", deviceId);
        if (error) throw error;
        const rows = data ?? [];
        const curves = rows.filter(row => isWorksheet(row.worksheet) && Array.isArray(row.coefficients) && row.coefficients.length && row.coefficients.every(Number.isFinite)) as SavedCurve[];
        if (active) setLibrary({ key: scope, curves, error: curves.length < rows.length ? "Some worksheet records could not be read." : undefined });
      } catch {
        if (active) setLibrary({ key: scope, curves: [], error: "The worksheet library could not be loaded." });
      }
    }
    void load();
    return () => { active = false; };
  }, [deviceId, projectId, scope]);

  const installed = useMemo(() => controllerLibrary(config?.calibrations ?? []), [config]);
  const assignments = experiment.assignments ?? [];
  const setup = experiment.currentSpec?.bench_calibration_name;
  const names = new Set(experiment.pairingNames);
  const curves = soilCurveUse(setup, assignments, pairings, names);
  const current = library?.key === scope ? library : null;
  return <section className="settings-card px-soil-summary" aria-label="Experiment soil calibration">
    <h3>Soil calibration in use</h3>
    {setup && <p>Curve selected in setup: <strong>{setup}</strong></p>}
    {config && <p className="settings-muted">Controller configuration last reported {new Date(config.observed_at).toLocaleString()}.</p>}
    {!curves.size && <p>No named calibration is available for these pots.</p>}
    {[...curves].map(([name, counts]) => {
      const saved = current?.curves.find(curve => curve.name === name);
      const coefficients = installed.get(name);
      const conflicting = saved && coefficients && !sameCurve(saved.coefficients, coefficients);
      return <div className="px-soil-curve" key={name}>
        <strong>{name}</strong>
        <p>Plan revision {experiment.currentVersion ?? "unknown"}: {counts.planned.length}/{names.size} pots · Controller report: {counts.reported.length}/{names.size} pots</p>
        <details><summary>Pot assignments and equation</summary>
          <p>Plan pots: {counts.planned.join(", ") || "None recorded"}</p>
          {counts.snapshot.length > 0 && <p>On the controller when revision {experiment.currentVersion ?? "unknown"} was saved: {counts.snapshot.join(", ")}</p>}
          <p>Controller pots: {counts.reported.join(", ") || "None reported"}</p>
          <p>{coefficients ? "Controller curve: " + equation(coefficients) : "Controller equation unavailable."}</p>
        </details>
        {saved && <details><summary>View soil worksheet</summary>
          <p>{equation(saved.coefficients)} · {saved.worksheet.mode} fit</p>
          {conflicting && <p role="status">The saved worksheet and controller equations differ.</p>}
          <table><thead><tr><th>Reference VWC</th>{saved.worksheet.probes.map(key => <th key={key}>{key}</th>)}<th>Mean raw signal</th></tr></thead>
            <tbody>{saved.worksheet.rows.map(row => <tr key={row.id}><td>{row.vwc || "—"}%</td>{saved.worksheet.probes.map(key => <td key={key}>{row.cells[key]?.value || "—"}</td>)}<td>{sampleMean(row, saved.worksheet.probes)?.toFixed(2) ?? "—"}</td></tr>)}</tbody>
          </table>
        </details>}
        {!saved && current && !current.error && <p className="settings-muted">{coefficients ? "Controller curve. " : ""}No matching bench worksheet is saved on this system.</p>}
      </div>;
    })}
    {!deviceId ? <p>Waiting for system identity to load the worksheet library.</p> : !current ? <p>Loading worksheets…</p> : current.error && <p role="status">{current.error}</p>}
  </section>;
}
