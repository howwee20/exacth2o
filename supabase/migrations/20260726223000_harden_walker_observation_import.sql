-- Narrow service-role import entry point for the Walker Gate A archive.
-- This avoids granting broad table access to the service role.

create or replace function public.walker_observation_import_catalog(
  sensor_rows jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  walker_project_id constant uuid :=
    '33333333-3333-4333-8333-333333333331'::uuid;
  walker_device_id constant text :=
    'balena:a1c4ace2b367fbee8521f1aff6a6329b';
  catalog_count integer;
  distinct_sensor_count integer;
  distinct_key_count integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only service_role may import the Walker historical catalog';
  end if;
  if jsonb_typeof(sensor_rows) <> 'array'
     or jsonb_array_length(sensor_rows) <> 96 then
    raise exception 'Walker historical catalog must contain exactly 96 records';
  end if;

  with catalog as (
    select *
    from jsonb_to_recordset(sensor_rows) as row_data(
      source_sensor_id integer,
      sensor_key text,
      display_label text,
      source_pairing_name text,
      position_number integer,
      board_serial_id text,
      sensor_address text,
      historical_group text,
      sensor_type text
    )
  )
  select
    count(*)::integer,
    count(distinct source_sensor_id)::integer,
    count(distinct sensor_key)::integer
  into catalog_count, distinct_sensor_count, distinct_key_count
  from catalog
  where source_sensor_id is not null
    and sensor_key = board_serial_id || ':' || sensor_address
    and display_label = source_pairing_name
    and char_length(display_label) between 1 and 120
    and board_serial_id in ('D30GQN2S', 'D30GQN2F')
    and char_length(sensor_address) between 1 and 8
    and position_number between 1 and 100;

  if catalog_count <> 96
     or distinct_sensor_count <> 96
     or distinct_key_count <> 96 then
    raise exception
      'Walker catalog validation failed: rows %, sensors %, keys %',
      catalog_count,
      distinct_sensor_count,
      distinct_key_count;
  end if;

  if (
    with supplied_positions as (
      select distinct row_data.position_number
      from jsonb_to_recordset(sensor_rows) as row_data(position_number integer)
    )
    select array_agg(position order by position)
    from generate_series(1, 100) position
    where not exists (
      select 1
      from supplied_positions supplied
      where supplied.position_number = position
    )
  ) <> array[48, 50, 51, 100] then
    raise exception 'Walker catalog no longer matches the verified 96/100 discrepancy';
  end if;

  insert into public.sensors (
    project_id,
    device_id,
    source_sensor_id,
    sensor_key,
    board_serial_id,
    address,
    label,
    sensor_type
  )
  select
    walker_project_id,
    walker_device_id,
    row_data.source_sensor_id,
    row_data.sensor_key,
    row_data.board_serial_id,
    row_data.sensor_address,
    row_data.display_label,
    coalesce(nullif(row_data.sensor_type, ''), 'SDI12')
  from jsonb_to_recordset(sensor_rows) as row_data(
    source_sensor_id integer,
    sensor_key text,
    display_label text,
    source_pairing_name text,
    position_number integer,
    board_serial_id text,
    sensor_address text,
    historical_group text,
    sensor_type text
  )
  on conflict (device_id, source_sensor_id) do update
  set
    sensor_key = excluded.sensor_key,
    board_serial_id = excluded.board_serial_id,
    address = excluded.address,
    label = excluded.label,
    sensor_type = excluded.sensor_type;

  insert into public.walker_observation_sensor_metadata (
    project_id,
    device_id,
    source_sensor_id,
    sensor_key,
    display_label,
    source_pairing_name,
    position_number,
    board_serial_id,
    sensor_address,
    historical_group,
    quality_flags
  )
  select
    walker_project_id,
    walker_device_id,
    row_data.source_sensor_id,
    row_data.sensor_key,
    row_data.display_label,
    row_data.source_pairing_name,
    row_data.position_number,
    row_data.board_serial_id,
    row_data.sensor_address,
    row_data.historical_group,
    jsonb_build_object(
      'source', 'verified_walker_historical_archive'
    )
  from jsonb_to_recordset(sensor_rows) as row_data(
    source_sensor_id integer,
    sensor_key text,
    display_label text,
    source_pairing_name text,
    position_number integer,
    board_serial_id text,
    sensor_address text,
    historical_group text,
    sensor_type text
  )
  on conflict (project_id, device_id, source_sensor_id) do update
  set
    sensor_key = excluded.sensor_key,
    display_label = excluded.display_label,
    source_pairing_name = excluded.source_pairing_name,
    position_number = excluded.position_number,
    board_serial_id = excluded.board_serial_id,
    sensor_address = excluded.sensor_address,
    historical_group = excluded.historical_group,
    quality_flags = excluded.quality_flags,
    updated_at = now();

  update public.walker_observation_imports
  set
    status = 'importing',
    metadata = jsonb_build_object(
      'source', 'verified_read_only_export',
      'source_file', 'sensor-readings-2026-03-10_to_2026-07-14.csv',
      'readings_sha256',
        '6592a8ee109609455dd37f3b8ad32ac0e2b1bd25469e5db7ab0382e3e4f02a23',
      'expected_positions', 100,
      'missing_numeric_positions', jsonb_build_array(48, 50, 51, 100),
      'position_41_label', 'Q-41'
    )
  where id = '33333333-3333-4333-8333-333333333350'::uuid;

  return jsonb_build_object(
    'accepted', true,
    'sensor_count', 96,
    'project_id', walker_project_id,
    'device_id', walker_device_id
  );
end;
$$;

create or replace function public.walker_observation_gate_a_readback()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only service_role may run Walker Gate A readback';
  end if;

  return jsonb_build_object(
    'project_count', (
      select count(*) from public.projects
      where id = '33333333-3333-4333-8333-333333333331'::uuid
    ),
    'device_count', (
      select count(*) from public.devices
      where id = 'balena:a1c4ace2b367fbee8521f1aff6a6329b'
        and project_id = '33333333-3333-4333-8333-333333333331'::uuid
    ),
    'sensor_count', (
      select count(*) from public.walker_observation_sensor_metadata
      where project_id = '33333333-3333-4333-8333-333333333331'::uuid
    ),
    'reading_count', (
      select count(*) from public.sensor_readings
      where project_id = '33333333-3333-4333-8333-333333333331'::uuid
        and device_id = 'balena:a1c4ace2b367fbee8521f1aff6a6329b'
    ),
    'bucket_count', (
      select count(*) from public.walker_observation_trace_buckets
      where project_id = '33333333-3333-4333-8333-333333333331'::uuid
    ),
    'control_token_count', (
      select count(*) from public.device_control_tokens
      where project_id = '33333333-3333-4333-8333-333333333331'::uuid
         or device_id = 'balena:a1c4ace2b367fbee8521f1aff6a6329b'
    ),
    'control_command_count', (
      select count(*) from public.project_control_commands
      where project_id = '33333333-3333-4333-8333-333333333331'::uuid
         or device_id = 'balena:a1c4ace2b367fbee8521f1aff6a6329b'
    ),
    'import_status', (
      select status from public.walker_observation_imports
      where id = '33333333-3333-4333-8333-333333333350'::uuid
    ),
    'allowlisted_users', (
      select count(distinct user_id)
      from public.system_admin_installation_access
      where project_id = '33333333-3333-4333-8333-333333333331'::uuid
        and enabled
        and revoked_at is null
    )
  );
end;
$$;

revoke all on function public.walker_observation_import_catalog(jsonb)
  from public, anon, authenticated;
revoke all on function public.walker_observation_gate_a_readback()
  from public, anon, authenticated;
grant execute on function public.walker_observation_import_catalog(jsonb)
  to service_role;
grant execute on function public.walker_observation_gate_a_readback()
  to service_role;

comment on function public.walker_observation_import_catalog(jsonb) is
  'Imports only the verified 96-row Walker historical sensor catalog. It creates no pairings, valves, or control identities.';
