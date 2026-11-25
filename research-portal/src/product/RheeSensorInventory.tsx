import { useEffect, useState } from "react";
import { supabase } from "../supabase";
import { FIELD_DEVICE_ID, FIELD_PROJECT_ID } from "../../../supabase/functions/_shared/installation-field-map.mjs";

type Sensor = { id: number; boardSerialId: string; address: string };
type Pair = { name: string; Sensor?: Sensor };
type Entry = {id:number; address:string; board:string; pairings:string[]};

export function RheeSensorInventory() {
  const [open,setOpen]=useState(false);
  const [rows,setRows]=useState<Entry[]|null>(null);
  const [error,setError]=useState(false);
  useEffect(()=>{
    if(!open)return;
    let current=true;
    setError(false);
    void Promise.resolve(supabase.from('device_config_state').select('sensors,pairings').eq('project_id',FIELD_PROJECT_ID).eq('device_id',FIELD_DEVICE_ID).single()).then(({data,error})=>{
      if(!current)return;
      if(error || !Array.isArray(data?.sensors)) {setError(true);return;}
      const pairs:Pair[]=Array.isArray(data.pairings)?data.pairings:[];
      setRows((data.sensors as Sensor[]).map(s=>({id:s.id,board:s.boardSerialId,address:s.address,
        pairings:pairs.filter(p=>p.Sensor?.boardSerialId===s.boardSerialId && p.Sensor?.address===s.address).map(p=>p.name)})).sort((a,b)=>a.id-b.id));
    }).catch(()=>{if(current)setError(true)});
    return ()=>{current=false};
  },[open]);
  return <details className="px-sensor-list" onToggle={e=>setOpen(e.currentTarget.open)}>
    <summary>Sensor inventory{rows ? ` (${rows.length})` : ''}</summary>
    {open && (error ? <p role="alert">Could not load the sensor inventory. Close and reopen to retry.</p> : rows===null ? <p role="status">Loading sensors…</p> : <>
      <p>Configured sensors by board. Uppercase and lowercase addresses identify different probes.</p>
      {[...new Set(rows.map(s=>s.board))].map(board=>{const sensors=rows.filter(s=>s.board===board);return <details key={board}><summary>{board} · {sensors.length} sensors</summary>
        <table><thead><tr><th>Address</th><th>ID</th><th>Configured pairing</th></tr></thead><tbody>{sensors.map(s=><tr key={s.id}><th scope="row">{s.address}</th><td>{s.id}</td><td>{s.pairings.join(', ') || 'Unpaired'}</td></tr>)}</tbody></table></details>})}
    </>)}
  </details>;
}
