import { loadExportReadings } from "../experimentExportClient";
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
  const [initialReadings] = useState(readings);
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
  const endMs = Math.min(anchor, experiment.endedAt ? Date.parse(experiment.endedAt) : anchor);
  const startMs = Math.max(endMs-spanHours*3_600_000, experiment.startedAt ? Date.parse(experiment.startedAt) : -Infinity);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null; close.current?.focus();
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeCallback.current();
      if (event.key !== "Tab") return;
      const controls=Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),select,a[href],iframe') ?? []);
      const first=controls[0],last=controls.at(-1);
      if(event.shiftKey && document.activeElement===first){event.preventDefault();last?.focus();}
      else if(!event.shiftKey && document.activeElement===last){event.preventDefault();first?.focus();}
    };
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("keydown", escape); previous?.focus(); };
  }, []);
  useEffect(() => {
    let active = true;
    setLoading(true);setEvents([]);setProblems([]);
    if (document.documentElement.dataset.portalMode === "demo" || !experiment.databaseId) {
      setExportReadings(initialReadings);setProblems(["Sample data. Saved plan revisions and notes are not included in this brief."]);setLoading(false);return;
    }
    void Promise.allSettled([
      loadExportReadings({projectId,deviceId,pairingNames:experiment.pairingNames,startMs,endMs}),
      loadRecordSources({projectId,deviceId,experimentDatabaseId:experiment.databaseId,pairingNames:experiment.pairingNames,startMs,endMs}),
    ]).then(([measurements,record]) => {
      if(!active)return;
      const warnings:string[]=[];
      if(measurements.status==="fulfilled"){
        setExportReadings(measurements.value.readings);
        if(measurements.value.truncated)warnings.push("Partial reading export: the 50,000-reading limit was reached. Choose a shorter reporting window for a complete export.");
      }else{setExportReadings([]);warnings.push("Readings could not be loaded. Close and reopen this export to retry.");}
      if(record.status==="fulfilled"){
        const data=record.value;warnings.push(...data.problems);
        setEvents([...planItems(data.revisions,data.audits,data.assignments),...settingsItems(data.commands,experiment.pairingNames,experiment.databaseId ?? null),...calibrationRequestItems(data.calibrationRequests,experiment.pairingNames),...noteItems(data.notes),...gapItems(data.gaps,pairings),...wateringItems(data.daily)]);
      }else warnings.push("The experiment record could not be loaded. Plan revisions, notes, and events are incomplete.");
      setProblems(warnings);setLoading(false);
    });
    return () => { active = false; };
  }, [deviceId,endMs,experiment.databaseId,experiment.pairingNames,pairings,projectId,startMs,initialReadings]);
  const input: ExperimentReportInput = useMemo(() => ({experiment,pairings,readings:exportReadings,events,problems,startMs,endMs,generatedAt:anchor,source:document.documentElement.dataset.portalMode === "demo" ? "sample measurements" : "stored measurements"}),[anchor,endMs,events,experiment,pairings,problems,exportReadings,startMs]);
  const html = useMemo(() => experimentBriefHtml(input),[input]);
  const filename = `exacth2o-${experiment.id.replace(/[^a-z0-9_-]/gi,"-")}-${new Date(anchor).toISOString().slice(0,10)}`;
  const count = reportReadings(input).length;
  return <div className="px-export-backdrop" role="presentation"><section ref={dialog} className="px-export-dialog" role="dialog" aria-modal="true" aria-labelledby="export-title">
    <header><div><h2 id="export-title">Export experiment</h2><p>{experiment.name} · {count.toLocaleString()} readings · UTC</p></div><button ref={close} className="px-button" onClick={onClose}>Close</button></header>
    <div className="px-toolbar"><label>Reporting window <select value={spanHours} onChange={(event) => setSpanHours(Number(event.target.value))}><option value={24}>Last 24 hours</option><option value={72}>Last 3 days</option><option value={168}>Last 7 days</option><option value={336}>Last 14 days</option></select></label><button className="px-button is-primary" disabled={loading} onClick={() => downloadReportFile(`${filename}-brief.html`,html,"text/html;charset=utf-8")}>{loading ? "Preparing record…" : "Save Experiment brief"}</button><button className="px-button" disabled={loading||!count} onClick={() => downloadReportFile(`${filename}-readings.csv`,experimentReadingsCsv(input),"text/csv;charset=utf-8")}>Download readings CSV</button><button className="px-button" disabled={loading} onClick={() => frame.current?.contentWindow?.print()}>Print / PDF</button></div>
    <iframe ref={frame} title="Experiment brief preview" srcDoc={html} sandbox="allow-same-origin allow-modals" />
  </section></div>;
}
