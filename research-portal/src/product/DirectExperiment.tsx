import { useEffect, useRef, useState, type ReactNode } from 'react';
import { launchExperiment, preflightExperiment } from '../experimentClient';
import { experimentDraftFromPortalExperiment, type ExperimentDraft } from '../experimentSpec';
import type { PortalExperiment } from '../experimentRegistry';
import type { ChartTargetLine } from '../portalTypes';
import type { PairingRow } from '../types';
import { readDirectCommands } from '../directExperimentClient';
import { commandOutcome, targetDraft } from './directExperimentModel';

export type DirectTarget = { value: number; label: string; onChange: (value: number) => void; disabled: boolean };
export type DirectChartState = { target?: DirectTarget; affected: Set<string>; groups: boolean; lines: ChartTargetLine[] };
export function DirectExperiment({experiment, pairings, projectId, inventoryUpdatedAt, canEdit, demo, onRefresh, children}: {
  experiment: PortalExperiment; pairings: PairingRow[]; projectId: string; inventoryUpdatedAt: string | null;
  canEdit: boolean; demo: boolean; onRefresh: () => Promise<unknown>; children: (state: DirectChartState) => ReactNode;
}) {
  const [demoTargets,setDemoTargets] = useState<Record<string,number>>({});
  const effectivePairings = demo ? pairings.map(p=>({...p,wtc_percent_limit:demoTargets[p.name] ?? p.wtc_percent_limit})) : pairings;
  const [scope, setScope] = useState('all');
  const [custom, setCustom] = useState<string[]>([]);
  const [preview, setPreview] = useState<number | null>(null);
  const [groups, setGroups] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [field, setField] = useState<'name' | 'crop' | 'treatment' | null>(null);
  const [text, setText] = useState('');
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => {mounted.current = false;}; }, []);
  const crops = [...new Set(experiment.assignments?.map(a => a.crop).filter((s): s is string => Boolean(s)) ?? [])];
  const names = scope === 'all' ? experiment.pairingNames : scope === 'custom' ? custom : experiment.assignments?.filter(a => a.crop === scope.slice(5)).map(a => a.pairing_name) ?? [];
  const affected = new Set(names);
  const label = scope === 'all' ? 'All pots' : scope === 'custom' ? 'Selected pots' : scope.slice(5);
  const values = [...new Set(effectivePairings.filter(p => affected.has(p.name)).map(p => p.wtc_percent_limit).filter(n => n >= 0))];
  const value = preview ?? (values.length === 1 ? values[0] : null);
  const byTarget = new Map<number,string[]>();
  for (const p of effectivePairings) {if(p.wtc_percent_limit<0 || p.valve_open_time_ms<=0)continue;const crop=experiment.assignments?.find(a=>a.pairing_name===p.name)?.crop || `Pot ${p.pot_number}`;byTarget.set(p.wtc_percent_limit,[...new Set([...(byTarget.get(p.wtc_percent_limit)??[]),crop])]);}
  const lines:ChartTargetLine[] = (experiment.mode==='controlled' && !['completed','archived'].includes(experiment.status??'') ? [...byTarget] : []).map(([value,crops])=>({value,label:`${byTarget.size===1?'All pots':crops.join(' / ')} · ${value}% target`,tone:'neutral'}));
  const editable = (canEdit || demo) && experiment.mode === 'controlled' && (experiment.status === 'active' || demo);
  const change = (n: number) => { if (!busy && Number.isFinite(n)) {setPreview(Math.max(0, Math.min(80, Math.round(n))));setStatus('');setError('');} };
  async function save(draft: ExperimentDraft, control: boolean) {
    if (busy) return;
    setBusy(true);setError('');setStatus(control ? 'Checking controller…' : 'Saving…');
    try {
      if (demo) {setDemoTargets(Object.fromEntries(draft.assignments.filter(a=>a.target_vwc_percent!==null).map(a=>[a.pairing_name,a.target_vwc_percent!])));setPreview(null);setStatus('Demo applied · no equipment changed');setBusy(false);return;}
      if (!canEdit || !inventoryUpdatedAt || !experiment.databaseId || !experiment.currentRevisionId) throw new Error('Refresh this experiment before making changes.');
      const checked = await preflightExperiment({projectId,draft,inventoryUpdatedAt,experimentId:experiment.databaseId,expectedRevisionId:experiment.currentRevisionId});
      // An inline edit must never widen the reviewed scope or change other controls.
      if (!control && checked.plan.change_count) throw new Error('This edit would change controller settings. Use the full experiment editor.');
      if (control && checked.plan.changes.some(c => c.pairing_names.some(n => !affected.has(n)))) throw new Error('Other pots changed since this view loaded. Refresh and try again.');
      setStatus(control ? 'Sending…' : 'Saving…');
      const result = await launchExperiment({projectId,draft:checked.draft,inventoryUpdatedAt:checked.inventory_updated_at,source:'manual',model:null,promptFingerprint:null,reviewedConfigHash:checked.config_hash,experimentId:experiment.databaseId,expectedRevisionId:experiment.currentRevisionId});
      if (!control || !result.command_ids.length) {setStatus(control ? 'Already at this target' : 'Saved');}
      else {
        setStatus('Waiting for controller…');
        let confirmed = false;
        for (let attempt=0; attempt<60 && mounted.current; attempt++) {
          await new Promise(resolve => setTimeout(resolve, 2000));
          const rows = await readDirectCommands(projectId,result.command_ids).catch(()=>[]);
          const outcome = commandOutcome(result.command_ids, rows);
          if (outcome === 'failed') throw new Error('Controller change did not complete. Review the experiment record before retrying.');
          if (outcome === 'applied') {confirmed=true;break;}
        }
        setStatus(confirmed ? 'Applied · controller confirmed' : 'Still awaiting confirmation · check Record before making another change');
      }
      await onRefresh();setPreview(null);setField(null);if(!control && field==='crop')setScope('all');
    } catch (e) {setError(e instanceof Error ? e.message : 'Could not save.');setStatus('');await onRefresh();}
    finally {if(mounted.current)setBusy(false);}
  }
  return <>
    <section className="px-direct-tools" aria-label="Experiment controls">
      <div className="px-direct-row">
        <button className="px-inline-name" disabled={!canEdit || busy} title="Rename experiment" onClick={() => {setField('name');setText(experiment.name);}}>{experiment.name}<span aria-hidden="true"> ✎</span></button>
        <div className="chart-view-toggle" aria-label="Plant view"><button aria-pressed={!groups} className={!groups?'is-selected':''} onClick={()=>setGroups(false)}>Individual</button><button aria-pressed={groups} className={groups?'is-selected':''} onClick={()=>setGroups(true)}>Groups</button></div>
      </div>
      <div className="px-direct-row">
        <label>Change target for <select aria-label="Target scope" disabled={busy || preview !== null} value={scope} onChange={e=>{setScope(e.target.value);setPreview(null);setField(null);setError('');}}><option value="all">All {experiment.pairingNames.length} pots</option>{crops.map(c=><option key={c} value={'crop:'+c}>{c}</option>)}<option value="custom">Choose pots…</option></select></label>
        <span className="px-scope-count">{names.length} pots · independent of hidden traces</span>
        {editable ? <label>Target <input aria-label="Target percent" type="number" min="0" max="80" step="1" value={value ?? ''} placeholder="Mixed" disabled={busy || !names.length} onChange={e=>{if(e.target.value!=='')change(Number(e.target.value));}} /> %</label> : <span>Targets are read-only</span>}
        {canEdit ? <><button className="px-button is-small" disabled={busy || !names.length} onClick={()=>{setField('crop');setText(scope.startsWith('crop:')?scope.slice(5):'');}}>Crop: {scope.startsWith('crop:')?scope.slice(5):'Multiple'} ✎</button><button className="px-button is-small" disabled={busy || !names.length} onClick={()=>{setField('treatment');setText('');}}>Treatment ✎</button></> : null}
      </div>
      {scope==='custom' ? <div className="px-pot-choices">{pairings.map(p=><label key={p.name}><input type="checkbox" disabled={busy || preview!==null} checked={custom.includes(p.name)} onChange={e=>setCustom(old=>e.target.checked?[...old,p.name]:old.filter(n=>n!==p.name))}/>Pot {p.pot_number}</label>)}</div>:null}
      {preview!==null ? <div className="px-change-review" role="status"><strong>{label} · {names.length} pots: {values.join(' / ')}% → {preview}%</strong><span>Watering resumes below the target.</span><button className="px-button is-primary" disabled={busy || !names.length} onClick={()=>{try {void save(targetDraft(experiment,effectivePairings,names,preview),true);}catch(e){setError((e as Error).message);}}}>Apply</button><button className="px-button" disabled={busy} onClick={()=>{setPreview(null);setError('');}}>Cancel</button></div>:null}
      {field ? <form className="px-change-review" onSubmit={e=>{e.preventDefault();const d=experimentDraftFromPortalExperiment(experiment,pairings);d.controller_changes_requested=false;if(field==='name')d.name=text.trim();else d.assignments=d.assignments.map(a=>affected.has(a.pairing_name)?{...a,[field]:text.trim()||null}:a);void save(d,false);}}><label>{field==='name'?'Experiment name':`${label} ${field}`} <input autoFocus maxLength={field==='name'?120:80} value={text} onChange={e=>setText(e.target.value)} /></label><button className="px-button" disabled={busy || (field==='name'&&!text.trim())}>Save</button><button type="button" className="px-button" disabled={busy} onClick={()=>setField(null)}>Cancel</button></form>:null}
      {status ? <p role="status">{status}</p>:null}{error?<p className="px-notice is-bad" role="alert">{error}</p>:null}
    </section>
    {children({target:editable && names.length && value!==null ? {value,label:`${label} · ${names.length} pots`,onChange:change,disabled:busy}:undefined,affected:scope!=='all'||preview!==null?affected:new Set(),groups,lines})}
  </>;
}
