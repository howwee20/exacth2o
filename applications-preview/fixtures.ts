import { initialGasMixerNativeState } from '../research-portal/src/gasMixerNative';
const now=Date.now(), stamp=new Date(now).toISOString();

// Deterministic sample profiles: independent drying rates and irrigation/recovery events.
export function sampleProfile(id:number, controlled=true){
 let seed=(id*2654435761)>>>0;
 const random=()=>{seed=(1664525*seed+1013904223)>>>0;return seed/4294967296;};
 let level=24+random()*19, drift=.018+random()*.06, noise=0;
 const pulses=[30+Math.floor(random()*27),86+Math.floor(random()*32)];
 const gain=2.2+random()*3.4;
 return Array.from({length:145},(_,i)=>{
   const daytime=1+.6*Math.sin(Math.PI*i/144);
   if(i>0)level-=drift*daytime;
   if(controlled){for(const t of pulses){if(i>=t&&i<t+5)level+=gain*Math.exp(-(i-t)*.65)/2.01;}}
   noise=noise*.62+(random()-.5)*.09;
   return Math.round(Math.max(12,Math.min(52,level+noise))*100)/100;
 });
}

export const experiments=[
 {id:'experiment-2',name:'Experiment 2',shortDescription:'Experiment complete · 0% dry-down',mode:'controlled',status:'completed',wateringState:'off',count:24},
 {id:'calibration',name:'SWC Saturation Calibration',shortDescription:'Sensing only',mode:'calibration',status:'published_sensing',wateringState:'off',count:10},
 {id:'experiment-1',name:'Experiment 1',shortDescription:'Original 20-pot experiment',mode:'observation',status:'published_sensing',wateringState:'off',count:20},
].map((e,index)=>({...e,groupNames:[e.id],pairingNames:Array.from({length:e.count},(_,i)=>`Pot ${index*30+i+1}`),assignments:Array.from({length:e.count},(_,i)=>({pairing_name:`Pot ${index*30+i+1}`,zone:Math.floor(i/6)+1,pot_number:index*30+i+1,crop:i%2?'maize':'sorghum',treatment:i<e.count/2?'control':'drought',target_vwc_percent:i<e.count/2?35:20}))}));
const pairings=experiments.flatMap(e=>e.assignments.map((a,i)=>({id:a.pot_number,name:a.pairing_name,zone:a.zone,pot_number:a.pot_number,group_name:e.id,source_sensor_id:a.pot_number,sensor_key:`sample:${a.pot_number}`,source_valve_id:a.pot_number,valve_key:`sample-valve:${a.pot_number}`,wtc_percent_limit:a.target_vwc_percent,valve_open_time_ms:2000,measurement_interval_ms:300000,calibration_name:'Substrate calibration'})));
const readings=pairings.flatMap(p=>Array.from({length:145},(_,i)=>{const at=new Date(now-(144-i)*600000).toISOString();const v=sampleProfile(p.id,p.wtc_percent_limit!==20)[i];return {id:p.id*1000+i,event_id:`sample:${p.id}:${i}`,pairing_name:p.name,sensor_key:p.sensor_key,raw_value:v,calibrated_value:v,temperature:24,electrical_conductivity:.8,device_recorded_at:at,server_received_at:at};}));
const valveEvents=pairings.flatMap(p=>Array.from({length:3},(_,i)=>({id:p.id*10+i,event_id:`sample-water:${p.id}:${i}`,organization_id:'sample',project_id:'sample',device_id:'sample',pairing_name:p.name,valve_key:p.valve_key,source_valve_id:p.id,action:'close',duration_ms:2000,device_recorded_at:new Date(now-(i*6+1)*3600000).toISOString(),server_received_at:stamp})));
export const health={id:'sample',project_id:'sample',device_id:'sample',device_name:'Research controller',source:'sample',captured_at:stamp,created_at:stamp,overall_status:'operational',api_status:'online',pi_online:true,status_endpoint_ok:true,history_endpoint_ok:true,public_url_reachable:true,ethernet_link:true,ethernet_ip:'192.0.2.10',gateway_ping_ms:2,cpu_temp_c:42,uptime_seconds:86400,sensors_expected:20,sensors_current:20,sensors_stale:0,sensors_missing:0,missing_sensors:[],stale_sensors:[],active_alerts:[],known_issues:[],last_sensor_reading_at:stamp,watering_events_last_24h:12,scheduler_jobs_loaded:20,ingest_complete:true,raw_status:{},raw_health:{},raw_history:{records:Array.from({length:97},(_,i)=>({t:new Date(now-(96-i)*300000).toISOString(),uptimeSeconds:57600+i*300,ethUp:true,cpuTempC:42+Math.sin(i*.15),undervoltage:false,undervoltageOccurred:false,staleOrMissingSensors:0,sensorRows:20})),sampleIntervalSeconds:300}};
export const fixture={data:{pairings,readings,latestState:null,totalImportedReadings:readings.length,totalLiveReadings:readings.length,latestLiveReading:readings.at(-1),latestIngestTime:stamp,lastCheckedAt:stamp,lastNewDataAt:stamp,effectiveMode:'live'},experiments,health,valveEvents,access:{role:'admin',email:'sample@example.invalid',projectId:'sample',deviceId:'sample',accessScope:'project',gasMixerAllowed:true}};
export function walkerSnapshot(){const at=new Date().toISOString();const sensors=Array.from({length:96},(_,i)=>({source_sensor_id:i+1,sensor_key:`sample:${i+1}`,display_label:`Sensor ${i+1}`,source_pairing_name:`Pot ${i+1}`,position_number:i+1,board_serial_id:`Board ${Math.floor(i/24)+1}`,sensor_address:String(i%24),latest_calibrated_value:sampleProfile(i+1,(i+1)%3!==0).at(-1),latest_reading_at:at,live_point_count:145}));return {project_id:'sample',device_id:'sample',device_name:'Sensor observation',observation_only:true,portal_control_available:false,expected_sensor_count:100,evidenced_sensor_count:96,current_sensor_count:96,stale_sensor_count:0,missing_numeric_positions:[97,98,99,100],window_hours:24,freshness:'live',overall_status:'operational',latest_live_reading_at:at,publisher:{status:'healthy',last_success_at:at,last_attempt_at:at,last_error:null},range_start:new Date(now-86400000).toISOString(),range_end:at,point_budget:145,bucket_seconds:600,sensors,series:sensors.map(s=>({...s,points:Array.from({length:145},(_,i)=>{const v=sampleProfile(s.source_sensor_id,s.source_sensor_id%3!==0)[i];return {at:new Date(now-(144-i)*600000).toISOString(),minimum:v-.1,maximum:v+.1,average:v,sample_count:1};})}))};}
const machine=initialGasMixerNativeState();machine.total_slpm=2;machine.channels.A.setpoint=1.58;machine.channels.A.delivered=1.58;machine.channels.B.ratio=21;machine.channels.B.setpoint=.42;machine.channels.B.delivered=.42;machine.channels.D.ratio=420;
export const mixer={project_id:'sample',device_id:'sample',bridge_ready:true,bridge_version:'sample',state_revision:1,remote_control_allowed:true,requested_state:machine,applied_state:machine,observed_state:machine,last_command:null};
