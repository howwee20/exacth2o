import type { PortalExperiment } from "./experimentRegistry";
import { readRecordPages } from "./recordClient";
import { supabase } from "./supabase";
import { readingSelectColumns, supabaseQueryTimeoutMs } from "./portalConstants";
import { withSupabaseTimeout } from "./supabaseTimeout";
import type { SensorReading } from "./types";

/** Keyset-paged original measurements, without a silent total-row cutoff. RLS is unchanged. */
export async function loadExportReadings(input: {projectId:string;deviceId:string;pairingNames:readonly string[];sensorKeys?:readonly string[];startMs:number|null;endMs:number;signal?:AbortSignal;onProgress?:(rows:number)=>void}) {
  const readings:SensorReading[]=[];
  if (!input.pairingNames.length) return {readings,truncated:false};
  const pageSize=1000;
  const sensorKeys = [...new Set(input.sensorKeys ?? [])];
  const completeHardwareIdentity = sensorKeys.length === input.pairingNames.length;
  let before:{at:string;id:number}|null=null;
  while(true){
    input.signal?.throwIfAborted();
    let query=supabase.from("sensor_readings").select(readingSelectColumns)
      .eq("project_id",input.projectId).eq("device_id",input.deviceId)
      .in(completeHardwareIdentity ? "sensor_key" : "pairing_name", completeHardwareIdentity ? sensorKeys : [...input.pairingNames])
      .lte("device_recorded_at",new Date(input.endMs).toISOString())
      .order("device_recorded_at",{ascending:false}).order("id",{ascending:false}).limit(pageSize);
    if(input.startMs !== null) query=query.gte("device_recorded_at",new Date(input.startMs).toISOString());
    if(before) query=query.or(`device_recorded_at.lt.${before.at},and(device_recorded_at.eq.${before.at},id.lt.${before.id})`);
    const result=await withSupabaseTimeout(query,supabaseQueryTimeoutMs,"Experiment export");
    if(result.error) throw result.error;
    input.signal?.throwIfAborted();
    const rows=(result.data??[]) as SensorReading[];
    readings.push(...rows);
    input.onProgress?.(readings.length);
    if(rows.length<pageSize) return {readings,truncated:false};
    const last=rows.at(-1)!;
    if(before && String(before.at)===last.device_recorded_at && Number(before.id)===last.id) throw new Error("Export pagination did not advance. Retry the export.");
    before={at:last.device_recorded_at,id:last.id};
    // Cached and offline pages can resolve synchronously. Let the browser paint
    // progress and process Close/Escape before preparing another page.
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
}

/** Include labels from every recorded plan version, including pots removed from the latest plan. */
export async function loadExportExperiment(experiment: PortalExperiment): Promise<PortalExperiment> {
  if (!experiment.databaseId) return experiment;
  const history = await readRecordPages<{pairing_name:string}>(async (from,to)=>{
    const result = await supabase.from("experiment_assignments").select("pairing_name")
      .eq("experiment_id",experiment.databaseId).order("revision_id").order("pairing_name").range(from,to);
    if (result.error) throw result.error;
    return result.data ?? [];
  },20000);
  return {...experiment,pairingNames:[...new Set([...experiment.pairingNames,...history.map(row=>row.pairing_name)])]};
}
