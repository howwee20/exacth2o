import { useEffect, useRef, useState } from 'react';
import { supabase } from './supabase';
import type { PairingRow } from './types';

type Phase = 'checking'|'ready'|'starting'|'watering'|'stopping'|'stopped'|'unavailable'|'unknown';
type Session = {id:string; token:string; sequence:number; released:boolean; timer?:number};
export function HoldWaterControl({projectId,deviceId,pairing}:{projectId:string;deviceId:string;pairing:PairingRow}) {
  const [phase,setPhase]=useState<Phase>('checking');
  const [message,setMessage]=useState('Checking controller…');
  const [elapsed,setElapsed]=useState(0);
  const current=useRef<Session|null>(null);
  const mounted=useRef(true);
  const busy=useRef(false);
  const stopRef=useRef<()=>void>(()=>{});
  async function call(action:string,session:Session) {
    const response=await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/manual-hold`,{
      method:'POST',headers:{'Content-Type':'application/json',apikey:import.meta.env.VITE_SUPABASE_ANON_KEY,Authorization:`Bearer ${session.token}`},
      body:JSON.stringify({action,sessionId:session.id,sequence:session.sequence++,sentAt:Date.now(),projectId,deviceId,pairingName:pairing.name}),
      signal:AbortSignal.timeout(4500),keepalive:action==='stop',
    });
    const data=await response.json();if(!response.ok)throw new Error(data.error||'Controller unavailable');return data;
  }
  const show=(next:Phase,text:string)=>{if(mounted.current){setPhase(next);setMessage(text);}};
  async function stop(session=current.current) {
    if(!session)return;
    session.released=true;window.clearTimeout(session.timer);
    if(current.current===session)show('stopping','Stopping…');
    try { const data=await call('stop',session);if(data.status!=='closed')throw new Error('Stop not confirmed');if(current.current===session)show('stopped','Stopped · controller confirmed'); }
    catch {if(current.current===session)show('unknown','Stop confirmation unavailable. The controller expires the hold locally; check the outlet before continuing.');}
    finally {if(current.current===session){current.current=null;busy.current=false;}}
  }
  stopRef.current=()=>{void stop();};
  useEffect(()=>{
    mounted.current=true;let cancelled=false;
    void (async()=>{
      try {
        const {data:{session}}=await supabase.auth.getSession();if(!session)throw new Error('Sign in to water manually');
        const result=await call('status',{id:crypto.randomUUID(),token:session.access_token,sequence:0,released:true});
        if(!cancelled)show(result.available?'ready':'unavailable',result.available?'Hold to water. Release to stop.':'Hold-to-water is awaiting controller commissioning.');
      }catch(error){if(!cancelled)show('unavailable',error instanceof Error?error.message:'Controller unavailable');}
    })();
    const blur=()=>stopRef.current();
    const hidden=()=>{if(document.hidden)blur();};
    window.addEventListener('blur',blur);window.addEventListener('pagehide',blur);document.addEventListener('visibilitychange',hidden);
    return ()=>{cancelled=true;mounted.current=false;stopRef.current();window.removeEventListener('blur',blur);window.removeEventListener('pagehide',blur);document.removeEventListener('visibilitychange',hidden);};
    // The component is keyed by controller and pairing; each mount has a fixed destination.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);
  async function start() {
    if(busy.current||!['ready','stopped'].includes(phase))return;
    busy.current=true;
    // Register the press before awaiting credentials so release can cancel it.
    const session:Session={id:crypto.randomUUID(),token:'',sequence:0,released:false};current.current=session;
    show('starting','Starting…');setElapsed(0);
    try {
      const {data:{session:auth}}=await supabase.auth.getSession();if(!auth)throw new Error('Sign in to water manually');
      session.token=auth.access_token;
      if(session.released)return;
      const tick=async(action:'start'|'renew')=>{
        if(session.released)return;
        try {
          const result=await call(action,session);
          if(session.released){await stop(session);return;}
          if(result.status!=='open'){session.released=true;current.current=null;busy.current=false;show('stopped','Stopped · release, then hold again');return;}
          setElapsed(Math.max(0,(Date.now()-result.startedAt)/1000));show('watering','Watering · controller confirmed');
          session.timer=window.setTimeout(()=>void tick('renew'),600);
        }catch(error){session.released=true;await stop(session);if(mounted.current)setMessage(error instanceof Error?error.message:'Controller connection lost');}
      };
      await tick('start');
    }catch(error){busy.current=false;current.current=null;show('unavailable',error instanceof Error?error.message:'Controller unavailable');}
    finally{if(session.released&&!session.token){busy.current=false;}}
  }
  function release(){const s=current.current;if(s&&!s.token){s.released=true;current.current=null;busy.current=false;show('stopped','Stopped');}else void stop(s);}
  const enabled=['ready','stopped','starting','watering'].includes(phase);
  return <section className="px-manual-water" aria-label={`Manual water pot ${pairing.pot_number}`}>
    <h3>Manual water</h3>
    <p className="px-small px-muted">Overrides moisture targets, schedules and watering pauses for this hold. Maximum 15 seconds.</p>
    <p className="px-small">Valve <strong>{pairing.valve_key}</strong> · Sensor {pairing.sensor_key}</p>
    <button type="button" className={`px-button px-hold-water ${phase==='watering'?'is-watering':''}`} disabled={!enabled}
      onPointerDown={event=>{if(event.button!==0)return;event.preventDefault();event.currentTarget.setPointerCapture(event.pointerId);void start();}}
      onPointerUp={release} onPointerCancel={release} onLostPointerCapture={release} onBlur={release}
      onKeyDown={event=>{if((event.key===' '||event.key==='Enter')&&!event.repeat){event.preventDefault();void start();}if(event.key==='Escape')release();}}
      onKeyUp={event=>{if(event.key===' '||event.key==='Enter'){event.preventDefault();release();}}}
      onContextMenu={event=>event.preventDefault()}>
      {phase==='watering'?`Watering · ${elapsed.toFixed(1)} s`:'Hold to water'}
    </button>
    <p role="status" aria-live="polite" className="px-small">{message}</p>
  </section>;
}
