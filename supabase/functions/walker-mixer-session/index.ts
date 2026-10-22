import {createClient} from "https://esm.sh/@supabase/supabase-js@2";
import {bridgeEnabled, linkedIdentities} from "./bridge-policy.mjs";

// Deployed as version 5 on 2026-09-19 with gateway verify_jwt off (callers hold a Walker Lab
// session, not an ExactH2O one). This copy changes only two things: the bridge is off unless
// WALKER_MIXER_SESSION_ENABLED is "true", and the linked accounts are read from a secret.
Deno.serve(async req=>{
 const headers={"Content-Type":"application/json","Cache-Control":"no-store"};
 const reply=(s:number,v:unknown)=>new Response(JSON.stringify(v),{status:s,headers});
 if(req.method!=="POST")return reply(405,{error:"Method not allowed"});
 if(!bridgeEnabled(Deno.env.toObject()))return reply(503,{error:"Mixer sign-in is unavailable. Contact the lab administrator."});
 const identities=linkedIdentities(Deno.env.get("WALKER_MIXER_SESSION_IDENTITIES"));
 try {
 const input=await req.json();
 if(typeof input.cookie!=="string"||input.cookie.length>4096)return reply(400,{error:"Invalid session"});
 const check=await fetch("https://depi.berkleywalker.org/api/account",{headers:{Cookie:input.cookie},redirect:"error"});
 if(check.status!==200)return reply(401,{error:"Sign in to Walker Lab first"});
 const account=await check.json();const email=String(account.username||"").toLowerCase();const id=identities[email];
 if(!id||!["admin","operator"].includes(account.role))return reply(403,{error:"No linked gas mixer account. Contact the lab administrator."});
 const url=Deno.env.get("SUPABASE_URL")!;const service=createClient(url,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,{auth:{persistSession:false,autoRefreshToken:false}});
 const existing=await service.auth.admin.getUserById(id);
 if(existing.error||existing.data.user?.email!==email||!existing.data.user?.email_confirmed_at)return reply(403,{error:"Linked account unavailable"});
 const link=await service.auth.admin.generateLink({type:"magiclink",email});
 if(link.error||link.data.user?.id!==id)return reply(503,{error:"Could not connect account"});
 const user=createClient(url,Deno.env.get("SUPABASE_ANON_KEY")!,{auth:{persistSession:false,autoRefreshToken:false}});
 const verified=await user.auth.verifyOtp({token_hash:link.data.properties.hashed_token,type:"magiclink"});
 if(verified.error||!verified.data.session||verified.data.user?.id!==id)return reply(503,{error:"Could not connect account"});
 const access=await user.rpc("has_gas_mixer_native_access",{check_project_id:"44444444-4444-4444-8444-444444444441",check_device_id:"gas-mixer:b827eb548a44",check_capability:"remote_control"});
 if(access.error||access.data!==true)return reply(403,{error:"Existing mixer control permission is required"});
 return reply(200,{access_token:verified.data.session.access_token,refresh_token:verified.data.session.refresh_token});
 }catch{return reply(503,{error:"Mixer sign-in connection unavailable"});}
});
