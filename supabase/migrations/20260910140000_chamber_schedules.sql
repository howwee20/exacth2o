-- Cloud schedules reuse the existing authenticated device bridges. No device
-- credentials or user sessions are stored; no schedule is enabled by migration.
create table public.chamber_schedules (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id),
  name text not null check (length(name) between 1 and 80),
  local_time time not null,
  weekdays integer[] not null,
  starts_on date not null,
  ends_on date,
  repeat_daily boolean not null default true,
  actions jsonb not null,
  enabled boolean not null default false,
  next_run_at timestamptz,
  version integer not null default 1,
  updated_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_on is null or ends_on >= starts_on),
  check (cardinality(weekdays) between 1 and 7 and weekdays <@ array[0,1,2,3,4,5,6])
);
create table public.chamber_schedule_runs (
  id uuid primary key default gen_random_uuid(),
  schedule_id uuid not null references public.chamber_schedules(id),
  version integer not null,
  due_at timestamptz not null,
  name text not null,
  owner_id uuid not null references auth.users(id),
  actions jsonb not null,
  status text not null default 'running' check(status in ('running','applied','failed','missed','cancelled','partial')),
  detail text,
  gas_steps jsonb,
  gas_cursor integer not null default 0,
  gas_command_id uuid references public.gas_mixer_native_commands(id),
  gas_expected_state jsonb,
  light_command_id uuid references public.lighting_commands(id),
  gas_status text not null default 'pending',
  light_status text not null default 'pending',
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  unique(schedule_id, version, due_at)
);
create index chamber_schedules_due on public.chamber_schedules(next_run_at) where enabled;
create index chamber_schedule_runs_active on public.chamber_schedule_runs(started_at) where status='running';
alter table public.chamber_schedules enable row level security;
alter table public.chamber_schedule_runs enable row level security;
revoke all on public.chamber_schedules, public.chamber_schedule_runs from public, anon, authenticated;

-- Explicit owner lookup lets the worker recheck revoked grants without keeping
-- a browser JWT or impersonating the owner through request settings.
create function public.chamber_schedule_access(who uuid, requested_capability text default 'remote_control')
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
 select who is not null and requested_capability in ('remote_view','remote_control') and (
 exists(select 1 from public.gas_mixer_researcher_access a
   join public.portal_access p on p.user_id=a.user_id and p.role in ('researcher','admin')
   where a.user_id=who and a.enabled and a.revoked_at is null
     and (requested_capability='remote_view' or a.can_control))
 or (select count(distinct a.device_id)=2 from public.system_admin_installation_access a
   join public.portal_access p on p.user_id=a.user_id and p.project_id=a.portal_project_id and p.role='admin'
   where a.user_id=who and a.project_id='44444444-4444-4444-8444-444444444441'
     and a.device_id in ('gas-mixer:b827eb548a44','lighting:beagle')
     and a.capability=requested_capability and a.enabled and a.revoked_at is null))
 and exists(select 1 from auth.users u where u.id=who and (u.banned_until is null or u.banned_until<now()));
$$;

create function public.chamber_schedule_next(at_time time, days integer[], first_day date, last_day date,
 recurring boolean, after_time timestamptz) returns timestamptz
language sql stable set search_path=public,pg_temp as $$
 select min((d::date + at_time) at time zone 'America/Detroit')
 from generate_series(greatest(first_day,(after_time at time zone 'America/Detroit')::date)::timestamp,
   least(coalesce(last_day,'infinity'::date), case when recurring then
      greatest(first_day,(after_time at time zone 'America/Detroit')::date)+8 else first_day end)::timestamp,
   interval '1 day') d
 where (not recurring or extract(dow from d)::integer=any(days))
   and (recurring or d::date=first_day)
   and ((d::date+at_time) at time zone 'America/Detroit')>after_time
   -- Skip nonexistent spring-forward times; standard-time occurrence wins in fall.
   and (((d::date+at_time) at time zone 'America/Detroit') at time zone 'America/Detroit')=d::date+at_time;
$$;

create function public.chamber_validate_actions(a jsonb) returns void
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare n numeric; total numeric:=0; k text; g jsonb;
begin
 if a is null or jsonb_typeof(a)<>'object' or not(a ? 'gas' or a ? 'light')
   or exists(select 1 from jsonb_object_keys(a) as keys(key) where keys.key not in ('gas','light')) then
   raise exception 'Choose gas, lights, or both'; end if;
 if a ? 'light' then
   if jsonb_typeof(a->'light')<>'number' then raise exception 'Invalid light intensity'; end if;
   n:=(a->>'light')::numeric;
   if n<>trunc(n) or not(n=0 or n between 10 and 255) then raise exception 'Light intensity must be 0 or 10–255'; end if;
 end if;
 if a ? 'gas' then
   g:=a->'gas';
   if jsonb_typeof(g)<>'object' or jsonb_typeof(g->'total_slpm') is distinct from 'number'
     or jsonb_typeof(g->'use_licor') is distinct from 'boolean'
     or jsonb_typeof(g->'ratios') is distinct from 'object' then raise exception 'A complete gas recipe is required'; end if;
   n:=(g->>'total_slpm')::numeric;
   if n<0 or n>9 or n<>round(n,3) then raise exception 'Total flow must be 0–9 SLPM, up to 3 decimals'; end if;
   foreach k in array array['B','C','D','E','F'] loop
     if jsonb_typeof(g->'ratios'->k) is distinct from 'number' then raise exception 'Missing gas ratio %',k; end if;
     n:=(g->'ratios'->>k)::numeric;
     if k in ('C','D') then
       if n<0 or n>99999 or n<>trunc(n) then raise exception 'PPM must be an integer from 0–99999'; end if;
       total:=total+n/10000;
     else
       if n<0 or n>100 or n<>round(n,1) then raise exception 'Gas percentage must be 0–100, up to 1 decimal'; end if;
       total:=total+n;
     end if;
     if n>0 and not coalesce((select (observed_state->'channels'->k->>'available')::boolean
       from public.gas_mixer_native_device_state where device_id='gas-mixer:b827eb548a44'),false) then
       raise exception 'Gas channel % is unavailable',k;
     end if;
   end loop;
   if total>100 then raise exception 'Gas composition exceeds 100 percent'; end if;
 end if;
end $$;

-- Ignore measured flow noise while detecting manual changes between recipe steps.
create function public.chamber_gas_matches(a jsonb,b jsonb) returns boolean
language sql immutable set search_path=public,pg_temp as $$
 select coalesce(a->'use_licor'=b->'use_licor' and abs((a->>'total_slpm')::numeric-(b->>'total_slpm')::numeric)<0.0001
   and not exists(select 1 from unnest(array['A','B','C','D','E','F']) k where
     abs((a->'channels'->k->>'ratio')::numeric-(b->'channels'->k->>'ratio')::numeric)>0.001
     or abs((a->'channels'->k->>'setpoint')::numeric-(b->'channels'->k->>'setpoint')::numeric)>0.001),false);
$$;

-- These scheduled operations only set ratios, total, and LI-COR, never mutate
-- hardware mappings. This mirrors the original model at zero-flow transitions.
create function public.chamber_gas_apply(s jsonb, op jsonb) returns jsonb
language plpgsql immutable set search_path=public,pg_temp as $$
declare f text:=op->>'field'; k text; t numeric; r numeric; total numeric:=0;
begin
 if f='use_licor' then return jsonb_set(s,'{use_licor}',op->'value'); end if;
 if f='total_slpm' then s:=jsonb_set(s,'{total_slpm}',op->'value');
 else
   k:=split_part(f,'.',2);
   s:=jsonb_set(s,array['channels',k,'ratio'],op->'value');
   foreach k in array array['B','C','D','E','F'] loop
     total:=total+(s->'channels'->k->>'ratio')::numeric/case when k in ('C','D') then 10000 else 1 end;
   end loop;
   if total>100.000001 then raise exception 'Intermediate composition exceeds 100 percent'; end if;
   s:=jsonb_set(s,'{channels,A,ratio}',to_jsonb(greatest(0,100-total)));
 end if;
 t:=(s->>'total_slpm')::numeric;
 foreach k in array array['A','B','C','D','E','F'] loop
   r:=(s->'channels'->k->>'ratio')::numeric;
   s:=jsonb_set(s,array['channels',k,'setpoint'],to_jsonb(r*t/case when k in ('C','D') then 1000 else 100 end));
 end loop;
 return s;
end $$;

create function public.chamber_gas_plan(s jsonb,g jsonb) returns jsonb
language plpgsql immutable set search_path=public,pg_temp as $$
declare ops jsonb:='[]'; k text; changed boolean:=false; n numeric; old numeric; pass integer;
begin
 foreach k in array array['B','C','D','E','F'] loop
   if abs((s->'channels'->k->>'ratio')::numeric-(g->'ratios'->>k)::numeric)>0.001 then changed:=true; end if;
 end loop;
 if (s->>'use_licor')::boolean then ops:=ops||jsonb_build_array(jsonb_build_object('field','use_licor','value',false)); end if;
 if changed and (s->>'total_slpm')::numeric<>0 then
   ops:=ops||jsonb_build_array(jsonb_build_object('field','total_slpm','value',0)); end if;
 -- Reduce existing ratios before increasing others; sums stay within 100%.
 for pass in 1..2 loop
   foreach k in array array['B','C','D','E','F'] loop
     n:=(g->'ratios'->>k)::numeric; old:=(s->'channels'->k->>'ratio')::numeric;
     if (pass=1 and n<old-0.001) or (pass=2 and n>old+0.001) then
       ops:=ops||jsonb_build_array(jsonb_build_object('field','mfc.'||k||'.ratio','value',n));
     end if;
   end loop;
 end loop;
 if (changed and (g->>'total_slpm')::numeric<>0) or (not changed and (s->>'total_slpm')::numeric<>(g->>'total_slpm')::numeric) then
   ops:=ops||jsonb_build_array(jsonb_build_object('field','total_slpm','value',(g->>'total_slpm')::numeric)); end if;
 if (g->>'use_licor')::boolean then ops:=ops||jsonb_build_array(jsonb_build_object('field','use_licor','value',true)); end if;
 return ops;
end $$;

create function public.chamber_schedule_save(schedule_id uuid, definition jsonb) returns uuid
language plpgsql security definer set search_path=public,pg_temp as $$
declare s public.chamber_schedules%rowtype; existing public.chamber_schedules%rowtype;
 other public.chamber_schedules%rowtype; candidate timestamptz; other_at timestamptz; d date;
begin
 if not public.chamber_schedule_access(auth.uid()) then raise exception 'Gas mixer control access is required' using errcode='42501'; end if;
 perform pg_advisory_xact_lock(74120910);
 if schedule_id is null and (select count(*) from public.chamber_schedules)>=100 then raise exception 'Schedule limit reached; edit an existing schedule'; end if;
 if schedule_id is not null then
   select * into existing from public.chamber_schedules where id=schedule_id for update;
   if not found then raise exception 'Schedule not found'; end if;
   if exists(select 1 from public.chamber_schedule_runs where chamber_schedule_runs.schedule_id=existing.id and status='running') then
     raise exception 'Pause this schedule and wait for its current run to finish before editing'; end if;
 end if;
 s.id:=coalesce(schedule_id,gen_random_uuid()); s.owner_id:=coalesce(existing.owner_id,auth.uid());
 s.name:=trim(definition->>'name'); s.local_time:=(definition->>'local_time')::time;
 s.starts_on:=(definition->>'starts_on')::date; s.ends_on:=nullif(definition->>'ends_on','')::date;
 s.repeat_daily:=(definition->>'repeat_daily')::boolean;
 select array_agg(value::integer order by value::integer) into s.weekdays from jsonb_array_elements_text(definition->'weekdays');
 s.actions:=definition->'actions'; s.enabled:=coalesce((definition->>'enabled')::boolean,false);
 if s.name is null or length(s.name) not between 1 and 80 or s.local_time is null or s.starts_on is null
    or s.repeat_daily is null or s.weekdays is null or cardinality(s.weekdays) not between 1 and 7
    or not(s.weekdays <@ array[0,1,2,3,4,5,6]) or extract(second from s.local_time)<>0
    or (s.ends_on is not null and s.ends_on<s.starts_on) then raise exception 'Check the schedule name, date, time, and days'; end if;
 perform public.chamber_validate_actions(s.actions);
 if s.enabled and not public.chamber_schedule_access(s.owner_id) then raise exception 'The schedule owner no longer has control access'; end if;
 s.next_run_at:=public.chamber_schedule_next(s.local_time,s.weekdays,s.starts_on,s.ends_on,s.repeat_daily,now()+interval '1 minute');
 if s.enabled and s.next_run_at is null then raise exception 'Choose a future date and time'; end if;
 if s.enabled then
   -- Resolve overlaps in lab local time, across date ranges and weekday patterns.
   for other in select * from public.chamber_schedules where enabled and id<>s.id
     and ((actions ? 'gas' and s.actions ? 'gas') or (actions ? 'light' and s.actions ? 'light')) loop
     for d in select x::date from generate_series(greatest(s.starts_on,other.starts_on,(now() at time zone 'America/Detroit')::date)::timestamp,
       (greatest(s.starts_on,other.starts_on,(now() at time zone 'America/Detroit')::date)+8)::timestamp,interval '1 day') x loop
       candidate:=public.chamber_schedule_next(s.local_time,s.weekdays,s.starts_on,s.ends_on,s.repeat_daily,(d::timestamp at time zone 'America/Detroit')-interval '1 second');
       other_at:=public.chamber_schedule_next(other.local_time,other.weekdays,other.starts_on,other.ends_on,other.repeat_daily,candidate-interval '3 minutes');
       if candidate is not null and other_at is not null and abs(extract(epoch from candidate-other_at))<180 then
         raise exception 'Conflicts with "%". Leave at least 3 minutes between schedules for the same device.',other.name;
       end if;
     end loop;
   end loop;
 end if;
 insert into public.chamber_schedules(id,owner_id,name,local_time,weekdays,starts_on,ends_on,repeat_daily,actions,enabled,next_run_at,updated_by)
 values(s.id,s.owner_id,s.name,s.local_time,s.weekdays,s.starts_on,s.ends_on,s.repeat_daily,s.actions,s.enabled,s.next_run_at,auth.uid())
 on conflict(id) do update set name=excluded.name,local_time=excluded.local_time,weekdays=excluded.weekdays,
   starts_on=excluded.starts_on,ends_on=excluded.ends_on,repeat_daily=excluded.repeat_daily,actions=excluded.actions,
   enabled=excluded.enabled,next_run_at=excluded.next_run_at,version=chamber_schedules.version+1,updated_by=auth.uid(),updated_at=now();
 return s.id;
end $$;

create function public.chamber_schedule_pause(p_schedule_id uuid default null) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if not public.chamber_schedule_access(auth.uid()) then raise exception 'Gas mixer control access is required' using errcode='42501'; end if;
 perform pg_advisory_xact_lock(74120910);
 update public.chamber_schedules set enabled=false,updated_by=auth.uid(),updated_at=now()
 where id=p_schedule_id or p_schedule_id is null;
 -- Cancel undelivered steps; a command already accepted by a controller may finish.
 update public.gas_mixer_native_commands c set status='failed',completed_at=now(),error_message='Schedule paused'
 from public.chamber_schedule_runs r where r.gas_command_id=c.id and r.status='running'
 and (r.schedule_id=p_schedule_id or p_schedule_id is null) and c.status='queued';
 update public.lighting_commands c set status='failed',completed_at=now(),error_message='Schedule paused'
 from public.chamber_schedule_runs r where r.light_command_id=c.id and r.status='running'
 and (r.schedule_id=p_schedule_id or p_schedule_id is null) and c.status='queued';
 update public.chamber_schedule_runs set status='cancelled',completed_at=now(),detail='Paused; already accepted commands may finish. Check live values.'
 where status='running' and (chamber_schedule_runs.schedule_id=p_schedule_id or p_schedule_id is null);
end $$;

create function public.chamber_schedule_overview() returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
begin
 if not public.chamber_schedule_access(auth.uid(),'remote_view') then raise exception 'Gas mixer access is required' using errcode='42501'; end if;
 return jsonb_build_object('can_control',public.chamber_schedule_access(auth.uid()),'server_time',now(),
 'scheduler_online',coalesce((select d.end_time>now()-interval '30 seconds' from cron.job_run_details d join cron.job j on j.jobid=d.jobid where j.jobname='exacth2o-chamber-schedules' and j.active and d.status='succeeded' order by d.runid desc limit 1),false),
 'schedules',coalesce((select jsonb_agg(to_jsonb(s)||jsonb_build_object('owner',coalesce(u.email,'Researcher')) order by s.local_time,s.created_at)
   from public.chamber_schedules s join auth.users u on u.id=s.owner_id),'[]'::jsonb),
 'runs',coalesce((select jsonb_agg(to_jsonb(r) order by r.due_at desc) from
   (select id,schedule_id,name,due_at,status,detail,gas_status,light_status,completed_at from public.chamber_schedule_runs order by due_at desc limit 40) r),'[]'::jsonb));
end $$;

create function public.chamber_schedule_tick() returns void
language plpgsql security definer set search_path=public,pg_temp as $$
declare s public.chamber_schedules%rowtype; r public.chamber_schedule_runs%rowtype;
 g public.gas_mixer_native_device_state%rowtype; l public.lighting_device_state%rowtype;
 gc public.gas_mixer_native_commands%rowtype; lc public.lighting_commands%rowtype;
 op jsonb; next_state jsonb; command_id uuid; failure text; next_at timestamptz;
 project constant uuid:='44444444-4444-4444-8444-444444444441';
begin
 if not pg_try_advisory_xact_lock(74120910) then return; end if;
 perform set_config('chamber.scheduler','on',true);
 for s in select * from public.chamber_schedules where enabled and next_run_at<=now() order by next_run_at for update loop
   insert into public.chamber_schedule_runs(schedule_id,version,due_at,name,owner_id,actions)
     values(s.id,s.version,s.next_run_at,s.name,s.owner_id,s.actions) on conflict do nothing;
   next_at:=public.chamber_schedule_next(s.local_time,s.weekdays,s.starts_on,s.ends_on,s.repeat_daily,now());
   update public.chamber_schedules set next_run_at=next_at where id=s.id;
 end loop;
 for r in select * from public.chamber_schedule_runs where status='running' order by due_at for update loop
  begin
   failure:=null;
   if not public.chamber_schedule_access(r.owner_id) then raise exception 'Owner control access was revoked'; end if;
   if not (select enabled from public.chamber_schedules where id=r.schedule_id) then raise exception 'Schedule paused'; end if;
   if r.due_at<now()-interval '2 minutes' then
     if r.gas_cursor>0 or r.gas_command_id is not null or r.light_command_id is not null then raise exception 'Execution timed out; check live settings before resuming'; end if;
     update public.chamber_schedule_runs set status='missed',detail='Device unavailable or schedule delayed by over 2 minutes; no late replay',completed_at=now() where id=r.id;
     update public.chamber_schedules set enabled=false where id=r.schedule_id;
     continue;
   end if;
   perform public.chamber_validate_actions(r.actions);
   if r.actions ? 'gas' and r.gas_status<>'applied' then
     select * into g from public.gas_mixer_native_device_state where device_id='gas-mixer:b827eb548a44' for update;
     if not coalesce(g.bridge_connected and g.bridge_ready and g.last_bridge_at>=now()-interval '45 seconds',false) then continue; end if;
     if r.gas_steps is null then
       -- A live remote-control session or another command takes priority.
       if exists(select 1 from public.gas_mixer_remote_sessions where mode='control' and status in ('issued','connected') and expires_at>now()) then
         raise exception 'A researcher is using live remote control'; end if;
       if exists(select 1 from public.gas_mixer_native_commands where status in ('queued','accepted') and expires_at>now()) then continue; end if;
       r.gas_steps:=public.chamber_gas_plan(g.applied_state,r.actions->'gas');
       r.gas_expected_state:=g.applied_state;
       update public.chamber_schedule_runs set gas_steps=r.gas_steps,gas_expected_state=r.gas_expected_state where id=r.id;
     end if;
     if r.gas_command_id is not null then
       select * into gc from public.gas_mixer_native_commands where id=r.gas_command_id;
       if gc.status in ('failed','expired','rejected') then raise exception '%',coalesce(gc.error_message,'Gas command failed'); end if;
       if gc.status not in ('applied','verified') then
         if gc.expires_at<now()-interval '15 seconds' then raise exception 'Gas controller did not acknowledge the command'; end if;
         continue;
       end if;
       if not public.chamber_gas_matches(g.applied_state,r.gas_expected_state) then
         -- LI-COR may legitimately begin changing O2 immediately after enabling.
         if not (gc.payload->>'field'='use_licor' and gc.payload->'value'='true'::jsonb and g.applied_state->'use_licor'='true'::jsonb) then
           if gc.applied_at>now()-interval '15 seconds' then continue; end if;
           raise exception 'Gas settings differ from the acknowledged step; check live controls';
         end if;
       end if;
       r.gas_cursor:=r.gas_cursor+1; r.gas_command_id:=null;
       update public.chamber_schedule_runs set gas_cursor=r.gas_cursor,gas_command_id=null where id=r.id;
     elsif not public.chamber_gas_matches(g.applied_state,r.gas_expected_state) then
       raise exception 'Gas settings changed during the scheduled recipe';
     end if;
     if r.gas_cursor<jsonb_array_length(r.gas_steps) then
       op:=r.gas_steps->r.gas_cursor;
       if op->>'field' like 'mfc.%' and not coalesce((g.observed_state->'channels'->split_part(op->>'field','.',2)->>'available')::boolean,false) then
         raise exception 'Required gas channel is unavailable'; end if;
       next_state:=public.chamber_gas_apply(g.applied_state,op);
       command_id:=gen_random_uuid();
       insert into public.gas_mixer_native_commands(id,project_id,device_id,requested_by,command_type,payload,expected_revision,idempotency_key)
         values(command_id,project,'gas-mixer:b827eb548a44',r.owner_id,'set_field',op,g.state_revision,command_id);
       update public.gas_mixer_native_device_state set requested_state=next_state,updated_at=now() where device_id=g.device_id;
       update public.chamber_schedule_runs set gas_command_id=command_id,gas_expected_state=next_state where id=r.id;
       continue;
     end if;
     r.gas_status:='applied';
     update public.chamber_schedule_runs set gas_status='applied' where id=r.id;
   elsif not (r.actions ? 'gas') then
     r.gas_status:='skipped';
     update public.chamber_schedule_runs set gas_status='skipped' where id=r.id;
   end if;
   -- Combined routines finish the gas recipe before applying the light setting.
   if r.actions ? 'light' then
     if r.light_command_id is null then
       select * into l from public.lighting_device_state where device_id='lighting:beagle' for update;
       if not coalesce(l.bridge_connected and l.bridge_ready and l.last_bridge_at>=now()-interval '15 seconds',false) then continue; end if;
       if exists(select 1 from public.lighting_commands where status in ('queued','received','validated') and expires_at>now()) then continue; end if;
       command_id:=gen_random_uuid();
       insert into public.lighting_commands(id,project_id,device_id,requested_by,intensity,expected_revision,idempotency_key,metadata)
         values(command_id,project,'lighting:beagle',r.owner_id,(r.actions->>'light')::integer,l.state_revision,command_id,jsonb_build_object('schedule_run_id',r.id));
       update public.lighting_device_state set requested_intensity=(r.actions->>'light')::integer,updated_at=now() where device_id=l.device_id;
       update public.chamber_schedule_runs set light_command_id=command_id where id=r.id;
       continue;
     end if;
     select * into lc from public.lighting_commands where id=r.light_command_id;
     if lc.status in ('failed','expired') then raise exception '%',coalesce(lc.error_message,'Lighting command failed'); end if;
     if lc.status<>'observed' then
       if lc.expires_at<now()-interval '15 seconds' then raise exception 'Lighting controller did not acknowledge the command'; end if;
       continue;
     end if;
     r.light_status:='applied';
   else r.light_status:='skipped'; end if;
   update public.chamber_schedule_runs set status='applied',gas_status=r.gas_status,light_status=r.light_status,
     completed_at=now(),detail='Settings confirmed by the controllers; physical output is not independently verified' where id=r.id;
   update public.chamber_schedules set enabled=false where id=r.schedule_id and next_run_at is null;
  exception when others then
   failure:=left(sqlerrm,300);
   update public.gas_mixer_native_commands set status='failed',completed_at=now(),error_message=failure
     where id=r.gas_command_id and status='queued';
   update public.lighting_commands set status='failed',completed_at=now(),error_message=failure
     where id=r.light_command_id and status='queued';
   update public.chamber_schedule_runs set status=case when gas_cursor>0 or gas_command_id is not null or gas_status='applied' or light_command_id is not null then 'partial' else 'failed' end,
     detail=failure||'. Schedule paused; check live settings before resuming.',completed_at=now(),
     gas_status=case when actions ? 'gas' and gas_status<>'applied' then 'failed' else gas_status end,
     light_status=case when actions ? 'light' then 'failed' else 'skipped' end where id=r.id;
   update public.chamber_schedules set enabled=false where id=r.schedule_id;
  end;
 end loop;
 perform set_config('chamber.scheduler','off',true);
end $$;

-- Any manual portal command pauses future schedules for that device. This also
-- serializes manual inserts with the scheduler so it cannot undo a manual stop.
create function public.chamber_schedule_manual_override() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare kind text; actor uuid; r public.chamber_schedule_runs%rowtype;
begin
 if current_setting('chamber.scheduler',true)='on' then return new; end if;
 if tg_table_name='gas_mixer_remote_sessions' then
   if new.mode<>'control' then return new; end if;
   actor:=new.user_id;
 else actor:=new.requested_by; end if;
 perform pg_advisory_xact_lock(74120910);
 kind:=case when tg_table_name='lighting_commands' then 'light' else 'gas' end;
 update public.chamber_schedules set enabled=false,updated_at=now(),updated_by=actor where enabled and actions ? kind;
 for r in select * from public.chamber_schedule_runs where status='running' and actions ? kind for update loop
   update public.gas_mixer_native_commands set status='failed',completed_at=now(),error_message='Manual control took priority' where id=r.gas_command_id and status='queued';
   update public.lighting_commands set status='failed',completed_at=now(),error_message='Manual control took priority' where id=r.light_command_id and status='queued';
   update public.chamber_schedule_runs set status='cancelled',completed_at=now(),detail='Manual control took priority; already accepted commands may finish' where id=r.id;
 end loop;
 return new;
end $$;
create trigger chamber_schedule_manual_session before insert on public.gas_mixer_remote_sessions for each row execute function public.chamber_schedule_manual_override();
create trigger chamber_schedule_manual_gas before insert on public.gas_mixer_native_commands for each row execute function public.chamber_schedule_manual_override();
create trigger chamber_schedule_manual_remote before insert on public.gas_mixer_remote_commands for each row execute function public.chamber_schedule_manual_override();
create trigger chamber_schedule_manual_light before insert on public.lighting_commands for each row execute function public.chamber_schedule_manual_override();

-- Deny direct worker/helper invocation, even through PostgREST. Only the three
-- bounded user RPCs are exposed. The cron worker runs as the database owner.
revoke all on function public.chamber_schedule_access(uuid,text),public.chamber_schedule_next(time,integer[],date,date,boolean,timestamptz),
 public.chamber_validate_actions(jsonb),public.chamber_gas_matches(jsonb,jsonb),public.chamber_gas_apply(jsonb,jsonb),public.chamber_gas_plan(jsonb,jsonb),
 public.chamber_schedule_tick(),public.chamber_schedule_manual_override(),public.chamber_schedule_save(uuid,jsonb),public.chamber_schedule_pause(uuid),public.chamber_schedule_overview()
 from public,anon,authenticated,service_role;
grant execute on function public.chamber_schedule_save(uuid,jsonb),public.chamber_schedule_pause(uuid),public.chamber_schedule_overview() to authenticated;
select cron.schedule('exacth2o-chamber-schedules','5 seconds','select public.chamber_schedule_tick()');
