// Demo portal backend: in-memory sample data, one shared read-only account, readings that keep arriving.
// Nothing here reaches Supabase or a controller; the page's CSP allows no network connections.
import {fixture,walkerSnapshot,mixer} from './fixtures';
export const demoAccount={email:'demo@exacth2o.com',password:'exacth2o-demo'};
const sessionKey='exacth2o.portal.demoSession',handoffKey='exacth2o.portal.demoHandoff';
const store=()=>{try{return window.sessionStorage;}catch{return null;}};
const accepts=(email:unknown,password:unknown)=>String(email??'').trim().toLowerCase()===demoAccount.email&&password===demoAccount.password;
// The real sign-in page hands the demo account over through sessionStorage; consume it once.
export function demoSession(){const s=store();if(!s)return false;const raw=s.getItem(handoffKey);if(raw){s.removeItem(handoffKey);try{const h=JSON.parse(raw);if(accepts(h.email,h.password))s.setItem(sessionKey,'1');}catch{}}return s.getItem(sessionKey)==='1';}
export function demoSignedIn(){return store()?.getItem(sessionKey)==='1';}
const session=()=>({user:{id:'demo-account',email:demoAccount.email,role:'authenticated'},access_token:'demo',token_type:'bearer',expires_at:Math.floor(Date.now()/1000)+86400});
// Live feed: every 30 s each pot reports again. Levels drift down between irrigations; pots with
// controller-managed watering get a pulse when they reach their target. Pure sample behaviour.
type Handler=(payload:{new:any})=>void;
const levels=new Map<string,number>();for(const r of fixture.data.readings)levels.set(r.pairing_name,r.calibrated_value);
const managed=new Set(fixture.experiments.filter((e:any)=>e.wateringState==='controller_managed').flatMap((e:any)=>e.pairingNames));
const channels=new Set<DemoChannel>();
let sequence=0;
function nextReading(p:any){const seed=(p.id*2654435761+sequence*97)>>>0,r=((seed*1664525+1013904223)>>>0)/4294967296;let level=levels.get(p.name)??30;const hour=new Date().getHours(),daytime=1+.6*Math.sin(Math.PI*((hour-6+24)%24)/12);level-=(.003+p.id%7*.0006)*daytime+(r-.5)*.08;if(managed.has(p.name)&&level<p.wtc_percent_limit-.4){level+=2.4+r*1.6;const at=new Date().toISOString();const event={id:p.id*1000000+sequence,event_id:`demo-live-water:${p.id}:${sequence}`,organization_id:'sample',project_id:'sample',device_id:'sample',pairing_name:p.name,valve_key:p.valve_key,source_valve_id:p.id,action:'open',duration_ms:p.valve_open_time_ms,device_recorded_at:at,server_received_at:at};fixture.valveEvents.push(event);for(const channel of channels)for(const h of channel.handlers)if(h.table==='valve_events')h.handler({new:event});}level=Math.round(Math.max(12,Math.min(52,level))*100)/100;levels.set(p.name,level);const at=new Date().toISOString();return {id:p.id*1000+200+sequence,event_id:`live-device:${p.id}:${sequence}`,organization_id:'sample',project_id:'sample',device_id:'sample',pairing_name:p.name,sensor_key:p.sensor_key,raw_value:level,calibrated_value:level,temperature:Math.round((23.5+daytime)*10)/10,electrical_conductivity:.8,device_recorded_at:at,server_received_at:at};}
class DemoChannel{handlers:{table:string,handler:Handler}[]=[];timer:ReturnType<typeof setInterval>|null=null;
 on(_type:string,filter:any,handler:Handler){this.handlers.push({table:filter?.table,handler});return this;}
 subscribe(){channels.add(this);if(!this.timer&&this.handlers.some(h=>h.table==='sensor_readings'))this.timer=setInterval(()=>this.tick(),30000);return this;}
 tick(){sequence++;for(const p of fixture.data.pairings){const row=nextReading(p);fixture.data.readings.push(row);for(const h of this.handlers)if(h.table==='sensor_readings')h.handler({new:row});}fixture.data.latestLiveReading=fixture.data.readings.at(-1);}
 close(){channels.delete(this);if(this.timer)clearInterval(this.timer);this.timer=null;this.handlers=[];}
}
const success=(data:unknown)=>Promise.resolve({data,error:null});
const unavailable=()=>Promise.resolve({data:null,error:{message:'The demo account can monitor only. Changes need a connected installation.'}});
const lighting={project_id:"sample",device_id:"sample",bridge_ready:true,bridge_version:"sample",state_revision:1,requested_intensity:134,controller_intensity:134,last_nonzero_intensity:134,last_source:"portal",hardware_verification:"unavailable",controller_process_started_at:new Date().toISOString(),remote_control_allowed:true,last_command:null};
const schedules:any[]=[];
export const supabase={
 rpc(name:string,args:any={}){if(name==="lighting_native_status")return success({...lighting,last_bridge_at:new Date().toISOString()});if(name==="chamber_schedule_overview")return success({schedules,runs:[],can_control:true,scheduler_online:true});if(name==="chamber_schedule_save"){const item={...args.definition,id:args.schedule_id||`sample-${schedules.length+1}`,owner:"Sample",next_run_at:null,version:1,can_resume:true};const index=schedules.findIndex(s=>s.id===item.id);if(index<0)schedules.push(item);else schedules[index]=item;return success({ok:true});}if(name==="chamber_schedule_delete"){const index=schedules.findIndex(s=>s.id===args.p_schedule_id);if(index>=0)schedules.splice(index,1);return success({ok:true});}if(name==="chamber_schedule_pause"||name==="chamber_schedule_resume"){const s=schedules.find(s=>s.id===args.p_schedule_id);if(s)s.enabled=name.endsWith("resume");return success({ok:true});}if(name.startsWith('walker_live_observation_'))return success(walkerSnapshot());if(name==='gas_mixer_native_status')return success({...mixer,last_bridge_at:new Date().toISOString()});if(name==='gas_mixer_remote_status')return success({project_id:'sample',device_id:'sample',device_name:'Gas Mixer',online:true,last_seen_at:new Date().toISOString(),remote_control_allowed:true,active_session:false,active_controller_email:null});return unavailable();},
 functions:{invoke(name:string,options:any){if(name==="lighting-native-control"){lighting.requested_intensity=options.body.intensity;lighting.controller_intensity=options.body.intensity;lighting.state_revision++;return success({ok:true,command:{id:"sample",status:"observed",intensity:options.body.intensity}});}if(name==='gas-mixer-native-control'){const {field,value}=options.body;if(field==='total_slpm'||field==='use_licor')(mixer.requested_state as any)[field]=value;else{const [,address,prop]=field.split('.');(mixer.requested_state.channels as any)[address][prop]=value;}mixer.state_revision++;return success({ok:true,command:{id:'sample',status:'verified'},requested_state:mixer.requested_state});}return unavailable();}},
 from(table:string){let rows:any[]=table==='sensor_readings'?fixture.data.readings:table==='pairings'?fixture.data.pairings:table==='valve_events'?fixture.valveEvents:[];const q:any=new Proxy({}, {get(_t,key){if(key==='then')return (resolve:any)=>resolve({data:rows,error:null});if(key==='single'||key==='maybeSingle')return ()=>success(rows[0]||null);return ()=>q;}});return q;},
 auth:{
  getSession:()=>success({session:demoSignedIn()?session():null}),
  signInWithPassword:({email,password}:{email:string,password:string})=>{if(accepts(email,password)){store()?.setItem(sessionKey,'1');return success({user:session().user,session:session()});}return Promise.resolve({data:{user:null,session:null},error:{message:'Invalid login credentials'}});},
  signOut:()=>{store()?.removeItem(sessionKey);return success(null);},
  onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}}),
  resetPasswordForEmail:()=>unavailable(),updateUser:()=>unavailable(),
 },
 channel(){return new DemoChannel();},removeChannel(channel:any){channel?.close?.();},
};
