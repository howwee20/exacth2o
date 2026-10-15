import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
const origins = new Set(['https://exacth2o.com','https://www.exacth2o.com','http://127.0.0.1:4899']);
serve(async request => {
  const origin=request.headers.get('origin') || '';
  const headers={'Access-Control-Allow-Origin':origins.has(origin)?origin:'https://exacth2o.com','Access-Control-Allow-Headers':'authorization, apikey, content-type, x-client-info','Access-Control-Allow-Methods':'POST, OPTIONS','Vary':'Origin','Content-Type':'application/json','Cache-Control':'no-store'};
  const reply=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers});
  if(request.method==='OPTIONS')return new Response('ok',{headers});
  if(request.method!=='POST'||(origin&&!origins.has(origin)))return reply({error:'Request not allowed'},403);
  try {
    const admin=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,{auth:{persistSession:false}});
    const jwt=(request.headers.get('authorization')||'').replace(/^Bearer\s+/i,'');
    const {data:{user},error:authError}=await admin.auth.getUser(jwt);
    if(authError||!user)return reply({error:'Sign in to use manual watering'},401);
    const body=await request.json();
    if(!['start','renew','stop','status'].includes(body.action)||!Number.isInteger(body.sequence)||body.sequence<0||!/^[-a-f0-9]{36}$/i.test(body.sessionId||''))return reply({error:'Invalid hold request'},400);
    const {data:access,error:accessError}=await admin.from('portal_access').select('role').eq('access_scope','project').eq('project_id',body.projectId).eq('user_id',user.id).maybeSingle();
    if(accessError||!access||!['admin','researcher'].includes(access.role))return reply({error:'Controller operator access required'},403);
    // The server owns both the device destination and route. Never accept a URL from a browser.
    if(body.projectId!==Deno.env.get('HEALTH_SYNC_PROJECT_ID')||body.deviceId!==Deno.env.get('HEALTH_SYNC_DEVICE_ID'))return reply({error:'Hold-to-water is unavailable on this controller'},409);
    const secret=Deno.env.get('EXACTH2O_MANUAL_HOLD_SECRET');
    if(!secret)return reply({error:'Hold-to-water is awaiting controller commissioning'},503);
    const {data:config,error:configError}=await admin.from('device_config_state').select('pairings').eq('project_id',body.projectId).eq('device_id',body.deviceId).maybeSingle();
    const pairing=Array.isArray(config?.pairings)?config.pairings.find((p:Record<string,unknown>)=>p.name===body.pairingName):null;
    if(configError||!pairing)return reply({error:'Pot mapping unavailable; refresh Find pot'},409);
    const relayAddress=Number(pairing.Valve?.relayAddress),address=Number(pairing.Valve?.address);
    if(!Number.isInteger(relayAddress)||!Number.isInteger(address))return reply({error:'Invalid pot route'},409);
    // Bind to the original browser press time, so a delayed request cannot start water after release.
    const sentAt=Number(body.sentAt),now=Date.now();
    if(['start','renew'].includes(body.action)&&(!Number.isFinite(sentAt)||sentAt<now-2000||sentAt>now+1000))return reply({error:'Hold signal expired; release and try again'},409);
    const payload={action:body.action,sessionId:body.sessionId,ownerId:user.id,sequence:body.sequence,expiresAt:Math.min(now+2000,sentAt+2500),relayAddress,address,sensorId:pairing.sensorId,valveId:pairing.valveId};
    const base=Deno.env.get('OWNER_HEALTH_BASE_URL')||`https://${body.deviceId}.balena-devices.com/owner-health`;
    const result=await fetch(`${base.replace(/\/$/,'')}/api/manual-hold`,{method:'POST',headers:{'Content-Type':'application/json','X-ExactH2O-Hold-Secret':secret},body:JSON.stringify(payload),signal:AbortSignal.timeout(3500)});
    const data=await result.json();
    return reply(data,result.status);
  } catch {return reply({error:'Controller response unavailable. Release the button; the controller expires the hold locally.'},503);}
});
