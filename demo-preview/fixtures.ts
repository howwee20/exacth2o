// Fictional demonstration data. Irrigation timestamps and moisture responses share one model.
import {fixture as base,experiments as baseExperiments,walkerSnapshot,mixer,sampleProfile} from '../applications-preview/fixtures';
export {walkerSnapshot,mixer,sampleProfile};
const now=Date.now(), step=5*60000;
const durationDays:Record<string,number>={'experiment-1':14,'experiment-2':7,'experiment-3':3};
const experimentStart=(id:string)=>now-durationDays[id]*86400000;
const start=experimentStart('experiment-1');
const one=baseExperiments.find(e=>e.id==='experiment-1')!,two=baseExperiments.find(e=>e.id==='experiment-2')!;
const three={...two,id:'experiment-3',name:'Experiment 3',count:24,groupNames:['experiment-3'],pairingNames:Array.from({length:24},(_,i)=>`Pot ${101+i}`),assignments:two.assignments.map((a,i)=>({...a,pairing_name:`Pot ${101+i}`,pot_number:101+i}))};
export const experiments=[one,two,three].map((e,i)=>({...e,mode:'controlled',status:'active',wateringState:'controller_managed',startedAt:new Date(experimentStart(e.id)).toISOString(),shortDescription:['14-day drought study · control and deficit irrigation','7-day recovery study · repeated irrigation cycles','3-day crop comparison · sensor-guided watering'][i]}));
const pairings=experiments.flatMap(e=>e.assignments.map(a=>({id:a.pot_number,name:a.pairing_name,zone:a.zone,pot_number:a.pot_number,group_name:e.id,source_sensor_id:a.pot_number,sensor_key:`sample:${a.pot_number}`,source_valve_id:a.pot_number,valve_key:`sample-valve:${a.pot_number}`,wtc_percent_limit:a.target_vwc_percent,valve_open_time_ms:2000+(a.pot_number%4)*500,measurement_interval_ms:step,calibration_name:'Demo substrate calibration'})));
// Each pot has independent substrate capacity, uptake, irrigation lag, and sensor drift.
// This is synthetic data only; the same state machine continues in the browser live feed.
const states=new Map<number,any>();
const assignments=new Map(experiments.flatMap(e=>e.assignments.map(a=>[a.pot_number,a] as const)));
function random(s:any){s.seed=(Math.imul(1664525,s.seed)+1013904223)>>>0;return s.seed/4294967296;}
export function nextDemoSample(p:any,atMs:number){
 let s=states.get(p.id);
 if(!s){
  s={seed:(Math.imul(p.id,2654435761)+19371)>>>0};
  const a=assignments.get(p.id)!;
  Object.assign(s,{crop:a.crop,drought:a.treatment==='drought',level:0,last:atMs-step,noise:0,pending:0,drain:0,count:0,lastWater:-Infinity});
  s.uptake=(.18+random(s)*.48)*(a.crop==='maize'?1.25:.85);
  s.offset=(random(s)-.5)*4.6;
  s.gain=2.2+random(s)*4.2;
  s.lag=.08+random(s)*.42;
  s.level=(p.group_name==='experiment-2'?31:p.wtc_percent_limit+3)+s.offset+random(s)*4;
  s.threshold=p.wtc_percent_limit+s.offset;
  s.recoveryHour=(36+random(s)*14)*durationDays[p.group_name]/3;
  if(p.group_name==='experiment-1'&&s.drought)s.uptake*=3/durationDays[p.group_name];
  s.minInterval=1.2+random(s)*4;
  s.weatherPhase=random(s)*6.28;
  states.set(p.id,s);
 }
 const hours=Math.max(0,(atMs-s.last)/3600000),elapsed=(atMs-experimentStart(p.group_name))/3600000;
 const hour=new Date(atMs).getHours()+new Date(atMs).getMinutes()/60;
 const daylight=Math.max(0,Math.sin((hour-6)/12*Math.PI));
 const weather=.8+.28*Math.sin(elapsed/11+s.weatherPhase)+.16*Math.sin(elapsed/3.7+s.weatherPhase);
 const stress=Math.max(.22,Math.min(1,(s.level-9)/15));
 s.level-=s.uptake*(.24+1.5*daylight)*weather*stress*hours;
 const absorbed=s.pending*(1-Math.exp(-hours/s.lag));
 s.pending-=absorbed;s.level+=absorbed;
 const drainage=s.drain*(1-Math.exp(-hours/1.8));s.drain-=drainage;s.level-=drainage;
 let enabled=true,threshold=s.threshold,gain=s.gain;
 if(p.group_name==='experiment-1'&&s.drought){enabled=elapsed<14*durationDays[p.group_name]/3;}
 if(p.group_name==='experiment-2'){
  // Distinct dry-down followed by staggered recovery, then maintenance irrigation.
  enabled=elapsed>s.recoveryHour;
  threshold=(s.drought?25:35)+s.offset;
  gain=elapsed<s.recoveryHour+8?7+random(s)*4:s.gain;
 }
 if(p.group_name==='experiment-3'){
  // Crop-dependent uptake and smaller, less frequent deficit irrigation.
  threshold+=(s.crop==='maize'?1.4:-1.2);
  if(s.drought){gain*=.6;enabled=daylight>.25;}
 }
 let event:any=null;
 if(enabled&&s.level<threshold&&s.pending<.2&&elapsed-s.lastWater>s.minInterval){
  const amount=gain*(.7+random(s)*.65);
  s.pending+=amount;s.drain+=amount*(.08+random(s)*.13);s.lastWater=elapsed;
  const at=new Date(atMs).toISOString();
  event={id:p.id*10000000+s.count,event_id:`demo-water:${p.id}:${s.count}`,organization_id:'sample',project_id:'sample',device_id:'sample',pairing_name:p.name,valve_key:p.valve_key,source_valve_id:p.id,action:'open',duration_ms:Math.round(1200+amount*420),device_recorded_at:at,server_received_at:at};
 }
 s.noise=s.noise*.76+(random(s)-.5)*.10;
 const drift=.11*Math.sin(elapsed/(4+p.id%7)+s.weatherPhase);
 const value=Number(Math.max(7,Math.min(49,s.level+s.noise+drift)).toFixed(2));
 const at=new Date(atMs).toISOString();s.last=atMs;s.count++;
 const reading={id:p.id*10000000+s.count,event_id:`demo-reading:${p.id}:${s.count}`,organization_id:'sample',project_id:'sample',device_id:'sample',pairing_name:p.name,sensor_key:p.sensor_key,raw_value:value,calibrated_value:value,temperature:Number((21+6*daylight+s.offset*.2).toFixed(1)),electrical_conductivity:Number((.65+(40-value)*.012).toFixed(2)),device_recorded_at:at,server_received_at:at};
 return {reading,event};
}
const readings:any[]=[],valveEvents:any[]=[];
for(const p of pairings)for(let at=experimentStart(p.group_name);at<=now;at+=step){
 const sample=nextDemoSample(p,at);readings.push(sample.reading);if(sample.event)valveEvents.push(sample.event);
}
readings.sort((a,b)=>a.device_recorded_at.localeCompare(b.device_recorded_at));
valveEvents.sort((a,b)=>a.device_recorded_at.localeCompare(b.device_recorded_at));
// A complete operating controller snapshot, local to this demo bundle.
const timestamp=()=>new Date().toISOString();
const runtime={project_id:'sample',device_id:'sample',device_name:'Research controller',source:'demo',controller_state:'running',controller_state_raw:'running',controller_state_updated_at:new Date(start).toISOString(),get state_observed_at(){return timestamp();},get state_fresh_until(){return new Date(Date.now()+120000).toISOString();},get owner_checked_at(){return timestamp();},overall_status:'operational',api_status:'OK',pi_online:true,public_url_reachable:true,watering_enabled:true,watering_disabled:[],watering_last_event:'Irrigation pulse completed',get watering_last_event_at(){return valveEvents.at(-1)?.device_recorded_at??null;},get watering_events_last_24h(){return valveEvents.filter(e=>Date.parse(e.device_recorded_at)>Date.now()-86400000).length;},scheduler_jobs_loaded:pairings.length,sensors_expected:pairings.length,sensors_current:pairings.length,sensors_stale:0,sensors_missing:0,get last_sensor_reading_at(){return readings.at(-1)?.device_recorded_at;},config_hash:'demo-config-68-pots',raw_status:{state:'running',watering_enabled:true},raw_health:{},raw_system:{},get updated_at(){return timestamp();}};
const config={project_id:'sample',device_id:'sample',device_name:'Research controller',source:'demo',get observed_at(){return timestamp();},pairings,calibrations:[{name:'Demo substrate calibration'}],board_config:[{address:'0x20'},{address:'0x24'},{address:'0x26'}],sensors:pairings.map(p=>({id:p.source_sensor_id,name:p.name,sensor_key:p.sensor_key})),valves:pairings.map(p=>({id:p.source_valve_id,name:p.name,valve_key:p.valve_key})),groups:experiments.map(e=>({name:e.name})),pairing_count:pairings.length,calibration_count:1,board_count:3,sensor_count:pairings.length,valve_count:pairings.length,group_count:3,config_hash:'demo-config-68-pots',endpoint_status:{},raw_config:{},get updated_at(){return timestamp();}};
export const fixture={...base,runtime,config,experiments,valveEvents,health:{...base.health,sensors_expected:pairings.length,sensors_current:pairings.length,scheduler_jobs_loaded:pairings.length,watering_events_last_24h:valveEvents.filter(e=>Date.parse(e.device_recorded_at)>now-86400000).length,watering_last_event:'Irrigation pulse completed',watering_last_event_at:valveEvents.at(-1)?.device_recorded_at},data:{...base.data,pairings,readings,totalImportedReadings:readings.length,totalLiveReadings:readings.length,latestLiveReading:readings.at(-1)}};
