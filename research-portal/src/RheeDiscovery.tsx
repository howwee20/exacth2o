import { useEffect, useState } from "react";
import { supabase } from "./supabase";
import { functionErrorMessage } from "./portalFormat";
import { scheduleVisiblePolling } from "./visiblePolling";
import { PortalLink } from "./product/PortalLink";

export type DiscoveryChoice = { pot: number; group: string; target: number | null };
export type DiscoverySetup = {name: string; mode: "calibration" | "controlled"; curve: string; pots: DiscoveryChoice[]; existing?: DiscoveryChoice[]};
type Rise = {key:string; delta:number; rawDelta:number};
export type DiscoveryRun = {id:string; owner:boolean; canClose?:boolean; status:string; setup:DiscoverySetup; phase:string; message:string; finished:number; pot?:number; updatedAt?:string; workerVersion?:number; preview?:Rise[]; evidence?:Record<string,{rises:Rise[]; reason:string}>; matches:{pot:number;name:string;sensorKey:string;valveKey:string;delta:number}[]; missing:number[]};
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
  return ({baseline:'Reading baseline',pulse:'Preparing pulse',receipt:'Waiting for controller',observe:'Watching moisture'} as Record<string,string>)[run.phase]??'Autopair';
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
  return <PortalLink className="px-study-tile" to={{view:'new-experiment'}} extra={{discovery:run.id,...(projectId?{project:projectId}:{})}} reloadDocument={Boolean(projectId)}><span><span className="px-study-caption">Autopair setup</span><strong>{run.setup.name}</strong><span className="px-study-progress">{stateLabel(run)} · {run.finished}/{run.setup.pots.length} pots</span></span></PortalLink>;
}
function RiseList({rises}:{rises:Rise[]}) {
  return <ol>{rises.map(r=><li key={r.key}>{r.key} · +{r.delta.toLocaleString(undefined,{maximumFractionDigits:4})} VWC points</li>)}</ol>;
}
export function DiscoveryPanel({run,busy,onAction,onUse,onEdit}:{run:DiscoveryRun;busy:boolean;onAction?:(action:string)=>void;onUse?:()=>void;onEdit?:()=>void}) {
  const [confirmClose,setConfirmClose]=useState(false);
  const working=run.status==='running'||run.status==='applying';
  return <section className="settings-card xb-discovery" aria-label="Experiment Autopair">
    <h3>{run.setup.name} · Autopair</h3><span>{run.setup.curve} · {run.setup.pots.length} pots</span>
    <strong>{stateLabel(run)}{working&&run.pot?` · Pot ${run.pot}`:''}</strong><p role="status">{run.message}</p>
    <progress value={run.finished} max={run.setup.pots.length} aria-label="Pots checked"/><span>{run.finished} of {run.setup.pots.length} checked · {run.matches.length} matched</span>
    {run.updatedAt&&<span>Last update {new Date(run.updatedAt).toLocaleTimeString()}</span>}
    {run.status==='running'&&run.workerVersion===2&&<p>You can lock your phone. Reopen this setup from the machine to see progress.</p>}
    {!!run.preview?.length&&<details open><summary>Current sensor rises</summary><RiseList rises={run.preview}/></details>}
    {Object.entries(run.evidence??{}).map(([pot,result])=><details key={pot}><summary>Pot {pot} · {result.reason}{result.rises[0]?` · ${result.rises[0].key}`:''}</summary>{result.rises.length>0&&<RiseList rises={result.rises}/>}</details>)}
    {run.matches.length>0&&<details><summary>{run.matches.length} measured matches</summary><ul>{run.matches.map(m=><li key={m.pot}>Pot {m.pot} · {m.sensorKey} · +{m.delta.toFixed(3)} VWC points</li>)}</ul></details>}
    {run.missing.length>0&&<p>Unresolved pots · {run.missing.join(', ')}</p>}
    {onAction&&run.owner&&run.status==='review'&&run.workerVersion===2&&run.missing.length>0&&<button type="button" className="is-primary" disabled={busy} onClick={()=>onAction('retry')}>Retry unresolved pots · 3 seconds per outlet</button>}
    {onAction&&run.owner&&run.status==='review'&&run.matches.length===run.setup.pots.length&&!run.missing.length&&<><p>Saving briefly pauses the controller to install the pairings and soil curve.</p><button type="button" className="is-primary" disabled={busy} onClick={()=>onAction('apply')}>Save matches and apply curve</button></>}
    {onUse&&run.owner&&run.status==='ready'&&<button type="button" className="is-primary" disabled={busy} onClick={onUse}>Continue to create experiment</button>}
    {onEdit&&(run.owner||run.canClose)&&run.status==='review'&&<button type="button" disabled={busy} onClick={onEdit}>Return to saved setup</button>}
    {onAction&&(run.owner||run.canClose)&&run.status==='running'&&<button type="button" disabled={busy} onClick={()=>onAction('stop')}>Stop Autopair</button>}
    {onAction&&(run.owner||run.canClose)&&['review','ready'].includes(run.status)&&<button type="button" disabled={busy} onClick={()=>{if(confirmClose)onAction('close');else setConfirmClose(true)}}>{confirmClose?'Confirm close setup':'Close setup'}</button>}
  </section>;
}

export function DiscoveryStatus({id}:{id:string}) {
  const [run,setRun]=useState<DiscoveryRun|null>(null);
  const [message,setMessage]=useState('Loading Autopair…');
  useEffect(()=>{
    let active=true;
    const refresh=()=>discoveryRequest('status').then(next=>{
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
