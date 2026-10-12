import { describe, expect, it, vi } from "vitest";
import type { SensorReading } from "./types";
const state=vi.hoisted(()=>({rows:[] as SensorReading[],requests:0}));
vi.mock("./supabase",()=>({supabase:{from:()=>{
  let before=Infinity;
  const query:any={select:()=>query,eq:()=>query,in:()=>query,gte:()=>query,lte:()=>query,order:()=>query,limit:()=>query,
    or:(filter:string)=>{before=Number(filter.match(/id\.lt\.(\d+)/)?.[1]);return query;},
    then:(resolve:(value:unknown)=>void)=>{state.requests++;resolve({data:state.rows.filter(r=>r.id<before).slice(0,1000),error:null});}};
  return query;
}}}));
import { loadExportReadings } from "./experimentExportClient";
const input={projectId:"test",deviceId:"test",pairingNames:["Pot 1"],startMs:0,endMs:Date.now()};
describe("whole-experiment measurement paging",()=>{
  it("crosses the former 50,000-row cutoff, including equal timestamps",async()=>{
    state.requests=0;state.rows=Array.from({length:51003},(_,i)=>({id:51003-i,event_id:`test:${i}`,pairing_name:"Pot 1",sensor_key:"test:1",raw_value:i,calibrated_value:i,temperature:null,electrical_conductivity:null,device_recorded_at:"2026-10-01T00:00:00Z",server_received_at:"2026-10-01T00:00:00Z"}));
    const result=await loadExportReadings(input);
    expect(result.readings).toHaveLength(51003);expect(result.truncated).toBe(false);
    expect(new Set(result.readings.map(r=>r.id)).size).toBe(51003);expect(state.requests).toBe(52);
  });
  it("terminates when the next page is empty",async()=>{
    state.rows=state.rows.slice(0,1000);
    const result=await loadExportReadings(input);expect(result.readings).toHaveLength(1000);
  });
  it("cancels before sending another request",async()=>{
    const cancel=new AbortController();cancel.abort();state.requests=0;
    await expect(loadExportReadings({...input,signal:cancel.signal})).rejects.toThrow();expect(state.requests).toBe(0);
  });
  it("processes queued cancellation between synchronously cached pages",async()=>{
    state.rows=Array.from({length:2000},(_,i)=>({id:2000-i,device_recorded_at:"2026-10-01T00:00:00Z"}) as SensorReading);
    state.requests=0;
    const cancel=new AbortController();
    await expect(loadExportReadings({...input,signal:cancel.signal,onProgress:()=>{setTimeout(()=>cancel.abort(),0);}})).rejects.toThrow();
    expect(state.requests).toBe(1);
  });
});
