-- One-click lifecycle actions preserve command guards and past run receipts.
alter table public.chamber_schedules add column deleted_at timestamptz;
alter table public.chamber_schedules add constraint chamber_deleted_schedule_disabled check (deleted_at is null or not enabled);

create or replace function public.chamber_schedule_save(schedule_id uuid, definition jsonb) returns uuid
language plpgsql security definer set search_path=public,pg_temp as $$
declare s public.chamber_schedules%rowtype; existing public.chamber_schedules%rowtype;
 other public.chamber_schedules%rowtype; candidate timestamptz; other_at timestamptz; d date;
begin
 if not public.chamber_schedule_access(auth.uid()) then raise exception 'Gas mixer control access is required' using errcode='42501'; end if;
 perform pg_advisory_xact_lock(74120910);
 if schedule_id is null and (select count(*) from public.chamber_schedules where deleted_at is null)>=100 then raise exception 'Schedule limit reached; edit an existing schedule'; end if;
 if schedule_id is not null then
   select * into existing from public.chamber_schedules where id=schedule_id and deleted_at is null for update;
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

create or replace function public.chamber_schedule_overview() returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
begin
 if not public.chamber_schedule_access(auth.uid(),'remote_view') then raise exception 'Gas mixer access is required' using errcode='42501'; end if;
 return jsonb_build_object('can_control',public.chamber_schedule_access(auth.uid()),'server_time',now(),
 'scheduler_online',coalesce((select d.end_time>now()-interval '30 seconds' from cron.job_run_details d join cron.job j on j.jobid=d.jobid where j.jobname='exacth2o-chamber-schedules' and j.active and d.status='succeeded' order by d.runid desc limit 1),false),
 'schedules',coalesce((select jsonb_agg(to_jsonb(s)||jsonb_build_object('owner',coalesce(u.email,'Researcher'),'can_resume',public.chamber_schedule_next(s.local_time,s.weekdays,s.starts_on,s.ends_on,s.repeat_daily,now()+interval '1 minute') is not null) order by s.local_time,s.created_at)
   from public.chamber_schedules s join auth.users u on u.id=s.owner_id where s.deleted_at is null),'[]'::jsonb),
 'runs',coalesce((select jsonb_agg(to_jsonb(r) order by r.due_at desc) from
   (select id,schedule_id,name,due_at,status,detail,gas_status,light_status,completed_at from public.chamber_schedule_runs order by due_at desc limit 40) r),'[]'::jsonb));
end $$;


create function public.chamber_schedule_resume(p_schedule_id uuid, expected_version integer)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare s public.chamber_schedules%rowtype; next_at timestamptz;
begin
 if not public.chamber_schedule_access(auth.uid()) then raise exception 'Gas mixer control access is required' using errcode='42501'; end if;
 perform pg_advisory_xact_lock(74120910);
 select * into s from public.chamber_schedules where id=p_schedule_id and deleted_at is null for update;
 if not found then raise exception 'This schedule was deleted. Refresh the list.'; end if;
 if expected_version is distinct from s.version then raise exception 'This schedule changed. Refresh the list and try again.'; end if;
 if s.enabled then return jsonb_build_object('resumed',true,'next_run_at',s.next_run_at); end if;
 next_at:=public.chamber_schedule_next(s.local_time,s.weekdays,s.starts_on,s.ends_on,s.repeat_daily,now()+interval '1 minute');
 if next_at is null then return jsonb_build_object('resumed',false,'needs_new_time',true); end if;
 perform public.chamber_schedule_save(s.id,to_jsonb(s)||jsonb_build_object('enabled',true));
 return jsonb_build_object('resumed',true,'next_run_at',next_at);
end $$;

create function public.chamber_schedule_delete(p_schedule_id uuid, expected_version integer)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare s public.chamber_schedules%rowtype;
begin
 if not public.chamber_schedule_access(auth.uid()) then raise exception 'Gas mixer control access is required' using errcode='42501'; end if;
 perform pg_advisory_xact_lock(74120910);
 select * into s from public.chamber_schedules where id=p_schedule_id for update;
 if not found or s.deleted_at is not null then return; end if;
 if expected_version is distinct from s.version then raise exception 'This schedule changed. Refresh the list before deleting it.'; end if;
 perform public.chamber_schedule_pause(s.id);
 update public.chamber_schedules set deleted_at=now(),next_run_at=null,enabled=false,updated_by=auth.uid(),updated_at=now(),version=version+1 where id=s.id;
end $$;
revoke all on function public.chamber_schedule_resume(uuid,integer),public.chamber_schedule_delete(uuid,integer) from public,anon,service_role;
grant execute on function public.chamber_schedule_resume(uuid,integer),public.chamber_schedule_delete(uuid,integer) to authenticated;
notify pgrst, 'reload schema';
