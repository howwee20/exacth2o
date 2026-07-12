-- Additive, shadow-only multi-event R&D state. This migration does not alter
-- controller, command, pairing, target, calibration, valve, or sensor tables.

create table if not exists public.rd_correction_episodes_v2 (
  id uuid primary key default gen_random_uuid(),
  episode_key text not null unique,
  project_id uuid not null,
  device_id text not null,
  pairing_name text not null,
  first_open_event_id text not null,
  first_open_device_at timestamptz not null,
  last_open_device_at timestamptz not null,
  target_vwc_at_start double precision not null,
  config_hash_at_start text not null,
  pulse_count integer not null default 0 check (pulse_count >= 0),
  status text not null default 'active'
    check (status in ('active', 'observing', 'complete')),
  correction_ended_at timestamptz,
  observation_ends_at timestamptz not null,
  completed_at timestamptz,
  quality jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, device_id, first_open_event_id)
);

create index if not exists rd_correction_episodes_v2_pairing_idx
  on public.rd_correction_episodes_v2
  (project_id, device_id, pairing_name, first_open_device_at desc);

create index if not exists rd_correction_episodes_v2_active_idx
  on public.rd_correction_episodes_v2
  (project_id, status, last_open_device_at desc)
  where status in ('active', 'observing');

create table if not exists public.rd_irrigation_events_v2 (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null,
  device_id text not null,
  pairing_name text not null,
  valve_event_id text not null,
  episode_id uuid not null references public.rd_correction_episodes_v2(id) on delete restrict,
  sequence_in_episode integer not null check (sequence_in_episode > 0),
  prediction_id uuid references public.rd_curve_predictions(id) on delete restrict,
  prediction_status text not null
    check (prediction_status in ('committed', 'missed_causal_window')),
  opened_device_at timestamptz not null,
  closed_device_at timestamptz,
  duration_ms integer check (duration_ms is null or duration_ms >= 0),
  duration_source text not null
    check (duration_source in ('observed_event', 'configured_snapshot', 'unknown')),
  source_class text not null,
  evidence_source text not null,
  prediction_lead_seconds integer,
  quality jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (project_id, device_id, valve_event_id),
  unique (episode_id, sequence_in_episode)
);

create unique index if not exists rd_irrigation_events_v2_prediction_idx
  on public.rd_irrigation_events_v2 (prediction_id)
  where prediction_id is not null;

create index if not exists rd_irrigation_events_v2_pairing_time_idx
  on public.rd_irrigation_events_v2
  (project_id, device_id, pairing_name, opened_device_at desc);

alter table public.rd_correction_episodes_v2 enable row level security;
alter table public.rd_irrigation_events_v2 enable row level security;
revoke all on table public.rd_correction_episodes_v2 from public, anon, authenticated;
revoke all on table public.rd_irrigation_events_v2 from public, anon, authenticated;
grant select, insert, update, delete on table public.rd_correction_episodes_v2 to service_role;
grant select, insert on table public.rd_irrigation_events_v2 to service_role;

drop trigger if exists rd_immutable_guard on public.rd_irrigation_events_v2;
create trigger rd_immutable_guard
before update or delete on public.rd_irrigation_events_v2
for each row execute function public.rd_block_immutable_mutation();

create or replace function public.rd_record_irrigation_event_v2(
  record_project_id uuid,
  record_device_id text,
  record_pairing_name text,
  record_valve_event_id text,
  record_opened_device_at timestamptz,
  record_duration_ms integer,
  record_duration_source text,
  record_source_class text,
  record_evidence_source text,
  record_prediction_id uuid,
  record_prediction_lead_seconds integer,
  record_target_vwc double precision,
  record_config_hash text,
  record_quality jsonb,
  record_settle_gap_minutes integer default 45
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  existing_event public.rd_irrigation_events_v2%rowtype;
  selected_episode public.rd_correction_episodes_v2%rowtype;
  event_sequence integer;
  created_event_id uuid;
  stable_episode_key text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only service_role may record R&D irrigation events';
  end if;
  if record_source_class <> 'automatic' then
    raise exception 'Only confirmed automatic events are eligible for the R&D stream';
  end if;

  select * into existing_event
  from public.rd_irrigation_events_v2
  where project_id = record_project_id
    and device_id = record_device_id
    and valve_event_id = record_valve_event_id;
  if found then
    return jsonb_build_object(
      'event_id', existing_event.id,
      'episode_id', existing_event.episode_id,
      'created', false
    );
  end if;

  select * into selected_episode
  from public.rd_correction_episodes_v2
  where project_id = record_project_id
    and device_id = record_device_id
    and pairing_name = record_pairing_name
    and first_open_device_at <= record_opened_device_at
    and last_open_device_at >= record_opened_device_at
      - make_interval(mins => greatest(1, record_settle_gap_minutes))
  order by last_open_device_at desc
  limit 1
  for update;

  if not found then
    stable_episode_key := encode(
      extensions.digest(
        record_project_id::text || '|' || record_device_id || '|' ||
        record_pairing_name || '|' || record_valve_event_id || '|' || record_config_hash,
        'sha256'
      ),
      'hex'
    );
    insert into public.rd_correction_episodes_v2 (
      episode_key, project_id, device_id, pairing_name,
      first_open_event_id, first_open_device_at, last_open_device_at,
      target_vwc_at_start, config_hash_at_start, pulse_count, status,
      observation_ends_at, quality
    ) values (
      stable_episode_key, record_project_id, record_device_id, record_pairing_name,
      record_valve_event_id, record_opened_device_at, record_opened_device_at,
      record_target_vwc, record_config_hash, 0, 'active',
      record_opened_device_at + interval '240 minutes',
      jsonb_build_object('shadow_only', true)
    ) returning * into selected_episode;
  end if;

  event_sequence := selected_episode.pulse_count + 1;
  insert into public.rd_irrigation_events_v2 (
    project_id, device_id, pairing_name, valve_event_id, episode_id,
    sequence_in_episode, prediction_id, prediction_status,
    opened_device_at, duration_ms, duration_source, source_class,
    evidence_source, prediction_lead_seconds, quality
  ) values (
    record_project_id, record_device_id, record_pairing_name,
    record_valve_event_id, selected_episode.id, event_sequence,
    record_prediction_id,
    case when record_prediction_id is null then 'missed_causal_window' else 'committed' end,
    record_opened_device_at, record_duration_ms, record_duration_source,
    record_source_class, record_evidence_source, record_prediction_lead_seconds,
    coalesce(record_quality, '{}'::jsonb)
  ) returning id into created_event_id;

  update public.rd_correction_episodes_v2
  set last_open_device_at = greatest(last_open_device_at, record_opened_device_at),
      pulse_count = event_sequence,
      status = 'active',
      correction_ended_at = null,
      observation_ends_at = greatest(
        observation_ends_at,
        record_opened_device_at + interval '240 minutes'
      ),
      completed_at = null,
      updated_at = now()
  where id = selected_episode.id;

  return jsonb_build_object(
    'event_id', created_event_id,
    'episode_id', selected_episode.id,
    'created', true
  );
end;
$$;

revoke all on function public.rd_record_irrigation_event_v2(
  uuid, text, text, text, timestamptz, integer, text, text, text,
  uuid, integer, double precision, text, jsonb, integer
) from public, anon, authenticated;
grant execute on function public.rd_record_irrigation_event_v2(
  uuid, text, text, text, timestamptz, integer, text, text, text,
  uuid, integer, double precision, text, jsonb, integer
) to service_role;

create or replace function public.rd_refresh_episode_states_v2(
  reference_at timestamptz default now(),
  settle_gap_minutes integer default 45
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  changed integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only service_role may refresh R&D episode states';
  end if;
  update public.rd_correction_episodes_v2
  set status = case
        when reference_at < last_open_device_at
          + make_interval(mins => greatest(1, settle_gap_minutes)) then 'active'
        when reference_at < observation_ends_at then 'observing'
        else 'complete'
      end,
      correction_ended_at = case
        when reference_at >= last_open_device_at
          + make_interval(mins => greatest(1, settle_gap_minutes))
        then last_open_device_at
          + make_interval(mins => greatest(1, settle_gap_minutes))
        else null
      end,
      completed_at = case
        when reference_at >= observation_ends_at then coalesce(completed_at, reference_at)
        else null
      end,
      updated_at = now()
  where status is distinct from case
        when reference_at < last_open_device_at
          + make_interval(mins => greatest(1, settle_gap_minutes)) then 'active'
        when reference_at < observation_ends_at then 'observing'
        else 'complete'
      end
     or (reference_at >= observation_ends_at and completed_at is null);
  get diagnostics changed = row_count;
  return changed;
end;
$$;

revoke all on function public.rd_refresh_episode_states_v2(timestamptz, integer)
  from public, anon, authenticated;
grant execute on function public.rd_refresh_episode_states_v2(timestamptz, integer)
  to service_role;

comment on table public.rd_irrigation_events_v2 is
  'One immutable shadow record per confirmed automatic valve open. No controller writes.';
comment on table public.rd_correction_episodes_v2 is
  'Groups repeated automatic opens for one pot while retaining every atomic event.';
