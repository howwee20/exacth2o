-- These five physical samples were reported by both ingest paths. Retain every
-- original value and publisher field, and mark only the verified copies.
update public.sensor_readings r
set quality_flags = coalesce(r.quality_flags, '{}'::jsonb) || '{"sensor_frame":"sdi12_acknowledgement"}'::jsonb
from (values
  ('D30GQN2E:P', timestamptz '2026-11-25 17:18:42-05'),
  ('D30GQN2E:P', timestamptz '2026-11-25 18:25:15-05'),
  ('D30GQN2E:1', timestamptz '2026-11-25 19:22:21-05'),
  ('D30GQN2E:Q', timestamptz '2026-11-25 19:35:18-05'),
  ('D30GQN2E:T', timestamptz '2026-11-25 19:46:36-05')
) as bad(sensor_key, recorded_at)
where r.project_id = '22222222-2222-4222-8222-222222222222'
  and r.device_id = '3100e37ee3205651fe3dd86dafd4dc0c'
  and r.sensor_key = bad.sensor_key and r.device_recorded_at = bad.recorded_at
  and r.raw_value = 0 and r.temperature = 1 and r.electrical_conductivity = 3;

create or replace function public.portal_reading_buckets(
  p_project_id uuid,
  p_device_id text,
  p_pairing_names text[],
  p_start timestamptz,
  p_end timestamptz,
  p_bucket_seconds integer,
  p_exclusions jsonb default '[]'::jsonb
)
returns table (
  pairing_name text,
  bucket_start timestamptz,
  readings integer,
  excluded integer,
  vwc_mean double precision,
  raw_mean double precision,
  temperature_mean double precision,
  ec_mean double precision
)
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
begin
  if p_start is null or p_end is null or p_end <= p_start or p_end - p_start > interval '120 days' then
    raise exception 'Choose a window of up to 120 days.' using errcode = '22023';
  end if;
  if p_bucket_seconds is null or p_bucket_seconds < 60 or p_bucket_seconds > 7 * 86400 then
    raise exception 'Buckets must be between one minute and seven days.' using errcode = '22023';
  end if;
  if p_pairing_names is null or cardinality(p_pairing_names) not between 1 and 200 then
    raise exception 'Choose between 1 and 200 pots.' using errcode = '22023';
  end if;
  if ceil(extract(epoch from p_end - p_start) / p_bucket_seconds) * cardinality(p_pairing_names) > 60000 then
    raise exception 'Too many pot-buckets for one request; use larger buckets or fewer pots.' using errcode = '22023';
  end if;
  if p_exclusions is null or jsonb_typeof(p_exclusions) <> 'array' or jsonb_array_length(p_exclusions) > 200 then
    raise exception 'Exclusions must be a list of at most 200 ranges.' using errcode = '22023';
  end if;

  return query
  with scope as (
    select nullif(item ->> 'pairing_name', '') as pot,
           (item ->> 'starts_at')::timestamptz as starts_at,
           (item ->> 'ends_at')::timestamptz as ends_at
    from jsonb_array_elements(p_exclusions) item
  ),
  marked as (
    select reading.pairing_name as pot,
           reading.device_recorded_at as at,
           reading.calibrated_value, reading.raw_value, reading.temperature, reading.electrical_conductivity,
           coalesce(reading.quality_flags ->> 'sensor_frame' = 'sdi12_acknowledgement', false) or exists (
             select 1 from scope
             where (scope.pot is null or scope.pot = reading.pairing_name)
               and (scope.starts_at is null or reading.device_recorded_at >= scope.starts_at)
               and (scope.ends_at is null or reading.device_recorded_at < scope.ends_at)
           ) as is_excluded
    from public.sensor_readings reading
    where reading.project_id = p_project_id
      and reading.device_id = p_device_id
      and reading.pairing_name = any (p_pairing_names)
      and reading.device_recorded_at >= p_start
      and reading.device_recorded_at < p_end
  )
  select marked.pot,
         p_start + floor(extract(epoch from marked.at - p_start) / p_bucket_seconds) * p_bucket_seconds * interval '1 second',
         (count(*) filter (where not marked.is_excluded))::integer,
         (count(*) filter (where marked.is_excluded))::integer,
         round((avg(marked.calibrated_value) filter (where not marked.is_excluded))::numeric, 4)::double precision,
         round((avg(marked.raw_value) filter (where not marked.is_excluded))::numeric, 4)::double precision,
         round((avg(marked.temperature) filter (where not marked.is_excluded))::numeric, 4)::double precision,
         round((avg(marked.electrical_conductivity) filter (where not marked.is_excluded))::numeric, 4)::double precision
  from marked
  group by 1, 2
  order by 1, 2;
end;
$$;
