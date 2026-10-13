import { loadExportExperiment, loadExportReadings } from "../experimentExportClient";
import { useEffect, useMemo, useRef, useState } from "react";
import { downloadReportFile, experimentBriefHtml, experimentReadingsCsv, reportReadings, type ExperimentReportInput } from "../experimentReport";
import type { PortalExperiment } from "../experimentRegistry";
import { loadRecordSources } from "../recordClient";
import { calibrationRequestItems, gapItems, noteItems, planItems, settingsItems, wateringItems, type RecordItem } from "../recordModel";
import type { PairingRow, SensorReading } from "../types";

export function ExperimentExport({experiment, pairings, readings, projectId, deviceId, nowMs, loadedWindowMs, onClose}: {
  experiment: PortalExperiment; pairings: readonly PairingRow[]; readings: readonly SensorReading[]; projectId: string; deviceId: string;
  nowMs: number; loadedWindowMs: number; onClose: () => void;
}) {
  const [spanHours,setSpanHours] = useState(Math.min(72,loadedWindowMs / 3_600_000));
  const [customStart,setCustomStart] = useState(experiment.startedAt?.slice(0,16) ?? new Date(nowMs-14*86400000).toISOString().slice(0,16));
  const [customEnd,setCustomEnd] = useState(new Date(nowMs).toISOString().slice(0,16));
  const [progress,setProgress] = useState(0);
  const [firstReadingAt,setFirstReadingAt] = useState<number | null>(null);

  const [exportExperiment,setExportExperiment] = useState(experiment);
  const [exportReadings,setExportReadings] = useState<readonly SensorReading[]>(readings);
  const dialog = useRef<HTMLElement>(null);
  const closeCallback = useRef(onClose);
  useEffect(() => { closeCallback.current = onClose; }, [onClose]);
  const [anchor] = useState(nowMs);
  const [events, setEvents] = useState<RecordItem[]>([]);
  const [problems, setProblems] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const frame = useRef<HTMLIFrameElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const endMs = spanHours === -1 ? Date.parse(customEnd+"Z") : Math.min(anchor, experiment.endedAt ? Date.parse(experiment.endedAt) : anchor);
  const queryStartMs = spanHours === -1 ? Date.parse(customStart+"Z") : spanHours === 0 ? (experiment.startedAt ? Date.parse(experiment.startedAt) : null) : Math.max(endMs-spanHours*3_600_000, experiment.startedAt ? Date.parse(experiment.startedAt) : -Infinity);
  const startMs = queryStartMs ?? firstReadingAt ?? endMs;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null; close.current?.focus();
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeCallback.current();
      if (event.key !== "Tab") return;
      const controls=Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select,a[href],iframe') ?? []);
      const first=controls[0],last=controls.at(-1);
      if(event.shiftKey && document.activeElement===first){event.preventDefault();last?.focus();}
      else if(!event.shiftKey && document.activeElement===last){event.preventDefault();first?.focus();}
    };
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("keydown", escape); previous?.focus(); };
  }, []);
  useEffect(() => {
    let active = true;
    const cancel = new AbortController();
    setLoading(true);setEvents([]);setProblems([]);setProgress(0);
    if ((queryStartMs !== null && !Number.isFinite(queryStartMs)) || !Number.isFinite(endMs) || (queryStartMs !== null && endMs <= queryStartMs)) {setProblems(["Choose a valid end after the start."]);setExportReadings([]);setLoading(false);return;}
    void (async () => {
      const warnings:string[]=[];
      if (queryStartMs === null) warnings.push("No experiment start is recorded. This CSV includes all stored measurements for labels in the recorded plans; choose custom dates to restrict reused labels.");
      let recordStart = queryStartMs ?? endMs;
      try {
        const scope = await loadExportExperiment(experiment);
        if (!active) return;
        setExportExperiment(scope);
        const measurements = await loadExportReadings({projectId,deviceId,pairingNames:scope.pairingNames,startMs:queryStartMs,endMs,signal:cancel.signal,onProgress:(count)=>{if(active)setProgress(count);}});
        if (!active) return;
        setExportReadings(measurements.readings);
        if (queryStartMs === null && measurements.readings.length) {
          recordStart = measurements.readings.reduce((at,row)=>Math.min(at,Date.parse(row.device_recorded_at)),endMs);
          setFirstReadingAt(recordStart);
        }
      } catch {
        if (!active) return;
        setExportReadings([]);warnings.push("Readings could not be loaded. Close and reopen this export to retry.");
      }
      if (experiment.databaseId) {
        try {
          const data = await loadRecordSources({projectId,deviceId,experimentDatabaseId:experiment.databaseId,pairingNames:experiment.pairingNames,pairingAssignments:experiment.assignments,startMs:recordStart,endMs});
          if (!active) return;
          warnings.push(...data.problems);
          setEvents([...planItems(data.revisions,data.audits,data.assignments),...settingsItems(data.commands,data.historyPairingNames,experiment.databaseId),...calibrationRequestItems(data.calibrationRequests,data.historyPairingNames),...noteItems(data.notes),...gapItems(data.gaps,pairings),...wateringItems(data.daily)]);
        } catch {warnings.push("The experiment record is unavailable. The readings export is independent of plan revisions and notes.");}
      } else warnings.push("The experiment record is unavailable. The readings export is independent of plan revisions and notes.");
      if (active) {setProblems(warnings);setLoading(false);}
    })();
    return () => { active = false; cancel.abort(); };
  }, [deviceId,endMs,experiment.databaseId,experiment.pairingNames,experiment.assignments,experiment,pairings,projectId,queryStartMs]);
  const input: ExperimentReportInput = useMemo(() => ({experiment:exportExperiment,currentExperiment:experiment,pairings,readings:exportReadings,events,problems,startMs,endMs,generatedAt:anchor,preserveRecordedLabels:true,source:document.documentElement.dataset.portalMode === "demo" ? "demo measurements" : "stored measurements"}),[anchor,endMs,events,experiment,exportExperiment,pairings,problems,exportReadings,startMs]);
  const html = useMemo(() => experimentBriefHtml(input),[input]);
  const filename = `exacth2o-${experiment.id.replace(/[^a-z0-9_-]/gi,"-")}-${new Date(anchor).toISOString().slice(0,10)}`;
  const count = reportReadings(input).length;
  return <div className="px-export-backdrop" role="presentation"><section ref={dialog} className="px-export-dialog" role="dialog" aria-modal="true" aria-labelledby="export-title">
    <header><div><h2 id="export-title">Export experiment</h2><p>{experiment.name} · {count.toLocaleString()} readings · UTC</p></div><button ref={close} className="px-button" onClick={onClose}>Close</button></header>
    <div className="px-toolbar"><label>Reporting window <select value={spanHours} onChange={(event) => setSpanHours(Number(event.target.value))}><option value={24}>Last 24 hours</option><option value={72}>Last 3 days</option><option value={168}>Last 7 days</option><option value={336}>Last 14 days</option><option value={0}>Entire experiment</option><option value={-1}>Custom dates (UTC)</option></select></label>{spanHours===-1 ? <><label>Start (UTC)<input type="datetime-local" value={customStart} onChange={(e)=>setCustomStart(e.target.value)}/></label><label>End (UTC)<input type="datetime-local" value={customEnd} onChange={(e)=>setCustomEnd(e.target.value)}/></label></> : null}<button className="px-button is-primary" disabled={loading} onClick={() => downloadReportFile(`${filename}-brief.html`,html,"text/html;charset=utf-8")}>{loading ? `Preparing ${progress.toLocaleString()} readings…` : "Save brief"}</button><button className="px-button" disabled={loading||!count} onClick={() => downloadReportFile(`${filename}-readings.csv`,experimentReadingsCsv(input),"text/csv;charset=utf-8")}>Readings CSV</button><button className="px-button" disabled={loading} onClick={() => frame.current?.contentWindow?.print()}>Print / PDF</button></div>
    {problems.map((problem)=><p className="px-notice" role="status" key={problem}>{problem}</p>)}
    <div className="px-export-preview" aria-busy={loading}>{loading ? <p className="px-notice" role="status">Preparing {progress.toLocaleString()} readings…</p> : <iframe ref={frame} title="Experiment brief preview" srcDoc={html} sandbox="allow-same-origin allow-modals" />}</div>
  </section></div>;
}
