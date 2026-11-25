-- Only runs explicitly started with the phone-independent worker may be dispatched.
alter table public.rhee_discovery_runs
  add column worker_version integer not null default 1,
  add column dispatch_token uuid,
  add column dispatch_after timestamptz not null default now();
update public.rhee_discovery_runs set status='review', revision=revision+1, lease_until=null, updated_at=now(),
  progress=progress||jsonb_build_object('phase','review','message','Setup saved. The earlier phone-driven run has stopped. Return to setup to review the pots before starting again.')
where worker_version=1 and status='running';

create function public.dispatch_rhee_discovery() returns void language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare job record;
begin
  for job in update public.rhee_discovery_runs set dispatch_token=gen_random_uuid(), dispatch_after=now()+interval '45 seconds'
    where worker_version=2 and status in ('running','applying') and dispatch_after<=now() and (lease_until is null or lease_until<=now())
    returning id,dispatch_token loop
    perform net.http_post(url:='https://zmhdclcjrkntrpynozvo.supabase.co/functions/v1/rhee-discovery',
      headers:=jsonb_build_object('Content-Type','application/json','x-rhee-ticket',job.dispatch_token::text),
      body:=jsonb_build_object('action','dispatch','id',job.id),timeout_milliseconds:=105000);
  end loop;
end $$;
revoke all on function public.dispatch_rhee_discovery() from public,anon,authenticated,service_role;
select cron.schedule('advance-rhee-autopair','5 seconds','select public.dispatch_rhee_discovery()');

-- Enqueuing and stopping take the same row lock; an old worker cannot enqueue after a stop.
create function public.pulse_rhee_discovery(run_id uuid, expected_revision integer, pot integer, cmd uuid, expected_valve text) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.rhee_discovery_runs; outlet public.manual_valve_routes;
begin
  select * into strict r from public.rhee_discovery_runs where id=run_id for update;
  if r.status<>'running' or r.worker_version<>2 or r.revision<>expected_revision or r.lease_until is null or r.lease_until<=now()
    or r.progress->>'phase' is distinct from 'pulse' or r.progress->>'command' is distinct from cmd::text
    or (r.setup->'pots'->((r.progress->>'potIndex')::int)->>'pot')::int is distinct from pot then raise exception 'This pulse is no longer due'; end if;
  select * into strict outlet from public.manual_valve_routes where project_id=r.project_id and device_id=r.device_id and pot_number=pot and status='confirmed';
  if expected_valve is distinct from '0x'||to_hex(outlet.relay_address::integer)||':'||outlet.channel::text then raise exception 'Valve route changed'; end if;
  if exists(select 1 from public.experiments e join public.experiment_assignments a on a.experiment_id=e.id and a.revision_id=e.current_revision_id
    where e.project_id=r.project_id and e.status in ('active','activating','published_sensing','activation_failed') and (a.pot_number=pot or lower(a.valve_key_snapshot)=expected_valve)) then raise exception 'Outlet is reserved by a current experiment'; end if;
  perform public.enqueue_portal_control_command(r.project_id,r.device_id,'manual_water',jsonb_build_object('valve_keys',jsonb_build_array('0x'||to_hex(outlet.relay_address::integer)||':'||outlet.channel::text),'duration_seconds',3,'total_valve_seconds',3),r.owner_id,now()+interval '45 seconds',true,now(),cmd);
  update public.rhee_discovery_runs set progress=progress||jsonb_build_object('phase','receipt','pulseAt',floor(extract(epoch from now())*1000),'message','Waiting for controller confirmation for pot '||pot) where id=run_id;
end $$;
revoke all on function public.pulse_rhee_discovery(uuid,integer,integer,uuid,text) from public,anon,authenticated;
grant execute on function public.pulse_rhee_discovery(uuid,integer,integer,uuid,text) to service_role;

create function public.stop_rhee_discovery(run_id uuid,keep_setup boolean) returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.rhee_discovery_runs;
begin
  select * into strict r from public.rhee_discovery_runs where id=run_id for update;
  if keep_setup and r.status<>'running' then raise exception 'Only a running Autopair can be stopped'; end if;
  if r.status='applying' then raise exception 'Wait for installation to finish'; end if;
  update public.project_control_commands set status='canceled',completed_at=now() where project_id=r.project_id and device_id=r.device_id and command_type='manual_water' and status='queued' and client_request_id=nullif(r.progress->>'command','')::uuid;
  update public.rhee_discovery_runs set status=case when keep_setup then 'review' else 'closed' end,revision=revision+1,lease_until=null,dispatch_token=null,updated_at=now(),
    progress=case when keep_setup then progress||jsonb_build_object('phase','review','message','Autopair stopped. Any pulse already in progress closes on its timer. Your setup is saved.',
      'missing',coalesce((select jsonb_agg(p->'pot') from jsonb_array_elements(r.setup->'pots') p where not exists (select 1 from jsonb_array_elements(r.progress->'matches') m where m->'pot'=p->'pot')),'[]'::jsonb)) else progress end where id=run_id;
end $$;
revoke all on function public.stop_rhee_discovery(uuid,boolean) from public,anon,authenticated;
grant execute on function public.stop_rhee_discovery(uuid,boolean) to service_role;
