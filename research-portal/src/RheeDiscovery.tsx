import { useEffect, useState } from "react";
import { supabase } from "./supabase";
import { functionErrorMessage } from "./portalFormat";
import { PortalLink } from "./product/PortalLink";

export type DiscoveryChoice = { pot: number; group: string; target: number | null };
export type DiscoverySetup = {name: string; mode: "calibration" | "controlled"; curve: string; pots: DiscoveryChoice[]; existing?: DiscoveryChoice[]};
export type DiscoveryRun = {id: string; owner: boolean; status: string; setup: DiscoverySetup; phase: string; message: string; finished: number; matches: {pot:number;name:string;sensorKey:string;valveKey:string;delta:number}[]; missing:number[]};
export async function discoveryRequest(action: string, body: Record<string,unknown> = {}) {
  const {data,error}=await supabase.functions.invoke<{run:DiscoveryRun|null}>("rhee-discovery",{body:{action,...body}});
  if(error)throw Error(await functionErrorMessage(error));
  return data?.run ?? null;
}
export function DiscoveryTile() {
  const [run,setRun]=useState<DiscoveryRun|null>(null);
  useEffect(()=>{
    let mounted=true;
    const load=()=>void discoveryRequest("status").then(value=>{if(mounted)setRun(value)}).catch(()=>{});
    load();const timer=window.setInterval(load,15000);
    return ()=>{mounted=false;window.clearInterval(timer)};
  },[]);
  if(!run)return null;
  return <div className="px-system-card"><PortalLink className="px-system-tile" to={{view:"new-experiment"}}>
    <strong>{run.setup.name}</strong><span>Autopair · {run.finished}/{run.setup.pots.length} pots</span>
    <span>{run.message}</span></PortalLink></div>;
}
export function DiscoveryPanel({run,busy,onAction,onUse}:{run:DiscoveryRun;busy:boolean;onAction:(action:string)=>void;onUse:()=>void}) {
  return <section className="settings-card ac-step" aria-label="Experiment Autopair">
    <h3>{run.setup.name} · Autopair</h3><p>{run.setup.curve} · {run.setup.pots.length} pots</p>
    <p role="status">{run.message}</p>
    {run.status==="running"&&<p>Keep this page open while Autopair reads the probes. You can return here from the home screen.</p>}
    {run.matches.length>0&&<details><summary>{run.matches.length} measured matches</summary><ul>
      {run.matches.map(m=><li key={m.pot}>Pot {m.pot} · {m.sensorKey} · +{m.delta.toFixed(2)}% VWC</li>)}</ul></details>}
    {run.missing.length>0&&<p>Unmatched pots: {run.missing.join(", ")}</p>}
    {run.owner && run.status==="review" && run.matches.length===run.setup.pots.length && !run.missing.length && <>
      <p>Saving briefly pauses the controller, installs these sensor pairings and the soil curve, then restores its running state.</p>
      <button type="button" className="is-primary" disabled={busy} onClick={()=>onAction("apply")}>Save matches and apply curve</button></>}
    {run.owner && run.status==="ready" && <button type="button" className="is-primary" disabled={busy} onClick={onUse}>Continue to create experiment</button>}
    {run.owner && run.status!=="applying" && run.status!=="ready" && <button type="button" className="xb-link" disabled={busy} onClick={()=>onAction("close")}>{run.status==="running"?"Stop discovery":"Close discovery"}</button>}
  </section>;
}
