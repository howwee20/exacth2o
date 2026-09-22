// Demo portal backend: in-memory sample data, one shared read-only account, readings that keep arriving.
// Nothing here reaches Supabase or a controller; the page's CSP allows no network connections.
import {fixture,walkerSnapshot,mixer,nextDemoSample} from './fixtures';
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
const channels=new Set<DemoChannel>();
function nextReading(p:any){
 const {reading,event}=nextDemoSample(p,Date.now());
 if(event){fixture.valveEvents.push(event);for(const channel of channels)for(const h of channel.handlers)if(h.table==='valve_events')h.handler({new:event});}
 return reading;
}
class DemoChannel{handlers:{table:string,handler:Handler}[]=[];timer:ReturnType<typeof setInterval>|null=null;
 on(_type:string,filter:any,handler:Handler){this.handlers.push({table:filter?.table,handler});return this;}
 subscribe(){channels.add(this);if(!this.timer&&this.handlers.some(h=>h.table==='sensor_readings'))this.timer=setInterval(()=>this.tick(),30000);return this;}
 tick(){for(const p of fixture.data.pairings){const row=nextReading(p);fixture.data.readings.push(row);for(const h of this.handlers)if(h.table==='sensor_readings')h.handler({new:row});}fixture.data.latestLiveReading=fixture.data.readings.at(-1);}
 close(){channels.delete(this);if(this.timer)clearInterval(this.timer);this.timer=null;this.handlers=[];}
}
const success=(data:unknown)=>Promise.resolve({data,error:null});
const unavailable=()=>Promise.resolve({data:null,error:{message:'The demo account can monitor only. Changes need a connected installation.'}});
const lighting={project_id:"sample",device_id:"sample",bridge_ready:true,bridge_version:"sample",state_revision:1,requested_intensity:134,controller_intensity:134,last_nonzero_intensity:134,last_source:"portal",hardware_verification:"unavailable",controller_process_started_at:new Date().toISOString(),remote_control_allowed:true,last_command:null};
export const supabase={
 // Explicit read allowlist. Every command/function call is denied, including simulated controls.
 rpc(name:string){
  if(name==='lighting_native_status')return success({...lighting,remote_control_allowed:false});
  if(name==='chamber_schedule_overview')return success({schedules:[],runs:[],can_control:false,scheduler_online:false});
  if(['walker_live_observation_snapshot','walker_live_observation_series'].includes(name))return success(walkerSnapshot());
  if(name==='gas_mixer_native_status')return success({...mixer,remote_control_allowed:false});
  return unavailable();
 },
 functions:{invoke:()=>unavailable()},
 from(table:string){let rows:any[]=table==='sensor_readings'?fixture.data.readings:table==='pairings'?fixture.data.pairings:table==='valve_events'?fixture.valveEvents:[];const q:any=new Proxy({}, {get(_t,key){if(['insert','update','upsert','delete'].includes(String(key)))return ()=>unavailable();if(key==='then')return (resolve:any)=>resolve({data:rows,error:null});if(key==='single'||key==='maybeSingle')return ()=>success(rows[0]||null);return ()=>q;}});return q;},
 auth:{
  getSession:()=>success({session:demoSignedIn()?session():null}),
  signInWithPassword:({email,password}:{email:string,password:string})=>{if(accepts(email,password)){store()?.setItem(sessionKey,'1');return success({user:session().user,session:session()});}return Promise.resolve({data:{user:null,session:null},error:{message:'Invalid login credentials'}});},
  signOut:()=>{store()?.removeItem(sessionKey);return success(null);},
  onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}}),
  resetPasswordForEmail:()=>unavailable(),updateUser:()=>unavailable(),
 },
 channel(){return new DemoChannel();},removeChannel(channel:any){channel?.close?.();},
};
