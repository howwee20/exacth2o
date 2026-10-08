-- Synthetic fixture for the disposable local product environment (scripts/product-local/start.sh).
-- Never applied to a shared or production database. Every row is generated; no researcher data,
-- real account or production identity is copied. Times are relative to the moment of seeding.
--
-- Shape mirrors one greenhouse installation: project 2222… with one controller, 34 pots as
-- controller pairings (Zone<z>-Pot<p>), a controlled maize × sorghum deficit experiment
-- (24 pots, two revisions), a sensing-only calibration experiment (10 pots) and a completed
-- experiment, 21 days of 10-minute readings and the controller's valve openings.

set search_path = public, extensions;

-- Organisation/project 2222… come from the baseline fixture; add the controller and a second,
-- unrelated project used to prove account isolation.
insert into public.organizations (id, slug, name)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa0'::uuid, 'product-local-other', 'Other organisation (local test)')
on conflict (id) do nothing;

insert into public.projects (id, organization_id, slug, name)
values ('55555555-5555-4555-8555-555555555555'::uuid, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa0'::uuid, 'product-local-other', 'Other project (local test)')
on conflict (id) do nothing;

insert into public.devices (id, organization_id, project_id, name, status, last_seen_at)
values
  ('3100e37ee3205651fe3dd86dafd4dc0c', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee0'::uuid, '22222222-2222-4222-8222-222222222222'::uuid, 'Research controller', 'online', now()),
  ('product-local-other-controller', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa0'::uuid, '55555555-5555-4555-8555-555555555555'::uuid, 'Other controller', 'online', now())
on conflict (id) do nothing;

insert into public.research_sites (id, organization_id, project_id, slug, name, timezone)
values
  ('22222222-2222-4222-8222-2222222222a1'::uuid, 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee0'::uuid, '22222222-2222-4222-8222-222222222222'::uuid, 'primary', 'Greenhouse (local test)', 'America/Detroit'),
  ('55555555-5555-4555-8555-5555555555a1'::uuid, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa0'::uuid, '55555555-5555-4555-8555-555555555555'::uuid, 'primary', 'Other site (local test)', 'America/Detroit')
on conflict do nothing;

-- ---------------------------------------------------------------- controller configuration

create temporary table seed_pots on commit drop as
select
  pot as pot_number,
  case when pot <= 24 then ((pot - 1) / 6) + 1 else 5 end as zone,
  format('Zone%s-Pot%s', case when pot <= 24 then ((pot - 1) / 6) + 1 else 5 end, pot) as pairing_name,
  'B' || (((pot - 1) / 8) + 1) as board,
  ((pot - 1) % 8) + 1 as board_address,
  case when pot <= 24 then (case when pot % 2 = 1 then 'control' else 'drought' end) end as treatment,
  case when pot <= 24 then (case when ((pot - 1) / 2) % 2 = 0 then 'maize' else 'sorghum' end) end as crop,
  case when pot <= 24 then chr(65 + (pot - 1) / 8) end as block,
  case when pot <= 24 then (case when pot % 2 = 1 then 34 else 22 end) else -999999 end as target_now,
  case when pot <= 24 then 3000 else 0 end as valve_ms
from generate_series(1, 34) as pot;

insert into public.device_config_state (
  project_id, device_id, device_name, source, observed_at, pairings, calibrations, board_config,
  sensors, valves, groups, pairing_count, calibration_count, board_count, sensor_count, valve_count,
  group_count, config_hash, updated_at
)
select
  '22222222-2222-4222-8222-222222222222'::uuid, '3100e37ee3205651fe3dd86dafd4dc0c', 'Research controller', 'product-local-seed', now(),
  jsonb_agg(jsonb_build_object(
    'name', pairing_name,
    'sensorId', pot_number,
    'valveId', pot_number,
    'groupId', case when pot_number <= 24 then 1 else 2 end,
    'Sensor', jsonb_build_object('boardSerialId', board, 'address', board_address::text),
    'Valve', jsonb_build_object('relayAddress', '0x2' || ((pot_number - 1) / 16), 'address', (((pot_number - 1) % 16) + 1)::text),
    'Calibration', jsonb_build_object('name', case when pot_number <= 8 then 'Substrate v2' else 'Substrate v1' end),
    'WTCPercentLimit', target_now,
    'ValveOpenTime', valve_ms,
    'MeasurementInterval', 600000
  ) order by pot_number),
  '[{"name":"Substrate v1"},{"name":"Substrate v2"}]'::jsonb,
  '[{"address":"0x20"},{"address":"0x21"},{"address":"0x22"}]'::jsonb,
  '[]'::jsonb, '[]'::jsonb,
  '[{"id":1,"name":"Matt Experiment 2"},{"id":2,"name":"SWC Saturation Calibration"}]'::jsonb,
  34, 2, 3, 34, 34, 2, 'product-local-seed-v1', now()
from seed_pots
on conflict (project_id, device_id) do update
set pairings = excluded.pairings, updated_at = now(), config_hash = excluded.config_hash;

insert into public.device_config_state (project_id, device_id, device_name, source, pairings, pairing_count, updated_at)
values (
  '55555555-5555-4555-8555-555555555555'::uuid, 'product-local-other-controller', 'Other controller', 'product-local-seed',
  '[{"name":"Zone1-Pot1","sensorId":1,"valveId":1,"Sensor":{"boardSerialId":"X1","address":"1"},"Valve":{"relayAddress":"0x20","address":"1"},"Calibration":{"name":"Other calibration"},"WTCPercentLimit":30,"ValveOpenTime":2000,"MeasurementInterval":600000}]'::jsonb,
  1, now()
)
on conflict (project_id, device_id) do nothing;

insert into public.device_runtime_state (
  project_id, device_id, device_name, source, controller_state, state_observed_at, state_fresh_until,
  overall_status, api_status, pi_online, watering_enabled, sensors_expected, sensors_current, updated_at
) values (
  '22222222-2222-4222-8222-222222222222'::uuid, '3100e37ee3205651fe3dd86dafd4dc0c', 'Research controller', 'product-local-seed',
  'RUNNING', now(), now() + interval '10 minutes', 'operational', 'OK', true, true, 34, 34, now()
)
on conflict (project_id, device_id) do update
set state_observed_at = now(), state_fresh_until = now() + interval '10 minutes', controller_state = 'RUNNING', updated_at = now();

insert into public.latest_device_state (device_id, organization_id, project_id, last_seen_at, health_status, latest_payload, updated_at)
values ('3100e37ee3205651fe3dd86dafd4dc0c', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee0'::uuid, '22222222-2222-4222-8222-222222222222'::uuid, now(), 'ok', '{}'::jsonb, now())
on conflict (device_id) do update set last_seen_at = now(), updated_at = now();

-- Canonical identity chain, as the July 2026 foundation backfill would have produced.
insert into public.physical_positions (project_id, site_id, zone, position_label, coordinates)
select '22222222-2222-4222-8222-222222222222'::uuid, '22222222-2222-4222-8222-2222222222a1'::uuid, zone,
  format('Zone %s / Pot %s', zone, pot_number), jsonb_build_object('zone', zone, 'pot_number', pot_number)
from seed_pots
on conflict do nothing;

insert into public.research_pots (project_id, site_id, position_id, pot_number, label, metadata)
select '22222222-2222-4222-8222-222222222222'::uuid, '22222222-2222-4222-8222-2222222222a1'::uuid, position.id,
  seed.pot_number, format('Pot %s', seed.pot_number), '{"source":"pairing_snapshot"}'::jsonb
from seed_pots seed
join public.physical_positions position
  on position.project_id = '22222222-2222-4222-8222-222222222222'::uuid
 and position.position_label = format('Zone %s / Pot %s', seed.zone, seed.pot_number)
on conflict do nothing;

insert into public.hardware_bindings (project_id, device_id, pot_id, pairing_name, sensor_key, valve_key, physical_status, source, effective_at)
select '22222222-2222-4222-8222-222222222222'::uuid, '3100e37ee3205651fe3dd86dafd4dc0c', pot.id, seed.pairing_name,
  seed.board || ':' || seed.board_address, '0x2' || ((seed.pot_number - 1) / 16) || ':' || (((seed.pot_number - 1) % 16) + 1),
  'software_only', 'pairing_snapshot', now() - interval '30 days'
from seed_pots seed
join public.research_pots pot on pot.project_id = '22222222-2222-4222-8222-222222222222'::uuid and pot.pot_number = seed.pot_number
on conflict do nothing;

-- ---------------------------------------------------------------- experiments

create temporary table seed_times on commit drop as
select
  date_trunc('minute', now()) as now_at,
  date_trunc('day', now()) - interval '10 days' + interval '9 hours' as matt2_start,
  date_trunc('day', now()) - interval '6 days' + interval '9 hours 14 minutes' as deficit_at,
  date_trunc('day', now()) - interval '2 days' + interval '9 hours 14 minutes' as calibration_at,
  date_trunc('day', now()) - interval '5 days' + interval '8 hours' as swc_start,
  date_trunc('day', now()) - interval '20 days' + interval '9 hours' as old_start,
  date_trunc('day', now()) - interval '12 days' + interval '16 hours' as old_end;

insert into public.experiments (id, project_id, slug, name, description, mode, status, watering_state, visible_to_roles, started_at, ended_at, created_at)
select 'e2222222-2222-4222-8222-222222222222'::uuid, '22222222-2222-4222-8222-222222222222'::uuid, 'matt-experiment-2', 'Matt Experiment 2',
  'Maize and sorghum under two watering regimes in three blocks; deficit pots moved to a 22% target on day 4.',
  'controlled', 'active', 'controller_managed', array['admin', 'researcher'], matt2_start, null::timestamptz, matt2_start
from seed_times
union all
select 'e3333333-3333-4333-8333-333333333333'::uuid, '22222222-2222-4222-8222-222222222222'::uuid, 'swc-saturation-calibration', 'SWC Saturation Calibration',
  'Saturated reference cores drying down for the substrate calibration.', 'calibration', 'published_sensing', 'off', array['admin', 'researcher'], swc_start, null::timestamptz, swc_start
from seed_times
union all
select 'e1111111-1111-4111-8111-111111111111'::uuid, '22222222-2222-4222-8222-222222222222'::uuid, 'matt-experiment', 'Matt Experiment 1',
  'Original sensing run on the bench before the deficit study.', 'observation', 'completed', 'off', array['admin', 'researcher'], old_start, old_end, old_start
from seed_times
union all
select 'e5555555-5555-4555-8555-555555555555'::uuid, '55555555-5555-4555-8555-555555555555'::uuid, 'other-project-trial', 'Other project trial',
  'Belongs to the other project; must never be visible to the greenhouse accounts.', 'controlled', 'active', 'controller_managed', array['admin', 'researcher'], now() - interval '3 days', null::timestamptz, now() - interval '3 days'
on conflict (id) do nothing;

-- Revisions: Matt Experiment 2 v1 (every pot at 34%), v2 (deficit pots at 22%).
insert into public.experiment_revisions (id, experiment_id, project_id, version, source, spec, created_at)
select r.id, r.experiment_id, r.project_id, r.version, 'manual', r.spec, r.created_at
from seed_times t,
lateral (values
  ('a2222222-0000-4000-8000-000000000001'::uuid, 'e2222222-2222-4222-8222-222222222222'::uuid, '22222222-2222-4222-8222-222222222222'::uuid, 1,
    jsonb_build_object('name', 'Matt Experiment 2', 'description', 'Maize and sorghum under two watering regimes in three blocks.', 'mode', 'controlled', 'start_date', to_char(t.matt2_start, 'YYYY-MM-DD'), 'assignments', '[]'::jsonb, 'visibility_roles', jsonb_build_array('admin', 'researcher'), 'controller_changes_requested', true, 'questions', '[]'::jsonb),
    t.matt2_start),
  ('a2222222-0000-4000-8000-000000000002'::uuid, 'e2222222-2222-4222-8222-222222222222'::uuid, '22222222-2222-4222-8222-222222222222'::uuid, 2,
    jsonb_build_object('name', 'Matt Experiment 2', 'description', 'Maize and sorghum under two watering regimes in three blocks; deficit pots moved to a 22% target on day 4.', 'mode', 'controlled', 'start_date', to_char(t.matt2_start, 'YYYY-MM-DD'), 'assignments', '[]'::jsonb, 'visibility_roles', jsonb_build_array('admin', 'researcher'), 'controller_changes_requested', true, 'questions', '[]'::jsonb),
    t.deficit_at),
  ('a3333333-0000-4000-8000-000000000001'::uuid, 'e3333333-3333-4333-8333-333333333333'::uuid, '22222222-2222-4222-8222-222222222222'::uuid, 1,
    jsonb_build_object('name', 'SWC Saturation Calibration', 'description', 'Saturated reference cores drying down for the substrate calibration.', 'mode', 'calibration', 'start_date', to_char(t.swc_start, 'YYYY-MM-DD'), 'assignments', '[]'::jsonb, 'visibility_roles', jsonb_build_array('admin', 'researcher'), 'controller_changes_requested', false, 'questions', '[]'::jsonb),
    t.swc_start),
  ('a1111111-0000-4000-8000-000000000001'::uuid, 'e1111111-1111-4111-8111-111111111111'::uuid, '22222222-2222-4222-8222-222222222222'::uuid, 1,
    jsonb_build_object('name', 'Matt Experiment 1', 'description', 'Original sensing run on the bench before the deficit study.', 'mode', 'observation', 'start_date', to_char(t.old_start, 'YYYY-MM-DD'), 'assignments', '[]'::jsonb, 'visibility_roles', jsonb_build_array('admin', 'researcher'), 'controller_changes_requested', false, 'questions', '[]'::jsonb),
    t.old_start),
  ('a5555555-0000-4000-8000-000000000001'::uuid, 'e5555555-5555-4555-8555-555555555555'::uuid, '55555555-5555-4555-8555-555555555555'::uuid, 1,
    jsonb_build_object('name', 'Other project trial', 'description', 'Other project.', 'mode', 'controlled', 'start_date', to_char(now(), 'YYYY-MM-DD'), 'assignments', '[]'::jsonb, 'visibility_roles', jsonb_build_array('admin', 'researcher'), 'controller_changes_requested', true, 'questions', '[]'::jsonb),
    now() - interval '3 days')
) as r(id, experiment_id, project_id, version, spec, created_at)
on conflict (id) do nothing;

insert into public.experiment_assignments (
  revision_id, experiment_id, project_id, pairing_name, zone, pot_number, crop, treatment, block, substrate,
  target_vwc_percent, measurement_interval_minutes, sensor_key_snapshot, valve_key_snapshot, calibration_name_snapshot,
  source_target_vwc_percent, source_valve_open_time_ms, source_measurement_interval_ms
)
select revision.id, revision.experiment_id, revision.project_id, seed.pairing_name, seed.zone, seed.pot_number,
  seed.crop, seed.treatment, seed.block, 'Peat mix',
  case when revision.version = 1 then 34 else seed.target_now end, 10,
  seed.board || ':' || seed.board_address, '0x2' || ((seed.pot_number - 1) / 16) || ':' || (((seed.pot_number - 1) % 16) + 1),
  case when seed.pot_number <= 8 and revision.version = 2 then 'Substrate v2' else 'Substrate v1' end,
  case when revision.version = 1 then 34 else seed.target_now end, 3000, 600000
from public.experiment_revisions revision
cross join seed_pots seed
where revision.experiment_id = 'e2222222-2222-4222-8222-222222222222'::uuid and seed.pot_number <= 24
on conflict do nothing;

insert into public.experiment_assignments (
  revision_id, experiment_id, project_id, pairing_name, zone, pot_number, crop, treatment, block, substrate,
  target_vwc_percent, measurement_interval_minutes, sensor_key_snapshot, valve_key_snapshot, calibration_name_snapshot
)
select 'a3333333-0000-4000-8000-000000000001'::uuid, 'e3333333-3333-4333-8333-333333333333'::uuid, '22222222-2222-4222-8222-222222222222'::uuid,
  seed.pairing_name, seed.zone, seed.pot_number, null, null, null,
  case when seed.pot_number <= 29 then 'Peat mix' else 'Sand–peat' end, null, 10,
  seed.board || ':' || seed.board_address, '0x22:' || (seed.pot_number - 24), 'Substrate v1'
from seed_pots seed where seed.pot_number > 24
on conflict do nothing;

insert into public.experiment_assignments (
  revision_id, experiment_id, project_id, pairing_name, zone, pot_number, crop, treatment, block, substrate,
  target_vwc_percent, measurement_interval_minutes, sensor_key_snapshot, valve_key_snapshot, calibration_name_snapshot
)
select 'a1111111-0000-4000-8000-000000000001'::uuid, 'e1111111-1111-4111-8111-111111111111'::uuid, '22222222-2222-4222-8222-222222222222'::uuid,
  seed.pairing_name, seed.zone, seed.pot_number, seed.crop, null, null, 'Peat mix', null, 10,
  seed.board || ':' || seed.board_address, '0x2' || ((seed.pot_number - 1) / 16) || ':' || (((seed.pot_number - 1) % 16) + 1), 'Substrate v1'
from seed_pots seed where seed.pot_number <= 20
on conflict do nothing;

insert into public.experiment_assignments (
  revision_id, experiment_id, project_id, pairing_name, zone, pot_number, crop, treatment, target_vwc_percent,
  measurement_interval_minutes, sensor_key_snapshot, valve_key_snapshot
)
values ('a5555555-0000-4000-8000-000000000001'::uuid, 'e5555555-5555-4555-8555-555555555555'::uuid, '55555555-5555-4555-8555-555555555555'::uuid,
  'Zone1-Pot1', 1, 1, 'wheat', 'control', 30, 10, 'X1:1', '0x20:1')
on conflict do nothing;

update public.experiments set current_revision_id = 'a2222222-0000-4000-8000-000000000002'::uuid where id = 'e2222222-2222-4222-8222-222222222222'::uuid;
update public.experiments set current_revision_id = 'a3333333-0000-4000-8000-000000000001'::uuid where id = 'e3333333-3333-4333-8333-333333333333'::uuid;
update public.experiments set current_revision_id = 'a1111111-0000-4000-8000-000000000001'::uuid where id = 'e1111111-1111-4111-8111-111111111111'::uuid;
update public.experiments set current_revision_id = 'a5555555-0000-4000-8000-000000000001'::uuid where id = 'e5555555-5555-4555-8555-555555555555'::uuid;

insert into public.experiment_audit_events (experiment_id, project_id, revision_id, event_type, actor_id, details, created_at)
select 'e2222222-2222-4222-8222-222222222222'::uuid, '22222222-2222-4222-8222-222222222222'::uuid, 'a2222222-0000-4000-8000-000000000001'::uuid, 'published_sensing', null::uuid, '{"source":"product-local-seed"}'::jsonb, matt2_start from seed_times
union all
select 'e2222222-2222-4222-8222-222222222222'::uuid, '22222222-2222-4222-8222-222222222222'::uuid, 'a2222222-0000-4000-8000-000000000002'::uuid, 'revision_created', null::uuid, '{"source":"product-local-seed","summary":"Deficit pots: target 22% VWC"}'::jsonb, deficit_at from seed_times
union all
select 'e3333333-3333-4333-8333-333333333333'::uuid, '22222222-2222-4222-8222-222222222222'::uuid, 'a3333333-0000-4000-8000-000000000001'::uuid, 'published_sensing', null::uuid, '{"source":"product-local-seed"}'::jsonb, swc_start from seed_times;

-- ---------------------------------------------------------------- readings and valve openings

-- True moisture follows the controller rule: a controlled pot dries from a little above its
-- target down to the target, then is watered (a valve opening) and recovers. Deficit pots dry
-- down from 34% to 22% after the revision. Sensing-only pots dry slowly without watering.
create temporary table seed_series on commit drop as
with grid as (
  select seed.*, ts, extract(epoch from ts) / 3600.0 as hours
  from seed_pots seed
  cross join seed_times t
  cross join generate_series(t.now_at - interval '21 days', t.now_at, interval '10 minutes') as ts
),
shaped as (
  select grid.*,
    -- each pot has its own drying period (hours) and phase
    7.0 + (pot_number % 5) * 1.3 as period,
    (pot_number * 2.17) % 11 as phase,
    sin(((extract(hour from ts at time zone 'America/Detroit') + extract(minute from ts) / 60.0) - 6) / 24.0 * 2 * pi()) as diurnal,
    (('x' || substr(md5(pot_number::text || ts::text), 1, 6))::bit(24)::int / 16777215.0 - 0.5) as jitter
  from grid
)
select
  shaped.pot_number, shaped.pairing_name, shaped.board, shaped.board_address, shaped.ts,
  case
    when shaped.pot_number > 24 then
      greatest(9, 43 - 0.11 * greatest(0, extract(epoch from shaped.ts - t.swc_start) / 3600.0) + 0.4 * shaped.diurnal + 0.25 * shaped.jitter)
    else
      greatest(
        case when shaped.treatment = 'drought' and shaped.ts >= t.deficit_at then 22 else 34 end
          + 3.4 * (1 - (((shaped.hours + shaped.phase) / shaped.period) - floor((shaped.hours + shaped.phase) / shaped.period))),
        case when shaped.treatment = 'drought' and shaped.ts >= t.deficit_at
          then 37 - 0.22 * extract(epoch from shaped.ts - t.deficit_at) / 3600.0 else 0 end
      ) + 0.35 * shaped.diurnal + 0.3 * shaped.jitter
  end as vwc_true,
  (shaped.pot_number <= 24 and floor((shaped.hours + shaped.phase) / shaped.period)
     <> floor((shaped.hours - 1.0 / 6 + shaped.phase) / shaped.period)
     and not (shaped.treatment = 'drought' and shaped.ts >= t.deficit_at and shaped.ts < t.deficit_at + interval '55 hours')) as watered,
  21 + 4 * shaped.diurnal as temperature
from shaped
cross join seed_times t
where shaped.pot_number <= 24 or shaped.ts >= t.swc_start;

insert into public.sensor_readings (
  event_id, organization_id, project_id, device_id, source_sensor_id, sensor_key, pairing_name,
  device_recorded_at, server_received_at, raw_value, calibrated_value, temperature, unit
)
select
  format('live-device:3100e37ee3205651fe3dd86dafd4dc0c:%s:%s', s.pot_number, to_char(s.ts at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')),
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee0'::uuid, '22222222-2222-4222-8222-222222222222'::uuid, '3100e37ee3205651fe3dd86dafd4dc0c',
  s.pot_number, s.board || ':' || s.board_address, s.pairing_name,
  s.ts, s.ts + interval '20 seconds',
  round((400 + 21 * s.vwc_true)::numeric, 1),
  -- Pots 1–8 switch to the Substrate v2 calibration two days ago: calibrated VWC steps up by 7%
  -- while the raw sensor output stays continuous.
  round((case when s.pot_number <= 8 and s.ts >= t.calibration_at then s.vwc_true * 1.07 else s.vwc_true end)::numeric, 2),
  round(s.temperature::numeric, 1),
  'vwc_pct'
from seed_series s
cross join seed_times t
on conflict (event_id) do nothing;

insert into public.valve_events (
  event_id, organization_id, project_id, device_id, source_valve_id, valve_key, pairing_name, action,
  duration_ms, reason, device_recorded_at, server_received_at, evidence_source, source_class, pairing_name_raw, pairing_resolved
)
select
  format('owner-health:%s:%s:%s:open:3000', to_char(s.ts at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), s.pairing_name, '0x2' || ((s.pot_number - 1) / 16) || ':' || (((s.pot_number - 1) % 16) + 1)),
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee0'::uuid, '22222222-2222-4222-8222-222222222222'::uuid, '3100e37ee3205651fe3dd86dafd4dc0c',
  s.pot_number, '0x2' || ((s.pot_number - 1) / 16) || ':' || (((s.pot_number - 1) % 16) + 1), s.pairing_name, 'open',
  3000, 'below target', s.ts, s.ts + interval '40 seconds', 'owner_health_direct', 'automatic', s.pairing_name, true
from seed_series s
cross join seed_times t
where s.watered and s.ts >= t.matt2_start
on conflict (event_id) do nothing;

-- Mirror production realtime membership so the portal's live channels work locally.
do $$
declare
  relation_name text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach relation_name in array array['sensor_readings', 'valve_events', 'latest_device_state', 'device_runtime_state', 'device_config_state', 'project_control_commands']
    loop
      if not exists (
        select 1 from pg_publication_tables
        where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = relation_name
      ) then
        execute format('alter publication supabase_realtime add table public.%I', relation_name);
      end if;
    end loop;
  end if;
end;
$$;

analyze public.sensor_readings;
analyze public.valve_events;
