import { DiscoveryTraces, type DiscoveryTrace } from "./DiscoveryTraces";
import { ArrowRight } from "lucide-react";
import { useEffect, useState } from "react";
import { supabase } from "./supabase";
import { functionErrorMessage } from "./portalFormat";
import { scheduleVisiblePolling } from "./visiblePolling";
import { PortalLink } from "./product/PortalLink";

export type DiscoveryChoice = { pot: number; group: string; target: number | null };
export type DiscoverySetup = {name: string; mode: "calibration" | "controlled"; curve: string; pots: DiscoveryChoice[]; existing?: DiscoveryChoice[]};
type Rise = {key:string; delta:number; rawDelta:number; score?:number};
type Scan = {pass:number; done:number; total:number; answering:number; readMs?:number; holdUntil?:number};
type Issue = {t:number; probe:string; phase:string; pass:number; pot?:number; reason:string};
type Unconfirmed = {pot:number; at:number; why:string};
export type DiscoveryRun = {singlePot?:number;lastPot?:number;trace?:DiscoveryTrace|null;id:string; owner:boolean; canClose?:boolean; status:string; setup:DiscoverySetup; phase:string; message:string; finished:number; pot?:number; scan?:Scan; soakUntil?:number; issues?:Issue[]; unconfirmed?:Unconfirmed[]; updatedAt?:string; workerVersion?:number; preview?:Rise[]; evidence?:Record<string,{rises:Rise[]; reason:string}>; matches:{pot:number;name:string;sensorKey:string;valveKey:string;delta:number}[]; missing:number[]};
export async function discoveryRequest(action:string,body:Record<string,unknown>={}) {
  const {data,error}=await supabase.functions.invoke<{run:DiscoveryRun|null}>("rhee-discovery",{body:{action,...body}});
  if(error)throw Error(await functionErrorMessage(error));
  return data?.run??null;
}
function stateLabel(run:DiscoveryRun) {
  if(run.status==='review')return 'Needs review';
  if(run.status==='ready')return 'Ready to create';
  if(run.updatedAt && Date.now()-Date.parse(run.updatedAt)>120000)return 'Progress delayed';
  if(run.status==='applying')return 'Installing pairings';
  if(run.scan?.holdUntil && run.scan.holdUntil>Date.now())return 'Reader not answering · retrying';
  if(run.phase==='baseline' && run.scan && !run.finished && run.scan.total>run.scan.answering && run.scan.pass===1)return 'Finding probes';
  return ({baseline:'Reading baseline',pulse:'Opening valve',receipt:'Waiting for valve receipt',soak:'Water soaking in',observe:'Watching moisture'} as Record<string,string>)[run.phase]??'Autopair';
}
const clock=(t:number)=>new Date(t).toLocaleTimeString();
function scanLine(run:DiscoveryRun) {
  const s=run.scan;
  if(run.phase==='soak' && run.soakUntil)return `Reading probes again at ${clock(run.soakUntil)}`;
  if(!s || !['baseline','observe'].includes(run.phase))return '';
  const left=s.readMs?Math.ceil((s.total-s.done)*s.readMs/60000):0;
  return `${s.pass<=3?`Pass ${s.pass} of 3`:'Re-reading missed probes'} · ${s.done}/${s.total} probes · ${s.answering} answering${left?` · about ${left} min left in this pass`:''}`;
}
export function DiscoveryTile({projectId}:{projectId?:string}) {
  const [run,setRun]=useState<DiscoveryRun|null>(null);
  useEffect(()=>{
    let mounted=true;
    const load=()=>discoveryRequest('status').then(next=>{if(mounted)setRun(next)}).catch(()=>{});
    void load();
    const stop=scheduleVisiblePolling(load,10000);
    return ()=>{mounted=false;stop()};
  },[]);
  if(!run)return null;
  const progress=`${stateLabel(run)} · ${run.singlePot?`Pot ${run.singlePot} · 10 s test`:`${run.finished}/${run.setup.pots.length} pots`}`;
  return <PortalLink className="px-study-row is-setup" aria-label={`Autopair setup: ${run.setup.name}, ${progress}`} to={{view:'new-experiment'}} extra={{discovery:run.id,...(projectId?{project:projectId}:{})}} reloadDocument={Boolean(projectId)}>
    <span className="px-study-text"><strong>{run.setup.name}</strong><span className="px-study-note">Autopair · {['running','applying'].includes(run.status)?progress:stateLabel(run)}</span></span>
    <ArrowRight size={15} aria-hidden="true"/>
  </PortalLink>;
}
export function DiscoveryPanel({run,busy,onAction,onUse,onEdit}:{run:DiscoveryRun;busy:boolean;onAction?:(action:string,extra?:Record<string,unknown>)=>void;onUse?:()=>void;onEdit?:()=>void}) {
  const [confirmClose,setConfirmClose]=useState(false);
  const [confirmPulse,setConfirmPulse]=useState<number|null>(null);
  const held=new Set(run.unconfirmed?.map(u=>u.pot));
  const retryable=run.missing.filter(p=>!held.has(p));
  const working=run.status==='running'||run.status==='applying';
  return <section className="settings-card xb-discovery dt-board" aria-label="Experiment Autopair">
    <div className="dt-top"><div><h3>Autopair</h3><p>{run.setup.curve} · {run.setup.pots.length} pots · {run.matches.length} matched</p></div>
      {working?<span className="dt-live">{stateLabel(run)}</span>:<strong>{stateLabel(run)}</strong>}</div>
    <p role="status" className="dt-status">{run.message}{run.status==='running'&&run.phase==='soak'?' '+scanLine(run):''}
      {run.updatedAt&&<> · Updated {new Date(run.updatedAt).toLocaleTimeString()}</>}</p>
    {onAction&&(run.owner||run.canClose)&&run.status==='running'&&<button className="dt-stop" type="button" disabled={busy} onClick={()=>onAction('stop')}>Stop Autopair</button>}
    <DiscoveryTraces run={run} busy={busy} onSingle={onAction&&run.owner?(pot=>onAction('single',{pot})):undefined}/>
    {!!run.issues?.length&&<details><summary>{run.issues.length} probe read{run.issues.length>1?'s':''} skipped</summary><ul>{run.issues.map(i=><li key={i.t+i.probe}>{clock(i.t)} · {i.probe} · {i.phase} pass {i.pass}{i.pot?` · pot ${i.pot}`:''} · {i.reason}</li>)}</ul></details>}
    {run.missing.length>0&&<p>Awaiting a match · {run.missing.join(', ')}</p>}
    {run.unconfirmed?.map(u=><p key={u.pot} role="alert">Pot {u.pot} · pulse sent {clock(u.at)} was not confirmed ({u.why}). The valve may have opened, so Autopair will not pulse it again on its own.</p>)}
    {onAction&&run.owner&&run.status==='review'&&run.workerVersion===2&&retryable.length>0&&<button type="button" className="is-primary" disabled={busy} onClick={()=>onAction('retry')}>Retry {retryable.length} unresolved pot{retryable.length>1?'s':''} · 3 seconds per outlet</button>}
    {onAction&&run.owner&&run.status==='review'&&run.workerVersion===2&&run.unconfirmed?.map(u=><button key={u.pot} type="button" disabled={busy} onClick={()=>{if(confirmPulse===u.pot)onAction('retry',{repulse:[u.pot]});else setConfirmPulse(u.pot)}}>{confirmPulse===u.pot?`Confirm a second 3-second pulse on pot ${u.pot}`:`Pulse pot ${u.pot} again`}</button>)}
    {onAction&&run.owner&&run.status==='review'&&run.matches.length===run.setup.pots.length&&!run.missing.length&&<><p>Saving briefly pauses the controller to install the pairings and soil curve.</p><button type="button" className="is-primary" disabled={busy} onClick={()=>onAction('apply')}>Save matches and apply curve</button></>}
    {onUse&&run.owner&&run.status==='ready'&&<button type="button" className="is-primary" disabled={busy} onClick={onUse}>Continue to create experiment</button>}
    {onEdit&&(run.owner||run.canClose)&&run.status==='review'&&<button type="button" disabled={busy} onClick={onEdit}>Return to saved setup</button>}
    {onAction&&(run.owner||run.canClose)&&['review','ready'].includes(run.status)&&<button type="button" disabled={busy} onClick={()=>{if(confirmClose)onAction('close');else setConfirmClose(true)}}>{confirmClose?'Confirm close setup':'Close setup'}</button>}
  </section>;
}

export function DiscoveryStatus({id}:{id:string}) {
  const [run,setRun]=useState<DiscoveryRun|null>(null);
  const [message,setMessage]=useState('Loading Autopair…');
  useEffect(()=>{
    let active=true;
    const refresh=()=>discoveryRequest('status',{detail:true}).then(next=>{
      if(!active)return;
      setRun(next?.id===id?next:null);
      setMessage(next?.id===id?'':'This Autopair setup has closed.');
    }).catch(()=>{if(active)setMessage('Could not refresh Autopair. Reconnecting…')});
    void refresh();
    const stop=scheduleVisiblePolling(refresh,5000);
    return ()=>{active=false;stop()};
  },[id]);
  return <>{run&&<DiscoveryPanel run={run} busy={false}/>}
    {message&&<p role="status">{message}</p>}</>;
}
