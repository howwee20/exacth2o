-- Waveforms are read via the project-authorized discovery function.
create table public.rhee_discovery_traces (
  run_id uuid not null references public.rhee_discovery_runs(id) on delete cascade,
  command_id uuid not null, pot integer not null, trace jsonb not null,
  saved_at timestamptz not null default now(), primary key(run_id,command_id)
);
create index rhee_trace_pot on public.rhee_discovery_traces(run_id,pot,saved_at desc);
alter table public.rhee_discovery_traces enable row level security;
revoke all on public.rhee_discovery_traces from public,anon,authenticated;
grant all on public.rhee_discovery_traces to service_role;

-- Store the last measurements in the same transaction that advances the worker.
create function public.archive_rhee_discovery_trace() returns trigger language plpgsql
set search_path=pg_catalog,public as $$
declare t jsonb:=new.progress->'archive'; oldpot integer;
begin
  if t is null and old.progress->>'command' is distinct from new.progress->>'command'
     and coalesce((old.progress->>'pulseAt')::bigint,0)>0 and old.progress->'baseline'<>'{}'::jsonb then
    oldpot:=(old.setup->'pots'->((old.progress->>'potIndex')::int)->>'pot')::int;
    if oldpot is not null then
      t:=jsonb_build_object('pot',oldpot,'seconds',case when old.progress->>'singlePot' is null then 3 else 10 end,
          'command',old.progress->>'command','before',old.progress->'baseline','after',old.progress->'after',
          'queuedAt',old.progress->'pulseAt','openedAt',old.progress->'openedAt','acknowledgedAt',old.progress->'acknowledgedAt');
    end if;
  end if;
  if t is not null and nullif(t->>'command','') is not null then
    insert into public.rhee_discovery_traces(run_id,command_id,pot,trace)
      values(new.id,(t->>'command')::uuid,(t->>'pot')::int,t)
      on conflict(run_id,command_id) do update set trace=excluded.trace,saved_at=now();
  end if;
  if new.progress ? 'archive' then new.progress:=new.progress-'archive'; end if;
  return new;
end $$;
create trigger store_rhee_discovery_trace before update of progress on public.rhee_discovery_runs
for each row execute function public.archive_rhee_discovery_trace();

create function public.start_rhee_single_pot(run_id uuid,expected_revision integer,target_pot integer,eligible_probes jsonb)
returns boolean language plpgsql security definer set search_path=pg_catalog,public as $$
declare r public.rhee_discovery_runs; pos integer;
begin
  select * into strict r from public.rhee_discovery_runs where id=run_id for update;
  if r.status<>'review' or r.revision<>expected_revision or r.worker_version<>2 then raise exception 'Refresh this setup before starting'; end if;
  select ord::int-1 into strict pos from jsonb_array_elements(r.setup->'pots') with ordinality p(v,ord) where (v->>'pot')::int=target_pot;
  if exists(select 1 from jsonb_array_elements(coalesce(r.progress->'matches','[]')) m where (m->>'pot')::int=target_pot)
    or exists(select 1 from jsonb_array_elements(coalesce(r.progress->'unconfirmed','[]')) u where (u->>'pot')::int=target_pot)
    then raise exception 'This pot already has a match or an unconfirmed pulse'; end if;
  if jsonb_typeof(eligible_probes) is distinct from 'array' or jsonb_array_length(eligible_probes)=0 or exists(
    select 1 from jsonb_array_elements(eligible_probes) p where (p->>'key') is null or p->>'key' !~ ':[A-Z]$'
  ) then raise exception 'Select available uppercase sensor addresses'; end if;
  update public.rhee_discovery_runs set status='running',updated_at=now(),dispatch_after=now(),lease_until=null,dispatch_token=null,revision=revision+1,
    progress=(progress-'openedAt'-'acknowledgedAt'-'archive'-'fill'-'unsure')||jsonb_build_object(
      'singlePot',target_pot,'potIndex',pos,'phase','baseline','queue','[]'::jsonb,'command','','pulseAt',0,'probes',eligible_probes,
      'candidates','[]'::jsonb,'baseline','{}'::jsonb,'after','{}'::jsonb,'cursor',0,'pass',0,'tries',0,'streak',0,'holds',0,'holdUntil',0,
      'unsure',coalesce((select jsonb_agg(p->>'key') from jsonb_array_elements(eligible_probes) p
          where coalesce(r.progress->'candidates','[]'::jsonb) ? (p->>'key')), '[]'::jsonb),
      'baselineRetries',0,'issues','[]'::jsonb,'repulse','[]'::jsonb,
      'message','Reading uppercase probes before the single 10-second pulse.') where id=run_id;
  return true;
end $$;
revoke all on function public.start_rhee_single_pot(uuid,integer,integer,jsonb) from public,anon,authenticated;
grant execute on function public.start_rhee_single_pot(uuid,integer,integer,jsonb) to service_role;

create or replace function public.pulse_rhee_discovery(run_id uuid, expected_revision integer, pot integer, cmd uuid, expected_valve text) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.rhee_discovery_runs; outlet public.manual_valve_routes; valve text; seconds integer:=3;
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
  if r.progress->>'singlePot' is not null then
    if (r.progress->>'singlePot')::int <> pot or r.progress->'queue' is distinct from '[]'::jsonb then
      raise exception 'Single-pot test cannot advance to another outlet';
    end if;
    seconds:=10;
  end if;
  perform public.enqueue_portal_control_command(r.project_id,r.device_id,'manual_water',jsonb_build_object('valve_keys',jsonb_build_array(valve),'duration_seconds',seconds,'total_valve_seconds',seconds),r.owner_id,now()+interval '45 seconds',true,now(),cmd);
  update public.rhee_discovery_runs set progress=progress||jsonb_build_object('phase','receipt','pulseAt',floor(extract(epoch from now())*1000),'message','Waiting for controller confirmation for pot '||pot) where id=run_id;
end $$;
revoke all on function public.pulse_rhee_discovery(uuid,integer,integer,uuid,text) from public,anon,authenticated;
grant execute on function public.pulse_rhee_discovery(uuid,integer,integer,uuid,text) to service_role;
