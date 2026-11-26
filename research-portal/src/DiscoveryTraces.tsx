import { useEffect, useState } from "react";
import { TimeSeriesChart, type ChartLine } from "./product/TimeSeriesChart";
import { supabase } from "./supabase";
import { functionErrorMessage } from "./portalFormat";
import type { DiscoveryRun } from "./RheeDiscovery";
import "./discovery-traces.css";

type Sample = { t: number; raw?: number; v: number };
type Series = Record<string, Sample[]>;
export type DiscoveryTrace = {
  pot: number; seconds: number; command: string; before: Series; after: Series;
  queuedAt: number; openedAt?: number; acknowledgedAt?: number;
};
type Unit = "raw" | "v";
const palette = ["#087451", "#3669ae", "#aa6415", "#855aaa", "#487680", "#a74868"];
const fmt = (v: number, unit: Unit) => v.toLocaleString(undefined, { maximumFractionDigits: unit === "raw" ? 2 : 4 });
const signed = (v: number, unit: Unit) => (v > 0 ? "+" : "") + fmt(v, unit);
const clock = (ms: number) => new Date(ms).toLocaleTimeString([], {hour: "numeric", minute: "2-digit", second: "2-digit"});
const address = (key: string) => key.slice(key.lastIndexOf(":") + 1);
function median(values: number[]) {
  const s = [...values].sort((a,b) => a-b);
  return s.length ? (s[Math.floor((s.length-1)/2)] + s[Math.floor(s.length/2)]) / 2 : undefined;
}
function points(samples: Sample[], unit: Unit) {
  return samples.flatMap(s => {
    const value = s[unit];
    return typeof value === "number" && Number.isFinite(value) ? [{timestampMs:s.t, value}] : [];
  });
}
function Spark({values, extent}:{values:number[]; extent:number}) {
  const x = (i:number) => 4 + 72*i/Math.max(1,values.length-1);
  const y = (v:number) => 13 - v/extent*10;
  return <svg className="dt-spark" viewBox="0 0 80 26" aria-hidden="true">
    <path d="M2 13H78" stroke="#d7dfdb" strokeDasharray="2 3"/>
    <polyline fill="none" stroke="currentColor" strokeWidth="1.7" points={values.map((v,i)=>x(i)+","+y(v)).join(" ")}/>
    {values.map((v,i)=><circle key={i} cx={x(i)} cy={y(v)} r="1.7" fill="currentColor"/>)}
  </svg>;
}
function ResponsePlot({trace,match,live}:{trace:DiscoveryTrace;match?:string;live:boolean}) {
  const [unit,setUnit]=useState<Unit>("raw");
  const [focus,setFocus]=useState("");
  const rows=Array.from(new Set([...Object.keys(trace.before),...Object.keys(trace.after)])).flatMap(key=>{
    const pre=points(trace.before[key]??[],unit), post=points(trace.after[key]??[],unit);
    const base=median(pre.map(s=>s.value));
    if(base===undefined)return [];
    const postMedian=median(post.map(s=>s.value));
    const all=[...pre,...post].sort((a,b)=>a.timestampMs-b.timestampMs);
    return [{key,base,postCount:post.length,delta:postMedian===undefined?undefined:postMedian-base,
      latest:all[all.length-1],points:all.map(p=>({...p,value:p.value-base}))}];
  }).sort((a,b)=>Number(b.key===match)-Number(a.key===match) || (b.delta??-Infinity)-(a.delta??-Infinity) || a.key.localeCompare(b.key));
  const selected=rows.find(r=>r.key===focus);
  const plotted=selected?[selected]:rows.slice(0,4);
  const lines:ChartLine[]=plotted.map((r,i)=>({id:r.key,label:r.key,color:palette[i],segments:[r.points]}));
  const marker=trace.openedAt || trace.queuedAt;
  const times=rows.flatMap(r=>r.points.map(p=>p.timestampMs));
  if(marker)times.push(marker,marker+trace.seconds*1000);
  const lo=times.length?Math.min(...times):0, hi=times.length?Math.max(...times):0;
  const pad=Math.max(1000,(hi-lo)*.025);
  const ys=plotted.flatMap(r=>r.points.map(p=>p.value));
  const low=Math.min(0,...ys), high=Math.max(0,...ys);
  const yPad=Math.max((high-low)*.12,unit==="raw"?.05:.001);
  const extent=Math.max(yPad,...rows.flatMap(r=>r.points.map(p=>Math.abs(p.value))));
  const hasPost=rows.some(r=>r.postCount>0);
  return <>
    <section className="dt-card">
      <div className="dt-heading"><div><h4>Sensor response</h4><p>Change from each sensor’s median baseline</p></div>
        <div className="dt-units" aria-label="Graph units">{(["raw","v"] as const).map(u=><button type="button" key={u} aria-pressed={unit===u} onClick={()=>setUnit(u)}>{u==="raw"?"Raw counts":"VWC points"}</button>)}</div>
      </div>
      <label className="dt-picker">Show <select value={selected?.key??""} onChange={e=>setFocus(e.target.value)}>
        <option value="">{hasPost?"Leading responses":"Baseline traces"} (up to 4)</option>
        {rows.map(r=><option key={r.key} value={r.key}>{r.key}{r.key===match?" · Matched":""}</option>)}
      </select></label>
      {rows.length ? <TimeSeriesChart lines={lines} domain={{startMs:lo-pad,endMs:hi+pad}} yDomain={[low-yPad,high+yPad]} height={216}
        targets={[{value:0,label:"Baseline",color:"#87948b"}]} ticks={marker?[{timestampMs:marker}]:[]}
        shades={marker?[{startMs:marker,endMs:marker+trace.seconds*1000,label:"Pulse"}]:[]}
        ariaLabel={`Pot ${trace.pot} sensor change in ${unit==="raw"?"raw counts":"VWC points"}`}
        readout={t=>({title:clock(t),rows:plotted.map(r=>{
          const p=r.points.reduce((a,b)=>Math.abs(a.timestampMs-t)<=Math.abs(b.timestampMs-t)?a:b);
          return {label:r.key,value:signed(p.value,unit)+" · "+clock(p.timestampMs)};
        })})}/> : <p className="dt-empty">Waiting for the first baseline reading.</p>}
      <div className="dt-legend">{plotted.map((r,i)=><span key={r.key}><i style={{background:palette[i]}}/>{r.key}{r.key===match?" · Matched":""}</span>)}</div>
      {!!marker&&<p className="dt-pulse">{trace.openedAt?"Valve opened":"Pulse requested"} at {clock(marker)} · {trace.seconds} seconds</p>}
    </section>
    <section className="dt-card"><div className="dt-heading"><div><h4>Probe readings</h4><p>{rows.length} responding · {unit==="raw"?"Raw counts":"VWC %"}</p></div>
      {live&&<span className="dt-live">Live</span>}</div>
      <div className="dt-readings">
        <div className="dt-row dt-columns"><span>Sensor</span><span>Baseline</span><span>Latest</span><span>Median rise</span><span>Trace</span></div>
        {rows.map(r=><button type="button" className="dt-row" key={r.key} aria-pressed={selected?.key===r.key} title={'Show '+r.key+' on the graph'} onClick={()=>setFocus(focus===r.key?"":r.key)}>
          <span className="dt-identity"><b>{address(r.key)}</b><small>{r.key.slice(0,r.key.lastIndexOf(":"))}{r.key===match?" · Matched":""}</small></span>
          <span>{fmt(r.base,unit)}</span><span>{fmt(r.latest.value,unit)}</span><strong>{r.delta===undefined?"—":signed(r.delta,unit)}</strong>
          <Spark values={r.points.map(p=>p.value)} extent={extent}/></button>)}
      </div>
    </section>
  </>;
}
export function DiscoveryTraces({run,busy,onSingle}:{run:DiscoveryRun;busy:boolean;onSingle?:(pot:number)=>void}) {
  const [confirm,setConfirm]=useState<number|null>(null);
  const [picked,setPicked]=useState<number|null>(null);
  const pot=picked??run.pot??run.lastPot??run.setup.pots[0]?.pot;
  const current=run.trace?.pot===pot?run.trace:null;
  const [saved,setSaved]=useState<{pot:number;trace:DiscoveryTrace|null;error?:string}|null>(null);
  const hasCurrent=!!current;
  useEffect(()=>{
    if(!pot||hasCurrent)return;
    let active=true;
    void (async()=>{
      const {data,error}=await supabase.functions.invoke<{trace:DiscoveryTrace|null}>("rhee-discovery",{body:{action:"trace",id:run.id,pot}});
      const problem=error?await functionErrorMessage(error):undefined;
      if(active)setSaved({pot,trace:data?.trace??null,error:problem});
    })().catch(()=>{if(active)setSaved({pot,trace:null,error:"Could not load the saved readings."})});
    return ()=>{active=false};
  },[run.id,pot,hasCurrent,run.status]);
  const trace=current??(saved?.pot===pot?saved.trace:null);
  const match=run.matches.find(m=>m.pot===pot);
  const evidence=run.evidence?.[pot];
  const active=run.status==="running"&&run.pot===pot;
  const phase=active?run.phase:"";
  const step=active?({baseline:0,pulse:1,receipt:1,soak:2,observe:2}[phase]??0):match||evidence?3:-1;
  const state=match?"Matched":active?"In progress":evidence?"Unresolved":trace?.queuedAt?"Stopped":"Pending";
  return <div className="dt-workspace">
    {run.matches.length>0&&<div className="dt-matches"><strong>Matched probes</strong>{run.matches.map(m=><button type="button" key={m.pot} onClick={()=>setPicked(m.pot)}>Pot {m.pot} · {m.sensorKey} · {signed(m.delta,"v")} VWC points</button>)}</div>}
    <nav className="dt-pots" aria-label="Calibration pots">{run.setup.pots.map(p=>{
      const matched=run.matches.some(m=>m.pot===p.pot);
      const running=run.status==="running"&&run.pot===p.pot;
      const result=matched?"matched":running?"running":run.evidence?.[p.pot]?"unresolved":"pending";
      return <button type="button" key={p.pot} aria-label={`Pot ${p.pot}, ${result}`} aria-pressed={p.pot===pot} className={'dt-pot '+result} onClick={()=>{setPicked(p.pot);setConfirm(null)}}><i/>{p.pot}</button>;
    })}</nav>
    <div className="dt-pot-title"><h3>Pot {pot}</h3><span>{match?state+" · "+match.sensorKey:state}</span>
      {picked!==null&&run.status==="running"&&<button type="button" onClick={()=>setPicked(null)}>Follow active pot</button>}</div>
    <ol className="dt-pipeline" aria-label="Pairing stages">{["Baseline","Valve pulse","Watch rise","Match"].map((v,i)=><li key={v} data-state={i===step?"current":i<step?"done":"waiting"} aria-current={i===step?"step":undefined}><i/>{v}</li>)}</ol>
    {trace?<ResponsePlot key={pot} trace={trace} match={match?.sensorKey} live={active}/>:<section className="dt-card"><h4>Sensor response</h4>
      {saved?.pot===pot&&saved.error?<p role="alert">{saved.error}</p>:evidence?<><p>{evidence.reason}. This earlier pass saved the rises below without their sample timestamps.</p>
        <ul className="dt-old-rises">{evidence.rises.map(r=><li key={r.key}><b>{r.key}</b><span>{signed(r.rawDelta,"raw")} counts</span></li>)}</ul></>:<p>{saved?.pot===pot?"Readings will appear here when this pot is sampled.":"Loading readings…"}</p>}
    </section>}
    {match&&<p className="dt-result"><b>Matched {match.sensorKey}</b> · {signed(match.delta,"v")} VWC points</p>}
    {!match&&evidence&&trace&&!active&&<p className="dt-result">{evidence.reason}</p>}
    {onSingle&&run.status==="review"&&!match&&!run.unconfirmed?.some(u=>u.pot===pot)&&<div className="dt-test-action">
      <button type="button" className="is-secondary" disabled={busy} onClick={()=>{
        if(confirm===pot){setConfirm(null);onSingle(pot)}else setConfirm(pot);
      }}>{confirm===pot?`Confirm 10-second pulse on pot ${pot} after baseline`:`Test pot ${pot} only · 10 seconds`}</button>
      {confirm===pot&&<button type="button" disabled={busy} onClick={()=>setConfirm(null)}>Cancel</button>}
    </div>}
  </div>;
}
