-- Hourly Edge-invocation estimate that costs no Edge invocation.
--
-- Every chamber-agent, Walker and owner-health invocation runs exactly one
-- recognizable statement (the device-credential check, the Walker ingest or
-- heartbeat RPC, the health ingest lease). Their pg_stat_statements call
-- counters therefore count invocations; together they covered more than 98%
-- of billed calls on 2026-10-20. Once an hour this records the deltas, a
-- 31-day projection and a status (ok / warn at 1.2M / critical at 1.6M of the
-- 2M included). Admins read the newest status through edge_usage_budget().
-- It is an early warning, not the invoice: the billing dashboard governs.
-- Counter resets (restart, pg_stat_statements eviction) mark that hour
-- "unknown" instead of guessing. 14 days of hourly rows are kept.
set lock_timeout = '2s';
set statement_timeout = '30s';

create table if not exists public.edge_usage_observations (
  observed_at timestamptz primary key default now(),
  window_seconds integer not null check (window_seconds > 0),
  calls jsonb not null check (jsonb_typeof(calls) = 'object'),
  estimated_calls bigint not null check (estimated_calls >= 0),
  projected_31_day_calls bigint not null check (projected_31_day_calls >= 0),
  status text not null check (status in ('ok', 'warn', 'critical', 'unknown')),
  counters jsonb not null check (jsonb_typeof(counters) = 'object')
);
alter table public.edge_usage_observations enable row level security;
revoke all on public.edge_usage_observations from public, anon, authenticated;
grant select on public.edge_usage_observations to service_role;
comment on table public.edge_usage_observations is
  'Hourly estimate of Edge Function invocations from pg_stat_statements counters. Early warning only; the billing dashboard governs.';

create or replace function public.edge_usage_counters()
returns jsonb
language sql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
  select coalesce(jsonb_object_agg(source, calls), '{}'::jsonb)
  from (
    select source, sum(statement.calls)::bigint as calls
    from extensions.pg_stat_statements statement
    join pg_roles role on role.oid = statement.userid and role.rolname = 'service_role'
    cross join lateral (values (case
      when statement.query like 'WITH pgrst_source AS ( SELECT "public"."gas_mixer_agent_credentials"."enabled"%' then 'gas-mixer agents'
      when statement.query like 'WITH pgrst_source AS ( SELECT "public"."lighting_agent_credentials"."enabled"%' then 'lighting-native-agent'
      when statement.query like '%"ingest_walker_live_telemetry_batch"(%' or statement.query like '%"walker_live_record_heartbeat"(%' then 'receive-walker-telemetry'
      when statement.query like '%"acquire_device_ingest_lease"(%' then 'sync-owner-health'
    end)) as matched(source)
    where matched.source is not null
    group by source
  ) counted;
$$;

create or replace function public.record_edge_usage_observation()
returns text
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  previous public.edge_usage_observations%rowtype;
  current_counters jsonb := public.edge_usage_counters();
  window_seconds integer;
  calls jsonb := '{}'::jsonb;
  total bigint := 0;
  projected bigint := 0;
  outcome text := 'unknown';
  source text;
  delta bigint;
begin
  select * into previous from public.edge_usage_observations order by observed_at desc limit 1;
  window_seconds := greatest(1, extract(epoch from (now() - coalesce(previous.observed_at, now() - interval '1 hour')))::integer);
  if previous.observed_at is not null and current_counters <> '{}'::jsonb then
    outcome := null;
    for source in select jsonb_object_keys(current_counters) loop
      delta := (current_counters ->> source)::bigint - coalesce((previous.counters ->> source)::bigint, 0);
      if delta < 0 then
        outcome := 'unknown';
        delta := 0;
      end if;
      calls := calls || jsonb_build_object(source, delta);
      total := total + delta;
    end loop;
    projected := round(total::numeric * 31 * 86400 / window_seconds);
    outcome := coalesce(outcome, case
      when projected >= 1600000 then 'critical'
      when projected >= 1200000 then 'warn'
      else 'ok'
    end);
  end if;
  insert into public.edge_usage_observations(observed_at, window_seconds, calls, estimated_calls,
      projected_31_day_calls, status, counters)
    values (now(), window_seconds, calls, total, projected, outcome, current_counters)
    on conflict (observed_at) do nothing;
  delete from public.edge_usage_observations where observed_at < now() - interval '14 days';
  return outcome;
end;
$$;

-- Admin-only summary for the portal: newest status and the last 24 hours.
create or replace function public.edge_usage_budget()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1 from public.portal_access access
    where access.user_id = auth.uid() and access.role = 'admin'
  ) then
    raise exception 'Administrator access is required' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'included_calls', 2000000,
    'latest', (select to_jsonb(observation) - 'counters'
               from public.edge_usage_observations observation
               order by observed_at desc limit 1),
    'last_24_hours', (select coalesce(jsonb_agg(jsonb_build_object(
                         'observed_at', observed_at, 'estimated_calls', estimated_calls, 'status', status)
                         order by observed_at), '[]'::jsonb)
                      from public.edge_usage_observations
                      where observed_at > now() - interval '24 hours'),
    'note', 'Estimated from database counters; the Supabase billing dashboard is authoritative.'
  );
end;
$$;

revoke all on function public.edge_usage_counters() from public, anon, authenticated;
revoke all on function public.record_edge_usage_observation() from public, anon, authenticated;
revoke all on function public.edge_usage_budget() from public, anon;
grant execute on function public.edge_usage_budget() to authenticated;

select cron.unschedule(jobid) from cron.job where jobname = 'exacth2o-edge-usage-observation';
select cron.schedule(
  'exacth2o-edge-usage-observation',
  '7 * * * *',
  $$select public.record_edge_usage_observation()$$
);
select public.record_edge_usage_observation();
