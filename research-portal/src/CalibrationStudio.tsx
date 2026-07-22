import { useCallback, useEffect, useMemo, useState, type ChangeEvent, type FormEvent } from "react";
import { Activity, CheckCircle2, FileUp, FlaskConical, Loader2, ShieldCheck, Trash2 } from "lucide-react";
import { calibrationReadySampleCount, fitCalibration, nearestCalibrationReading } from "./calibrationFit";
import type { PortalExperiment } from "./experimentRegistry";
import { supabase } from "./supabase";
import type { PairingRow, SensorReading } from "./types";

type CalibrationStudy = {
  id: string;
  project_id: string;
  experiment_id: string;
  name: string;
  pairing_name: string;
  sensor_key: string;
  reference_instrument: string | null;
  match_tolerance_seconds: number;
  status: "draft" | "candidate" | "set_requested" | "archived";
  created_at: string;
  updated_at: string;
};

type CalibrationObservation = {
  id: string;
  study_id: string;
  project_id: string;
  reference_recorded_at: string;
  reference_vwc: number;
  sensor_reading_id: number | null;
  matched_event_id: string | null;
  sensor_recorded_at: string | null;
  raw_value: number | null;
  current_calibrated_value: number | null;
  time_delta_seconds: number | null;
  match_status: "matched" | "unmatched";
  included: boolean;
  notes: string | null;
  created_at: string;
};

type CalibrationCandidate = {
  id: string;
  study_id: string;
  project_id: string;
  version: number;
  fit_type: "linear" | "quadratic";
  coefficients: number[];
  equation_text: string;
  sample_count: number;
  raw_min: number;
  raw_max: number;
  reference_min: number;
  reference_max: number;
  rmse: number;
  mae: number;
  r_squared: number;
  max_error: number;
  status: "preview" | "ready" | "archived";
  created_at: string;
};

type CalibrationStudioProps = {
  projectId: string;
  experiment: PortalExperiment;
  pairings: PairingRow[];
  readings: SensorReading[];
  portalRole: "admin" | "researcher" | "viewer";
  controllerStopped: boolean;
};

const readingColumns =
  "id,event_id,pairing_name,sensor_key,raw_value,calibrated_value,temperature,electrical_conductivity,device_recorded_at,server_received_at";

function messageFromError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function localDateTimeInputValue(date = new Date()) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function displayDate(value: string | null) {
  if (!value) return "--";
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    : "--";
}

function displayMetric(value: number, digits = 2) {
  return Number.isFinite(value) ? value.toFixed(digits) : "--";
}

function parseCsv(text: string) {
  const rows = text.split(/\r?\n/).map((row) => row.trim()).filter(Boolean);
  if (rows.length < 2) throw new Error("CSV needs a header and at least one measurement row.");
  const headers = rows[0].split(",").map((header) => header.trim().toLowerCase());
  const timestampIndex = headers.findIndex((header) => ["timestamp", "time", "datetime", "recorded_at"].includes(header));
  const valueIndex = headers.findIndex((header) => ["external_vwc", "reference_vwc", "vwc", "value"].includes(header));
  if (timestampIndex < 0 || valueIndex < 0) {
    throw new Error("CSV headers must include timestamp and external_vwc.");
  }
  return rows.slice(1).map((row, index) => {
    const values = row.split(",").map((value) => value.trim().replace(/^"|"$/g, ""));
    const recordedAt = new Date(values[timestampIndex]);
    const referenceVwc = Number(values[valueIndex]);
    if (!Number.isFinite(recordedAt.getTime()) || !Number.isFinite(referenceVwc) || referenceVwc < 0 || referenceVwc > 100) {
      throw new Error(`CSV row ${index + 2} has an invalid timestamp or VWC value.`);
    }
    return { referenceRecordedAt: recordedAt.toISOString(), referenceVwc };
  });
}

export function CalibrationStudio({
  projectId,
  experiment,
  pairings,
  readings,
  portalRole,
  controllerStopped,
}: CalibrationStudioProps) {
  const [studies, setStudies] = useState<CalibrationStudy[]>([]);
  const [observations, setObservations] = useState<CalibrationObservation[]>([]);
  const [candidates, setCandidates] = useState<CalibrationCandidate[]>([]);
  const [activeStudyId, setActiveStudyId] = useState<string>("");
  const [studyName, setStudyName] = useState(`${experiment.name} calibration`);
  const [pairingName, setPairingName] = useState(pairings[0]?.name ?? "");
  const [referenceInstrument, setReferenceInstrument] = useState("");
  const [referenceRecordedAt, setReferenceRecordedAt] = useState(localDateTimeInputValue());
  const [referenceVwc, setReferenceVwc] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const activeStudy = studies.find((study) => study.id === activeStudyId) ?? studies[0] ?? null;
  const studyObservations = useMemo(
    () => observations.filter((observation) => observation.study_id === activeStudy?.id),
    [activeStudy?.id, observations],
  );
  const includedMatches = useMemo(
    () => studyObservations.filter((observation) => observation.match_status === "matched" && observation.included && observation.raw_value !== null),
    [studyObservations],
  );
  const activeCandidate = candidates
    .filter((candidate) => candidate.study_id === activeStudy?.id)
    .sort((left, right) => right.version - left.version)[0] ?? null;
  const selectedPairing = pairings.find((pairing) => pairing.name === pairingName) ?? pairings[0] ?? null;

  const loadStudio = useCallback(async () => {
    setLoading(true);
    setError(null);
    const studiesResult = await supabase
      .from("calibration_studies")
      .select("*")
      .eq("project_id", projectId)
      .eq("experiment_id", experiment.id)
      .neq("status", "archived")
      .order("updated_at", { ascending: false });
    if (studiesResult.error) {
      setError(messageFromError(studiesResult.error));
      setLoading(false);
      return;
    }
    const loadedStudies = (studiesResult.data ?? []) as CalibrationStudy[];
    setStudies(loadedStudies);
    setActiveStudyId((current) => current && loadedStudies.some((study) => study.id === current) ? current : loadedStudies[0]?.id ?? "");

    if (loadedStudies.length) {
      const studyIds = loadedStudies.map((study) => study.id);
      const [observationResult, candidateResult] = await Promise.all([
        supabase.from("calibration_observations").select("*").in("study_id", studyIds).order("reference_recorded_at", { ascending: false }),
        supabase.from("calibration_candidates").select("*").in("study_id", studyIds).order("version", { ascending: false }),
      ]);
      if (observationResult.error || candidateResult.error) {
        setError(messageFromError(observationResult.error ?? candidateResult.error));
      } else {
        setObservations((observationResult.data ?? []) as CalibrationObservation[]);
        setCandidates((candidateResult.data ?? []) as CalibrationCandidate[]);
      }
    } else {
      setObservations([]);
      setCandidates([]);
    }
    setLoading(false);
  }, [experiment.id, projectId]);

  useEffect(() => {
    setStudyName(`${experiment.name} calibration`);
    setPairingName(pairings[0]?.name ?? "");
    void loadStudio();
  }, [experiment.id, experiment.name, loadStudio, pairings]);

  async function createStudy(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedPairing) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const result = await supabase.from("calibration_studies").insert({
      project_id: projectId,
      experiment_id: experiment.id,
      name: studyName.trim(),
      pairing_name: selectedPairing.name,
      sensor_key: selectedPairing.sensor_key,
      reference_instrument: referenceInstrument.trim() || null,
      match_tolerance_seconds: 300,
    }).select("*").single();
    if (result.error) setError(messageFromError(result.error));
    else {
      setNotice("Study created.");
      setActiveStudyId((result.data as CalibrationStudy).id);
      await loadStudio();
    }
    setBusy(false);
  }

  async function readingMatch(study: CalibrationStudy, recordedAt: string) {
    const toleranceMs = study.match_tolerance_seconds * 1000;
    const targetMs = new Date(recordedAt).getTime();
    const cachedMatch = nearestCalibrationReading(readings, study.pairing_name, recordedAt, study.match_tolerance_seconds);
    if (cachedMatch) return cachedMatch;
    const result = await supabase
      .from("sensor_readings")
      .select(readingColumns)
      .eq("project_id", projectId)
      .eq("pairing_name", study.pairing_name)
      .gte("device_recorded_at", new Date(targetMs - toleranceMs).toISOString())
      .lte("device_recorded_at", new Date(targetMs + toleranceMs).toISOString())
      .order("device_recorded_at", { ascending: true })
      .limit(250);
    if (result.error) throw result.error;
    return nearestCalibrationReading((result.data ?? []) as SensorReading[], study.pairing_name, recordedAt, study.match_tolerance_seconds);
  }

  async function insertMeasurements(measurements: { referenceRecordedAt: string; referenceVwc: number }[]) {
    if (!activeStudy) throw new Error("Create or select a calibration study first.");
    const rows = [];
    for (const measurement of measurements) {
      const match = await readingMatch(activeStudy, measurement.referenceRecordedAt);
      rows.push({
        study_id: activeStudy.id,
        project_id: projectId,
        reference_recorded_at: measurement.referenceRecordedAt,
        reference_vwc: measurement.referenceVwc,
        sensor_reading_id: match?.reading.id ?? null,
        matched_event_id: match?.reading.event_id ?? null,
        sensor_recorded_at: match?.reading.device_recorded_at ?? null,
        raw_value: match?.reading.raw_value ?? null,
        current_calibrated_value: match?.reading.calibrated_value ?? null,
        time_delta_seconds: match?.deltaSeconds ?? null,
        match_status: match ? "matched" : "unmatched",
      });
    }
    const result = await supabase.from("calibration_observations").insert(rows);
    if (result.error) throw result.error;
    return rows.filter((row) => row.match_status === "matched").length;
  }

  async function addMeasurement(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const externalValue = Number(referenceVwc);
    const recordedAt = new Date(referenceRecordedAt);
    if (!Number.isFinite(externalValue) || externalValue < 0 || externalValue > 100 || !Number.isFinite(recordedAt.getTime())) {
      setError("Enter a valid time and external VWC from 0 to 100%.");
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const matched = await insertMeasurements([{ referenceRecordedAt: recordedAt.toISOString(), referenceVwc: externalValue }]);
      setNotice(matched ? "Reading matched." : "Saved without a match. No ExactH2O reading was within 5 minutes.");
      setReferenceVwc("");
      setReferenceRecordedAt(localDateTimeInputValue());
      await loadStudio();
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setBusy(false);
    }
  }

  async function uploadCsv(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const measurements = parseCsv(await file.text());
      if (measurements.length > 250) throw new Error("V1 accepts up to 250 rows per CSV upload.");
      const matched = await insertMeasurements(measurements);
      setNotice(`${measurements.length} rows uploaded; ${matched} matched to ExactH2O readings.`);
      await loadStudio();
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setBusy(false);
    }
  }

  async function toggleIncluded(observation: CalibrationObservation) {
    const result = await supabase
      .from("calibration_observations")
      .update({ included: !observation.included })
      .eq("id", observation.id);
    if (result.error) setError(messageFromError(result.error));
    else await loadStudio();
  }

  async function deleteObservation(observation: CalibrationObservation) {
    const result = await supabase.from("calibration_observations").delete().eq("id", observation.id);
    if (result.error) setError(messageFromError(result.error));
    else await loadStudio();
  }

  async function createCalibration() {
    if (!activeStudy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const fit = fitCalibration(includedMatches.map((observation) => ({
        rawValue: observation.raw_value as number,
        referenceValue: observation.reference_vwc,
      })));
      const nextVersion = Math.max(0, ...candidates.filter((candidate) => candidate.study_id === activeStudy.id).map((candidate) => candidate.version)) + 1;
      const result = await supabase.from("calibration_candidates").insert({
        study_id: activeStudy.id,
        project_id: projectId,
        version: nextVersion,
        fit_type: fit.fitType,
        coefficients: fit.coefficients,
        equation_text: fit.equation,
        sample_count: fit.sampleCount,
        raw_min: fit.rawMin,
        raw_max: fit.rawMax,
        reference_min: fit.referenceMin,
        reference_max: fit.referenceMax,
        rmse: fit.rmse,
        mae: fit.mae,
        r_squared: fit.rSquared,
        max_error: fit.maxError,
        status: fit.readyToSet ? "ready" : "preview",
      });
      if (result.error) throw result.error;
      const studyResult = await supabase.from("calibration_studies").update({ status: "candidate" }).eq("id", activeStudy.id);
      if (studyResult.error) throw studyResult.error;
      setNotice(fit.readyToSet
        ? "Calibration created. It has not been set."
        : `Preview created. Add ${calibrationReadySampleCount - fit.sampleCount} matches before setting.`);
      await loadStudio();
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setBusy(false);
    }
  }

  async function requestSetCalibration() {
    if (!activeStudy || !activeCandidate) return;
    const confirmed = window.confirm(
      `Request setting ${activeStudy.name} for ${activeStudy.pairing_name}? This V1 records an approval request; it does not change the live controller or existing calibration.`,
    );
    if (!confirmed) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const result = await supabase.from("calibration_set_requests").insert({
      candidate_id: activeCandidate.id,
      study_id: activeStudy.id,
      project_id: projectId,
      pairing_names: [activeStudy.pairing_name],
      notes: "Calibration Studio V1 approval request. Controller application requires a separate verified operational action.",
    });
    if (result.error) setError(messageFromError(result.error));
    else {
      await supabase.from("calibration_studies").update({ status: "set_requested" }).eq("id", activeStudy.id);
      setNotice("Set request saved. The current calibration is unchanged.");
      await loadStudio();
    }
    setBusy(false);
  }

  if (loading) {
    return <section className="calibration-loading"><Loader2 className="chart-loading-spinner" size={24} /> Loading Calibration Studio…</section>;
  }

  return (
    <div className="calibration-studio">
      <section className="calibration-hero">
        <div>
          <h3>{experiment.name} calibration</h3>
          <p>Match external VWC readings to ExactH2O data, then create an equation.</p>
        </div>
      </section>

      {notice ? <div className="settings-callout is-success"><CheckCircle2 size={18} /><strong>{notice}</strong></div> : null}
      {error ? <div className="settings-callout is-error"><Activity size={18} /><div><strong>Calibration Studio needs attention.</strong><p>{error}</p></div></div> : null}

      <div className="calibration-layout">
        <aside className="calibration-study-list">
          <div className="calibration-section-heading">
            <div><h3>Studies</h3></div>
            <b>{studies.length}</b>
          </div>
          {studies.map((study) => (
            <button
              type="button"
              key={study.id}
              className={study.id === activeStudy?.id ? "is-active" : ""}
              onClick={() => setActiveStudyId(study.id)}
            >
              <strong>{study.name}</strong>
              <span>{study.pairing_name.replace(/Zone\d-Pot/, "Pot ")}</span>
              <em>{study.status.replace("_", " ")}</em>
            </button>
          ))}
          <form className="calibration-new-study" onSubmit={createStudy}>
            <strong>New study</strong>
            <label>Name<input value={studyName} onChange={(event) => setStudyName(event.target.value)} required /></label>
            <label>
              Pot / ExactH2O sensor
              <select value={pairingName} onChange={(event) => setPairingName(event.target.value)} required>
                {pairings.map((pairing) => <option key={pairing.id} value={pairing.name}>Pot {pairing.pot_number} · {pairing.sensor_key}</option>)}
              </select>
            </label>
            <label>Reference instrument<input value={referenceInstrument} onChange={(event) => setReferenceInstrument(event.target.value)} placeholder="Example: handheld TDR" /></label>
            <button className="settings-secondary-button" type="submit" disabled={busy || !selectedPairing}>Start study</button>
          </form>
        </aside>

        <div className="calibration-workspace">
          {activeStudy ? (
            <>
              <section className="calibration-progress-card">
                <div>
                  <h3>{activeStudy.name}</h3>
                  <p>{activeStudy.pairing_name} · {activeStudy.sensor_key} · ±{activeStudy.match_tolerance_seconds / 60} minute match window</p>
                </div>
                <div className="calibration-progress-value">
                  <strong>{includedMatches.length}<small> / {calibrationReadySampleCount}</small></strong>
                  <span>matched</span>
                </div>
                <div className="calibration-progress-track"><span style={{ width: `${Math.min(100, includedMatches.length / calibrationReadySampleCount * 100)}%` }} /></div>
              </section>

              <div className="calibration-entry-grid">
                <section className="settings-card calibration-entry-card">
                  <div className="calibration-section-heading"><div><h3>Add reading</h3></div></div>
                  <form className="settings-form" onSubmit={addMeasurement}>
                    <label>Measurement time<input type="datetime-local" value={referenceRecordedAt} onChange={(event) => setReferenceRecordedAt(event.target.value)} required /></label>
                    <label>External sensor VWC %<input type="number" min="0" max="100" step="0.01" value={referenceVwc} onChange={(event) => setReferenceVwc(event.target.value)} placeholder="24.60" required /></label>
                    <button type="submit" className="settings-primary-button" disabled={busy}>Match reading</button>
                  </form>
                </section>
                <section className="settings-card calibration-upload-card">
                  <div className="calibration-section-heading"><div><h3>Upload CSV</h3></div><FileUp size={18} /></div>
                  <p>Columns: <b>timestamp</b> and <b>external_vwc</b>.</p>
                  <label className="calibration-upload-button">
                    <FileUp size={16} /> Choose CSV
                    <input type="file" accept=".csv,text/csv" onChange={(event) => void uploadCsv(event)} disabled={busy} />
                  </label>
                  <span>Up to 250 rows</span>
                </section>
              </div>

              <section className="calibration-pairs-card">
                <div className="calibration-section-heading">
                  <div><h3>Matched readings</h3></div>
                  <b>{studyObservations.length} rows</b>
                </div>
                {studyObservations.length ? (
                  <div className="calibration-table-wrap">
                    <table>
                      <thead><tr><th>Use</th><th>External time</th><th>External VWC</th><th>ExactH2O time</th><th>Raw reading</th><th>Delta</th><th /></tr></thead>
                      <tbody>
                        {studyObservations.map((observation) => (
                          <tr key={observation.id} className={observation.match_status === "unmatched" ? "is-unmatched" : ""}>
                            <td><input type="checkbox" checked={observation.included && observation.match_status === "matched"} disabled={observation.match_status !== "matched" || busy} onChange={() => void toggleIncluded(observation)} aria-label="Include reading in fit" /></td>
                            <td>{displayDate(observation.reference_recorded_at)}</td>
                            <td><strong>{displayMetric(observation.reference_vwc)}%</strong></td>
                            <td>{displayDate(observation.sensor_recorded_at)}</td>
                            <td>{observation.raw_value === null ? <em>No match</em> : <strong>{displayMetric(observation.raw_value, 3)}</strong>}</td>
                            <td>{observation.time_delta_seconds === null ? "--" : `${observation.time_delta_seconds}s`}</td>
                            <td><button type="button" onClick={() => void deleteObservation(observation)} disabled={busy} aria-label="Delete measurement"><Trash2 size={14} /></button></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : <div className="calibration-empty">Add one external measurement or upload a CSV to begin.</div>}
              </section>

              <section className="calibration-candidate-card">
                <div className="calibration-candidate-copy">
                  <h3>Create calibration</h3>
                  <p>Creates a saved equation. It does not set it.</p>
                  <button type="button" className="settings-primary-button" onClick={() => void createCalibration()} disabled={busy || includedMatches.length < 3}>
                    {busy ? <Loader2 className="chart-loading-spinner" size={16} /> : <FlaskConical size={16} />} Create calibration
                  </button>
                  {includedMatches.length < 3 ? <small>Add {3 - includedMatches.length} more matched reading{3 - includedMatches.length === 1 ? "" : "s"} for a preview.</small> : null}
                </div>
                <div className="calibration-equation-panel">
                  {activeCandidate ? (
                    <>
                      <div><span>Candidate v{activeCandidate.version}</span><b className={`is-${activeCandidate.status}`}>{activeCandidate.status}</b></div>
                      <code>{activeCandidate.equation_text}</code>
                      <div className="calibration-metrics">
                        <span><b>{activeCandidate.sample_count}</b> samples</span>
                        <span><b>{displayMetric(activeCandidate.rmse, 3)}</b> RMSE</span>
                        <span><b>{displayMetric(activeCandidate.mae, 3)}</b> MAE</span>
                        <span><b>{displayMetric(activeCandidate.r_squared, 3)}</b> R²</span>
                      </div>
                    </>
                  ) : <div className="calibration-equation-empty">Your generated equation and quality checks will appear here.</div>}
                </div>
              </section>

              <section className="calibration-set-card">
                <div className="calibration-set-number">2</div>
                <div>
                  <h3>Set calibration</h3>
                  <p>Admin only. Requires 25 matches and a stopped controller.</p>
                </div>
                <button
                  type="button"
                  className="settings-secondary-button"
                  onClick={() => void requestSetCalibration()}
                  disabled={busy || portalRole !== "admin" || activeCandidate?.status !== "ready" || !controllerStopped || activeStudy.status === "set_requested"}
                  title={portalRole !== "admin" ? "Administrator access required" : activeCandidate?.status !== "ready" ? `Requires ${calibrationReadySampleCount} matched readings` : !controllerStopped ? "Controller must be stopped" : "Request admin approval to set this calibration"}
                >
                  <ShieldCheck size={16} /> {activeStudy.status === "set_requested" ? "Approval requested" : "Set calibration"}
                </button>
              </section>
            </>
          ) : (
            <section className="calibration-empty calibration-empty-workspace">
              <FlaskConical size={28} />
              <h3>Start a study</h3>
              <p>Select a pot and external instrument.</p>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
