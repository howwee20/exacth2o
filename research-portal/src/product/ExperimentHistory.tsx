import { useEffect, useMemo, useState } from "react";
import type { PortalExperiment } from "../experimentRegistry";
import { colorForPairing } from "../portalPresentation";
import type { PairingRow } from "../types";
import { loadExperimentHistory } from "../experimentHistoryClient";
import type { PotBucket } from "../workbenchModel";
import type { Measure } from "../waterline";
import { TimeSeriesChart, type ChartLine } from "./TimeSeriesChart";

const day = 86400000;
const localInput = (at: number) => { const d = new Date(at); return new Date(at - d.getTimezoneOffset() * 60000).toISOString().slice(0,16); };

/** Historical summaries have their own query and never evict the live, full-resolution readings. */
export function ExperimentHistory({experiment, pairings, projectId, deviceId, nowMs}: {
  experiment: PortalExperiment; pairings: readonly PairingRow[]; projectId: string; deviceId: string; nowMs: number;
}) {
  const [open, setOpen] = useState(false);
  const [anchor] = useState(nowMs);
  const end = Math.min(anchor, experiment.endedAt ? Date.parse(experiment.endedAt) : anchor);
  const [startText, setStartText] = useState(localInput(experiment.startedAt ? Date.parse(experiment.startedAt) : end - 14 * day));
  const [endText, setEndText] = useState(localInput(end));
  const [window, setWindow] = useState<{startMs: number; endMs: number} | null>(null);
  const [buckets, setBuckets] = useState<PotBucket[]>([]);
  const [bucketMs, setBucketMs] = useState(3600000);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [measure, setMeasure] = useState<Measure>("vwc");
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const [revision, setRevision] = useState(0);
  const apply = (startMs: number, endMs: number) => {
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) { setError("Choose an end after the start."); return; }
    setStartText(localInput(startMs)); setEndText(localInput(endMs)); setWindow({startMs,endMs}); setRevision((r) => r + 1);
  };
  useEffect(() => {
    if (!open || !window) return;
    let active = true;
    setLoading(true); setError(null);
    // Bound each plot to about 600 points per pot. Raw exports use a separate paged reader.
    const size = Math.min(7 * day, Math.max(60000, Math.ceil((window.endMs - window.startMs) / 600 / 60000) * 60000));
    const run = async () => {
      const {result,aliases}=await loadExperimentHistory({experiment,projectId,deviceId,startMs:window.startMs,endMs:window.endMs,bucketMs:size});
      // Combine old labels only when immutable sensor identities establish a rename.
      const merged = new Map<string,PotBucket>();
      for (const row of result) {
        const name = aliases.get(row.pairingName) ?? row.pairingName, key = `${name}:${row.startMs}`;
        const previous = merged.get(key);
        if (!previous) { merged.set(key,{...row,pairingName:name}); continue; }
        const count = previous.readings + row.readings;
        for (const metric of ["vwc","raw","temperature","ec"] as const) {
          const a=previous.values[metric], b=row.values[metric];
          previous.values[metric] = a == null ? b : b == null ? a : (a*previous.readings+b*row.readings)/count;
        }
        previous.readings=count;
      }
      if (active) {setBuckets([...merged.values()]);setBucketMs(size);}
    };
    void run().catch((failure) => {if(active){setBuckets([]);setError(failure instanceof Error ? failure.message : "History could not be loaded.");}}).finally(()=>{if(active)setLoading(false);});
    return () => {active=false;};
  }, [deviceId,experiment,open,projectId,revision,window]);
  const lines = useMemo(() => pairings.filter((p)=>!hidden.has(p.name)).map((p):ChartLine => {
    const rows=buckets.filter((b)=>b.pairingName===p.name && b.values[measure]!=null).sort((a,b)=>a.startMs-b.startMs);
    const segments: ChartLine["segments"]=[];
    for (const row of rows) {
      const point={timestampMs:row.startMs,value:row.values[measure]!}, last=segments.at(-1);
      if(!last || point.timestampMs-last.at(-1)!.timestampMs>bucketMs*1.5) segments.push([point]); else last.push(point);
    }
    return {id:p.name,label:`Pot ${p.pot_number}`,color:colorForPairing(p),segments};
  }),[buckets,bucketMs,hidden,measure,pairings]);
  const values=lines.flatMap((line)=>line.segments.flatMap((segment)=>segment.map((p)=>p.value)));
  const low=values.reduce((a,b)=>Math.min(a,b),Infinity), high=values.reduce((a,b)=>Math.max(a,b),-Infinity);
  const pad=Math.max(1,(high-low)*.1);
  const units={vwc:"VWC %",raw:"Raw sensor output",temperature:"Temperature · sensor units",ec:"EC · sensor units"};
  return <details className="px-card px-history-range" open={open} onToggle={(event)=>{const next=event.currentTarget.open;setOpen(next);if(next&&!window)apply(experiment.startedAt?Date.parse(experiment.startedAt):end-14*day,end);}}>
    <summary>Explore experiment history</summary>
    {open ? <>
      <form className="px-history-toolbar" onSubmit={(event)=>{event.preventDefault();apply(Date.parse(startText),Date.parse(endText));}}>
        <label>Start (local time)<input type="datetime-local" required value={startText} onChange={(e)=>setStartText(e.target.value)}/></label>
        <label>End (local time)<input type="datetime-local" required value={endText} onChange={(e)=>setEndText(e.target.value)}/></label>
        <button className="px-button is-primary" type="submit" disabled={loading}>Load history</button>
        {experiment.startedAt ? <button className="px-button" type="button" disabled={loading} onClick={()=>apply(Date.parse(experiment.startedAt!),end)}>Entire experiment</button> : null}
        <button className="px-button" type="button" disabled={loading} onClick={()=>apply(Math.max(end-14*day,experiment.startedAt?Date.parse(experiment.startedAt):-Infinity),end)}>Last 14 days</button>
        <label>Measure<select value={measure} onChange={(e)=>setMeasure(e.target.value as Measure)}>{Object.entries(units).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
      </form>
      {loading ? <p role="status">Loading stored history… Recent traces remain available below.</p> : error ? <p className="px-notice is-bad" role="alert">{error} <button className="px-button is-small" onClick={()=>setRevision(r=>r+1)}>Retry</button></p> : <>
        <p className="px-muted px-small">{buckets.reduce((n,b)=>n+b.readings,0).toLocaleString()} stored readings · {Math.round(bucketMs/60000)}-minute averages · gaps are preserved. Use Export for full-resolution measurements.</p>
        <div className="px-history-layout">
          <div>{!values.length ? <p className="px-empty" role="status">{hidden.size===pairings.length ? "Select a pot to show its history." : "No readings in this range."}</p> : window ? <TimeSeriesChart lines={lines} domain={window} yDomain={[low-pad,high+pad]} height={420} responsive ariaLabel={`Experiment history, ${units[measure]}`} description="Stored readings averaged within the stated time buckets. Arrow keys inspect bucket means. Exports retain original readings." readout={(at)=>({title:new Date(at).toLocaleString(),rows:lines.flatMap((line)=>{const points=line.segments.flat();const point=points.find((p)=>p.timestampMs<=at&&at<p.timestampMs+bucketMs);return point?[{label:line.label,value:`${point.value.toFixed(2)} mean`}]:[]}).slice(0,10)})}/> : null}</div>
          <aside className="px-history-pots"><div className="px-toolbar"><button className="px-button is-small" onClick={()=>setHidden(new Set())}>Show all</button><button className="px-button is-small" onClick={()=>setHidden(new Set(pairings.map(p=>p.name)))}>Hide all</button></div>{pairings.map(p=><label key={p.name}><input type="checkbox" checked={!hidden.has(p.name)} onChange={()=>setHidden(current=>{const next=new Set(current);if(next.has(p.name))next.delete(p.name);else next.add(p.name);return next;})}/><span style={{color:colorForPairing(p)}}>●</span> Pot {p.pot_number}</label>)}</aside>
        </div>
      </>}
    </> : null}
  </details>;
}
