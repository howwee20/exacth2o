// Fictional demonstration data. Irrigation timestamps and moisture responses share one model.
import {fixture as base,experiments as baseExperiments,walkerSnapshot,mixer,sampleProfile} from '../applications-preview/fixtures';
export {walkerSnapshot,mixer,sampleProfile};
const now=Date.now(), step=5*60000, start=now-24*3600000;
const one=baseExperiments.find(e=>e.id==='experiment-1')!,two=baseExperiments.find(e=>e.id==='experiment-2')!;
const three={...two,id:'experiment-3',name:'Experiment 3',count:24,groupNames:['experiment-3'],pairingNames:Array.from({length:24},(_,i)=>`Pot ${101+i}`),assignments:two.assignments.map((a,i)=>({...a,pairing_name:`Pot ${101+i}`,pot_number:101+i}))};
export const experiments=[one,two,three].map((e,i)=>({...e,mode:'controlled',status:'active',wateringState:'controller_managed',startedAt:new Date(start-86400000).toISOString(),shortDescription:['Drought study · control and deficit irrigation','Recovery study · repeated irrigation cycles','Crop comparison · sensor-guided watering'][i]}));
const pairings=experiments.flatMap(e=>e.assignments.map(a=>({id:a.pot_number,name:a.pairing_name,zone:a.zone,pot_number:a.pot_number,group_name:e.id,source_sensor_id:a.pot_number,sensor_key:`sample:${a.pot_number}`,source_valve_id:a.pot_number,valve_key:`sample-valve:${a.pot_number}`,wtc_percent_limit:a.target_vwc_percent,valve_open_time_ms:2000+(a.pot_number%4)*500,measurement_interval_ms:step,calibration_name:'Demo substrate calibration'})));
const readings:any[]=[],valveEvents:any[]=[];
for(const p of pairings){
 const drought=p.wtc_percent_limit===20, period=drought?94:58, phase=p.id%23;
 // Staggered starts give each pot its own trace, with recovery after every recorded irrigation.
 const pulses=Array.from({length:6},(_,j)=>18+phase+j*period).filter(i=>i<286);
 const gain=drought?2.7:4.3, rate=gain/period;
 let level=p.wtc_percent_limit+gain*(.65+(p.id%7)/20);
 for(let i=0;i<=288;i++){
  level-=rate*(1+.2*Math.sin(i/288*Math.PI*2));
  for(const pulse of pulses)if(i>=pulse&&i<pulse+5)level+=gain*Math.exp(-(i-pulse)*.7)/1.927;
  const value=Number((level+.06*Math.sin(i*.73+p.id)).toFixed(2)),at=new Date(start+i*step).toISOString();
  readings.push({id:p.id*10000+i,event_id:`demo-reading:${p.id}:${i}`,organization_id:'sample',project_id:'sample',device_id:'sample',pairing_name:p.name,sensor_key:p.sensor_key,raw_value:value,calibrated_value:value,temperature:24,electrical_conductivity:.8,device_recorded_at:at,server_received_at:at});
  if(pulses.includes(i))valveEvents.push({id:p.id*1000+i,event_id:`demo-water:${p.id}:${i}`,organization_id:'sample',project_id:'sample',device_id:'sample',pairing_name:p.name,valve_key:p.valve_key,source_valve_id:p.id,action:'open',duration_ms:p.valve_open_time_ms,device_recorded_at:at,server_received_at:at});
 }
}
readings.sort((a,b)=>a.device_recorded_at.localeCompare(b.device_recorded_at));
valveEvents.sort((a,b)=>a.device_recorded_at.localeCompare(b.device_recorded_at));
export const fixture={...base,experiments,valveEvents,health:{...base.health,sensors_expected:pairings.length,sensors_current:pairings.length,scheduler_jobs_loaded:pairings.length,watering_events_last_24h:valveEvents.length,watering_last_event:'Irrigation pulse completed',watering_last_event_at:valveEvents.at(-1)?.device_recorded_at},data:{...base.data,pairings,readings,totalImportedReadings:readings.length,totalLiveReadings:readings.length,latestLiveReading:readings.at(-1)}};
