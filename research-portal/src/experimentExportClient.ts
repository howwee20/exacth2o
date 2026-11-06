import type { PortalExperiment } from "./experimentRegistry";
import { readRecordPages } from "./recordClient";
import { supabase } from "./supabase";
import { readingSelectColumns, supabaseQueryTimeoutMs } from "./portalConstants";
import { withSupabaseTimeout } from "./supabaseTimeout";
import type { SensorReading } from "./types";

/**
 * Keyset-paged original measurements, without a silent total-row cutoff. RLS is unchanged.
 * `endExclusive` lets adjacent time slices partition a range; `receivedSince` reads only rows
 * stored at or after that server time, newest arrival first (an incremental refresh).
 */
export async function loadExportReadings(input: {projectId:string;deviceId:string;pairingNames:readonly string[];sensorKeys?:readonly string[];startMs:number|null;endMs:number;endExclusive?:boolean;receivedSince?:string;signal?:AbortSignal;onProgress?:(rows:number)=>void;onPage?:(rows:SensorReading[])=>void}) {
  const readings:SensorReading[]=[];
  if (!input.pairingNames.length) return {readings,truncated:false};
  const pageSize=1000;
  const sensorKeys = [...new Set(input.sensorKeys ?? [])];
  const completeHardwareIdentity = sensorKeys.length === input.pairingNames.length;
  const orderColumn = input.receivedSince ? "server_received_at" : "device_recorded_at";
  let before:{at:string;id:number}|null=null;
  while(true){
    input.signal?.throwIfAborted();
    let query=supabase.from("sensor_readings").select(readingSelectColumns)
      .eq("project_id",input.projectId).eq("device_id",input.deviceId)
      .in(completeHardwareIdentity ? "sensor_key" : "pairing_name", completeHardwareIdentity ? sensorKeys : [...input.pairingNames]);
    query = input.endExclusive ? query.lt("device_recorded_at",new Date(input.endMs).toISOString()) : query.lte("device_recorded_at",new Date(input.endMs).toISOString());
    query=query.order(orderColumn,{ascending:false}).order("id",{ascending:false}).limit(pageSize);
    if(input.startMs !== null) query=query.gte("device_recorded_at",new Date(input.startMs).toISOString());
    if(input.receivedSince) query=query.gte("server_received_at",input.receivedSince);
    if(before) query=query.or(`${orderColumn}.lt.${before.at},and(${orderColumn}.eq.${before.at},id.lt.${before.id})`);
    const result=await withSupabaseTimeout(query,supabaseQueryTimeoutMs,"Experiment export",input.signal);
    if(result.error) throw result.error;
    input.signal?.throwIfAborted();
    const rows=(result.data??[]) as SensorReading[];
    readings.push(...rows);
    input.onPage?.(rows);
    input.onProgress?.(readings.length);
    if(rows.length<pageSize) return {readings,truncated:false};
    const last=rows.at(-1)!;
    if(before && String(before.at)===last[orderColumn] && Number(before.id)===last.id) throw new Error("Export pagination did not advance. Retry the export.");
    before={at:last[orderColumn],id:last.id};
    // Cached and offline pages can resolve synchronously. Let the browser paint
    // progress and process Close/Escape before preparing another page.
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
}

/** Include labels from every recorded plan version, including pots removed from the latest plan. */
export async function loadExportExperiment(experiment: PortalExperiment, selectedNames?: readonly string[]): Promise<PortalExperiment> {
  if (!experiment.databaseId) return selectedNames ? {...experiment,pairingNames:selectedNames,assignments:experiment.assignments?.filter(a=>selectedNames.includes(a.pairing_name))} : experiment;
  const history = await readRecordPages<{pairing_name:string;sensor_key_snapshot?:string|null}>(async (from,to)=>{
    const result = await supabase.from("experiment_assignments").select("pairing_name,sensor_key_snapshot")
      .eq("experiment_id",experiment.databaseId).order("revision_id").order("pairing_name").range(from,to);
    if (result.error) throw result.error;
    return result.data ?? [];
  },20000);
  const sensors = new Set(experiment.assignments?.filter(a=>selectedNames?.includes(a.pairing_name)).map(a=>a.sensor_key_snapshot).filter(Boolean));
  const rows = selectedNames ? history.filter(row=>selectedNames.includes(row.pairing_name) || Boolean(row.sensor_key_snapshot && sensors.has(row.sensor_key_snapshot))) : history;
  return {...experiment,pairingNames:[...new Set([...(selectedNames ?? experiment.pairingNames),...rows.map(row=>row.pairing_name)])],assignments:selectedNames ? experiment.assignments?.filter(a=>selectedNames.includes(a.pairing_name)) : experiment.assignments};
}
