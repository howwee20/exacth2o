-- One outlet, one open pulse. The worker already refuses to repeat an unconfirmed pulse; this is the
-- database backstop. A new Autopair pulse is refused while an earlier one for the same outlet can still
-- run, and for a pot whose last pulse was never confirmed unless the operator chose that pot again.
create or replace function public.pulse_rhee_discovery(run_id uuid, expected_revision integer, pot integer, cmd uuid, expected_valve text) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.rhee_discovery_runs; outlet public.manual_valve_routes; valve text;
begin
  select * into strict r from public.rhee_discovery_runs where id=run_id for update;
  if r.status<>'running' or r.worker_version<>2 or r.revision<>expected_revision or r.lease_until is null or r.lease_until<=now()
    or r.progress->>'phase' is distinct from 'pulse' or r.progress->>'command' is distinct from cmd::text
    or (r.setup->'pots'->((r.progress->>'potIndex')::int)->>'pot')::int is distinct from pot then raise exception 'This pulse is no longer due'; end if;
  select * into strict outlet from public.manual_valve_routes where project_id=r.project_id and device_id=r.device_id and pot_number=pot and status='confirmed';
  valve:='0x'||to_hex(outlet.relay_address::integer)||':'||outlet.channel::text;
  if expected_valve is distinct from valve then raise exception 'Valve route changed'; end if;
  if exists(select 1 from public.experiments e join public.experiment_assignments a on a.experiment_id=e.id and a.revision_id=e.current_revision_id
    where e.project_id=r.project_id and e.status in ('active','activating','published_sensing','activation_failed') and (a.pot_number=pot or lower(a.valve_key_snapshot)=expected_valve)) then raise exception 'Outlet is reserved by a current experiment'; end if;
  if exists(select 1 from jsonb_array_elements(coalesce(r.progress->'unconfirmed','[]'::jsonb)) u where (u->>'pot')::int=pot)
    and not coalesce(r.progress->'repulse','[]'::jsonb) @> to_jsonb(pot) then raise exception 'Pot % has an unconfirmed pulse and was not chosen for another one',pot; end if;
  if exists(select 1 from public.project_control_commands c where c.project_id=r.project_id and c.device_id=r.device_id and c.command_type='manual_water'
    and c.client_request_id is distinct from cmd and c.payload->'valve_keys' ? valve
    and (c.status='running' or (c.status in ('queued','accepted') and c.expires_at>now()))) then raise exception 'An earlier pulse for this outlet is still open'; end if;
  perform public.enqueue_portal_control_command(r.project_id,r.device_id,'manual_water',jsonb_build_object('valve_keys',jsonb_build_array(valve),'duration_seconds',3,'total_valve_seconds',3),r.owner_id,now()+interval '45 seconds',true,now(),cmd);
  update public.rhee_discovery_runs set progress=progress||jsonb_build_object('phase','receipt','pulseAt',floor(extract(epoch from now())*1000),'message','Waiting for controller confirmation for pot '||pot) where id=run_id;
end $$;
revoke all on function public.pulse_rhee_discovery(uuid,integer,integer,uuid,text) from public,anon,authenticated;
grant execute on function public.pulse_rhee_discovery(uuid,integer,integer,uuid,text) to service_role;

create or replace function public.stop_rhee_discovery(run_id uuid,keep_setup boolean) returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.rhee_discovery_runs;
begin
  select * into strict r from public.rhee_discovery_runs where id=run_id for update;
  if keep_setup and r.status<>'running' then raise exception 'Only a running Autopair can be stopped'; end if;
  if r.status='applying' then raise exception 'Wait for installation to finish'; end if;
  update public.project_control_commands set status='canceled',completed_at=now() where project_id=r.project_id and device_id=r.device_id and command_type='manual_water' and status='queued' and client_request_id=nullif(r.progress->>'command','')::uuid;
  -- A stop can race the controller's claim. Carry the uncertain receipt through Retry.
  if keep_setup and r.progress->>'phase'='receipt' and not exists (
    select 1 from public.project_control_commands c where c.project_id=r.project_id and c.device_id=r.device_id
      and c.client_request_id=nullif(r.progress->>'command','')::uuid
      and c.started_at is null and c.status in ('canceled','expired')
  ) then
    r.progress:=jsonb_set(r.progress,'{unconfirmed}',coalesce(r.progress->'unconfirmed','[]'::jsonb) ||
      jsonb_build_array(jsonb_build_object('pot',r.setup->'pots'->((r.progress->>'potIndex')::integer)->'pot',
        'at',r.progress->'pulseAt','why','Autopair stopped before the valve receipt was verified.')));
  end if;
  update public.rhee_discovery_runs set status=case when keep_setup then 'review' else 'closed' end,revision=revision+1,lease_until=null,dispatch_token=null,updated_at=now(),
    progress=case when keep_setup then r.progress||jsonb_build_object('phase','review','message','Autopair stopped. Any pulse already in progress closes on its timer. Your setup is saved.',
      'missing',coalesce((select jsonb_agg(p->'pot') from jsonb_array_elements(r.setup->'pots') p where not exists (select 1 from jsonb_array_elements(r.progress->'matches') m where m->'pot'=p->'pot')),'[]'::jsonb)) else progress end where id=run_id;
end $$;
revoke all on function public.stop_rhee_discovery(uuid,boolean) from public,anon,authenticated;
grant execute on function public.stop_rhee_discovery(uuid,boolean) to service_role;
