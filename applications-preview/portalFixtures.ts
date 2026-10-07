// Applications-only synthetic studies. Fictional data, generated in the browser; no researcher
// dataset is used. Watering follows the controller's rule exactly: a pot is watered when its
// measured moisture falls below the target shown for its group, so every target on screen is
// the threshold that produced the watering events beside it.
import {fixture as original} from './fixtures';
const now=Date.now(),step=10*60000,stamp=new Date(now).toISOString();
type Study={days:number,description:string,targets:{control:number,drought:number},start:[number,number],heat:boolean};
const studies:Study[]=[
 {days:8,description:'Two moisture targets · steady deficit irrigation',targets:{control:34,drought:22},start:[35,40],heat:false},
 {days:5,description:'Dry start · pots brought up to target, then maintained',targets:{control:32,drought:24},start:[14,18],heat:false},
 {days:4,description:'Heatwave response · maize and sorghum',targets:{control:34,drought:24},start:[33,38],heat:true},
];
const experiments=studies.map((study,index)=>{
 const template=original.experiments.find(e=>e.id===(index===0?'experiment-1':'experiment-2'))!;
 const assignments=template.assignments.map((a,i)=>({...a,pot_number:index*30+i+1,pairing_name:`Pot ${index*30+i+1}`,target_vwc_percent:a.treatment==='drought'?study.targets.drought:study.targets.control,measurement_interval_minutes:10}));
 return {...template,id:`experiment-${index+1}`,name:`Experiment ${index+1}`,mode:'controlled',status:'active',wateringState:'controller_managed',shortDescription:study.description,startedAt:new Date(now-study.days*86400000).toISOString(),assignments,pairingNames:assignments.map(a=>a.pairing_name),groupNames:[`experiment-${index+1}`]};
});
const studyPairings=experiments.flatMap(e=>e.assignments.map(a=>({id:a.pot_number,name:a.pairing_name,zone:a.zone,pot_number:a.pot_number,group_name:e.id,source_sensor_id:a.pot_number,sensor_key:`applications:${a.pot_number}`,source_valve_id:a.pot_number,valve_key:`applications-valve:${a.pot_number}`,wtc_percent_limit:a.target_vwc_percent,valve_open_time_ms:3000,measurement_interval_ms:step,calibration_name:'Substrate calibration'})));
const readings:any[]=[],valveEvents:any[]=[];
for(const p of studyPairings){
 const index=Number(p.group_name.slice(-1))-1,study=studies[index];
 const assignment=experiments[index].assignments.find(a=>a.pot_number===p.id)!;
 const maize=assignment.crop==='maize',target=p.wtc_percent_limit;
 let seed=(Math.imul(p.id,2246822519)+9173)>>>0;
 const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
 const start=now-study.days*86400000;
 const uptake=(.32+random()*.24)*(maize?1.18:.88),lag=.25+random()*.6,pulse=3.2+random()*1.6;
 let level=study.start[0]+random()*(study.start[1]-study.start[0]),pending=0,drain=0,noise=0,lastWater=-1000;
 for(let t=start,n=0;t<=now;t+=step,n++){
  const elapsed=(t-start)/3600000,day=elapsed/24,hour=new Date(t).getHours()+new Date(t).getMinutes()/60;
  const daylight=Math.max(0,Math.sin((hour-6)*Math.PI/12));
  const heat=study.heat?1+1.25*Math.exp(-Math.pow((day-2.1)/.6,2)):1;
  const stress=Math.max(.2,Math.min(1,(level-6)/16));
  level-=uptake*(.22+1.5*daylight)*heat*stress/6;
  const absorbed=pending*(1-Math.exp(-1/6/lag));pending-=absorbed;level+=absorbed;
  const drained=drain*(1-Math.exp(-1/6/2));drain-=drained;level-=drained;
  noise=.7*noise+(random()-.5)*.12;
  const measured=Number(Math.max(5,Math.min(48,level+noise)).toFixed(2)),at=new Date(t).toISOString();
  readings.push({id:p.id*100000+n,event_id:`applications-reading:${p.id}:${n}`,pairing_name:p.name,sensor_key:p.sensor_key,raw_value:measured,calibrated_value:measured,temperature:Number((22+5*daylight+(heat-1)*4).toFixed(1)),electrical_conductivity:.8,device_recorded_at:at,server_received_at:at});
  // The controller's rule: water when the measured value is below target, then wait for the pulse to soak in.
  if(measured<target&&pending<.3&&elapsed-lastWater>1.5){
   const gain=pulse*(target-measured>6?1.6:1);
   pending+=gain;drain+=gain*.12;lastWater=elapsed;
   valveEvents.push({id:p.id*100000+n,event_id:`applications-water:${p.id}:${n}`,organization_id:'sample',project_id:'sample',device_id:'sample',pairing_name:p.name,valve_key:p.valve_key,source_valve_id:p.id,action:'open',duration_ms:p.valve_open_time_ms,device_recorded_at:at,server_received_at:at});
  }
 }
}
const calibration=original.experiments.find(e=>e.id==='calibration')!;
// Keep calibration identities separate from the three new study series.
const calibrationPairings=original.data.pairings.filter(p=>p.group_name==='calibration').map(p=>({...p,id:p.id+100,pot_number:p.pot_number+100,name:`Pot ${p.pot_number+100}`,source_sensor_id:p.source_sensor_id+100,sensor_key:`calibration:${p.id}`,source_valve_id:p.source_valve_id+100,valve_key:`calibration-valve:${p.id}`}));
const calibrationExperiment={...calibration,pairingNames:calibrationPairings.map(p=>p.name),assignments:calibration.assignments.map(a=>({...a,pot_number:a.pot_number+100,pairing_name:`Pot ${a.pot_number+100}`}))};
for(const p of calibrationPairings){for(const r of original.data.readings.filter(r=>r.pairing_name===`Pot ${p.pot_number-100}`))readings.push({...r,id:r.id+10000000,pairing_name:p.name,sensor_key:p.sensor_key});}
readings.sort((a,b)=>a.device_recorded_at.localeCompare(b.device_recorded_at));valveEvents.sort((a,b)=>a.device_recorded_at.localeCompare(b.device_recorded_at));
const pairings=[...studyPairings,...calibrationPairings],lastEvent=valveEvents.at(-1)?.device_recorded_at;
const wateringCount=valveEvents.filter(e=>Date.parse(e.device_recorded_at)>now-86400000).length;
const runtime={project_id:'sample',device_id:'sample',device_name:'Research controller',source:'sample',controller_state:'running',controller_state_raw:'running',controller_state_updated_at:stamp,state_observed_at:stamp,state_fresh_until:new Date(now+86400000).toISOString(),owner_checked_at:stamp,overall_status:'operational',api_status:'OK',pi_online:true,public_url_reachable:true,watering_enabled:true,watering_disabled:[],watering_last_event:'Irrigation pulse completed',watering_last_event_at:lastEvent,watering_events_last_24h:wateringCount,scheduler_jobs_loaded:pairings.length,sensors_expected:pairings.length,sensors_current:pairings.length,sensors_stale:0,sensors_missing:0,last_sensor_reading_at:stamp,config_hash:'applications-studies',raw_status:{state:'running',watering_enabled:true},raw_health:{},raw_system:{},updated_at:stamp};
const config={project_id:'sample',device_id:'sample',device_name:'Research controller',source:'sample',observed_at:stamp,pairings,calibrations:[{name:'Substrate calibration'}],board_config:[{address:'0x20'},{address:'0x24'},{address:'0x26'}],sensors:pairings.map(p=>({id:p.source_sensor_id,name:p.name,sensor_key:p.sensor_key})),valves:pairings.map(p=>({id:p.source_valve_id,name:p.name,valve_key:p.valve_key})),groups:[...experiments,calibrationExperiment].map(e=>({name:e.name})),pairing_count:pairings.length,calibration_count:1,board_count:3,sensor_count:pairings.length,valve_count:pairings.length,group_count:4,config_hash:'applications-studies',endpoint_status:{},raw_config:{},updated_at:stamp};
export const fixture={...original,runtime,config,experiments:[...experiments,calibrationExperiment],valveEvents,data:{...original.data,pairings,readings,totalImportedReadings:readings.length,totalLiveReadings:readings.length,latestLiveReading:readings.at(-1)},health:{...original.health,sensors_expected:pairings.length,sensors_current:pairings.length,scheduler_jobs_loaded:pairings.length,watering_events_last_24h:wateringCount,watering_last_event_at:lastEvent}};
