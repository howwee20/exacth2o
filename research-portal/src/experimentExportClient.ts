import { supabase } from "./supabase";
import { readingSelectColumns, supabaseQueryTimeoutMs } from "./portalConstants";
import { withSupabaseTimeout } from "./supabaseTimeout";
import type { SensorReading } from "./types";

/** Bounded, keyset-paged measurement export. RLS remains the project boundary. */
export async function loadExportReadings(input: {projectId:string;deviceId:string;pairingNames:readonly string[];startMs:number;endMs:number}) {
  const readings:SensorReading[]=[];
  if (!input.pairingNames.length) return {readings,truncated:false};
  const cap=50_000,pageSize=1000;
  let before:{at:string;id:number}|null=null;
  while(readings.length<cap){
    let query=supabase.from("sensor_readings").select(readingSelectColumns)
      .eq("project_id",input.projectId).eq("device_id",input.deviceId).in("pairing_name",[...input.pairingNames])
      .gte("device_recorded_at",new Date(input.startMs).toISOString()).lt("device_recorded_at",new Date(input.endMs).toISOString())
      .order("device_recorded_at",{ascending:false}).order("id",{ascending:false}).limit(pageSize);
    if(before) query=query.or(`device_recorded_at.lt.${before.at},and(device_recorded_at.eq.${before.at},id.lt.${before.id})`);
    const result=await withSupabaseTimeout(query,supabaseQueryTimeoutMs,"Experiment export");
    if(result.error) throw result.error;
    const rows=(result.data??[]) as SensorReading[];
    readings.push(...rows);
    if(rows.length<pageSize) return {readings,truncated:false};
    const last=rows.at(-1)!;before={at:last.device_recorded_at,id:last.id};
  }
  return {readings,truncated:true};
}
