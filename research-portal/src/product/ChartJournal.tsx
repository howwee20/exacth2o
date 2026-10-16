import { useEffect, useState } from 'react';
import { loadRecordSources } from '../recordClient';
import { noteItems, planItems, settingsItems, type RecordItem } from '../recordModel';
import type { PortalExperiment } from '../experimentRegistry';
import type { PairingRow } from '../types';
import type { useNoteOutbox } from './useNoteOutbox';
import { formatMeasurementTime } from '../measurementFreshness';
export function ChartJournal({experiment,projectId,deviceId,pairings,startMs,endMs,moment,onMoment,canWrite,outbox}: {
 experiment:PortalExperiment;projectId:string;deviceId:string;pairings:PairingRow[];startMs:number;endMs:number;moment:number|null;onMoment:(n:number|null)=>void;canWrite:boolean;outbox:ReturnType<typeof useNoteOutbox>;
}) {
 const [items,setItems]=useState<RecordItem[]>([]);const [problem,setProblem]=useState('');const [selected,setSelected]=useState<RecordItem|null>(null);
 const [pot,setPot]=useState(pairings[0]?.name??'');const [body,setBody]=useState('');const [saving,setSaving]=useState(false);const [message,setMessage]=useState('');
 const sent=outbox.entries.filter(e=>e.state==='sent').length;
 useEffect(()=>{let active=true;if(!experiment.databaseId)return;void loadRecordSources({projectId,deviceId,experimentDatabaseId:experiment.databaseId,pairingNames:experiment.pairingNames,pairingAssignments:experiment.assignments,startMs,endMs}).then(data=>{if(active){setItems([...planItems(data.revisions,data.audits,data.assignments),...settingsItems(data.commands,data.historyPairingNames,experiment.databaseId ?? null),...noteItems(data.notes)].filter(i=>i.happenedAt>=startMs&&i.happenedAt<=endMs).sort((a,b)=>a.happenedAt-b.happenedAt));setProblem(data.problems.join(' · '));}}).catch(()=>{if(active)setProblem('Experiment changes could not be loaded.');});return()=>{active=false;};},[projectId,deviceId,experiment,startMs,endMs,sent]);
 return <section className="px-chart-journal" aria-label="Changes and notes on the graph">
 <div className="px-direct-row"><strong>Changes & notes</strong><span>Click a marker to inspect it.</span>{canWrite?<button className="px-button is-small" onClick={()=>onMoment(endMs)}>Add note at a time…</button>:null}</div>
 <div className="px-event-lane">{items.map((item,index)=><button key={item.id} className="px-event-marker" style={{left:`${Math.max(1,Math.min(97,(item.happenedAt-startMs)/(endMs-startMs)*100))}%`,top:6+(index%3)*25}} aria-label={`${item.title} · ${formatMeasurementTime(item.happenedAt)}`} title={`${item.title} · ${formatMeasurementTime(item.happenedAt)}`} onClick={()=>setSelected(item)}>{item.kind==='note'?'●':'◆'}</button>)}{!items.length?<span className="px-muted">No recorded changes in this window.</span>:null}</div>
 {problem?<p role="status">{problem}</p>:null}
 {selected?<div className="px-change-review"><div><strong>{selected.title}</strong><p>{formatMeasurementTime(selected.happenedAt)} · {selected.status ?? 'Recorded plan — controller confirmation is a separate event'}</p><p>{selected.detail}</p></div><button className="px-button" onClick={()=>setSelected(null)}>Close</button></div>:null}
 {moment!==null && canWrite?<form className="px-change-review" onSubmit={async e=>{e.preventDefault();setSaving(true);setMessage('');try{if(!pot||!Number.isFinite(moment)||moment>Date.now()+60000)throw new Error('Choose a pot and a valid past observation time.');await outbox.add({deviceId,pairingName:pot,researchPotId:null,experimentId:experiment.databaseId??null,body,tags:[],observedAt:new Date(moment).toISOString()});setBody('');onMoment(null);setMessage('Note saved on this device; sync status is shown in pot notes.');}catch(err){setMessage((err as Error).message);}finally{setSaving(false);}}}>
 <label>Pot <select value={pot} onChange={e=>setPot(e.target.value)}>{pairings.map(p=><option key={p.name} value={p.name}>Pot {p.pot_number}</option>)}</select></label>
 <label>Observation time (UTC) <input type="datetime-local" value={Number.isFinite(moment)?new Date(moment).toISOString().slice(0,16):''} onChange={e=>onMoment(Date.parse(e.target.value+'Z'))}/></label>
 <label>Note <textarea autoFocus required maxLength={4000} placeholder="Moved pot, checked emitter…" value={body} onChange={e=>setBody(e.target.value)}/></label>
 <button className="px-button is-primary" disabled={saving||!body.trim()}>Save note</button><button className="px-button" type="button" onClick={()=>onMoment(null)}>Cancel</button></form>:null}
 {message?<p role="status">{message}</p>:null}
 </section>;
}
