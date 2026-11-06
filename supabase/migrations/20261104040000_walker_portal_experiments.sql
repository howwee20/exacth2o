-- Observation records only. No link to control plans, pairings, or irrigation commands.
begin;

create table public.walker_portal_experiments (
  id uuid primary key,
  project_id uuid not null default '33333333-3333-4333-8333-333333333331'::uuid
    references public.projects(id) on delete cascade
    check (project_id = '33333333-3333-4333-8333-333333333331'::uuid),
  device_id text not null default 'balena:a1c4ace2b367fbee8521f1aff6a6329b'
    references public.devices(id) on delete cascade
    check (device_id = 'balena:a1c4ace2b367fbee8521f1aff6a6329b'),
  name text not null check (char_length(btrim(name)) between 1 and 120),
  sensor_ids integer[] not null check (cardinality(sensor_ids) between 1 and 100),
  started_at timestamptz not null default now(),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

alter table public.walker_portal_experiments enable row level security;
revoke all on public.walker_portal_experiments from public, anon, authenticated;
grant select on public.walker_portal_experiments to authenticated;
grant all on public.walker_portal_experiments to service_role;

create policy walker_portal_experiment_read on public.walker_portal_experiments
  for select to authenticated
  using (public.has_system_admin_installation_access(project_id, device_id, 'observe'));

create function public.create_walker_portal_experiment(
  requested_name text,
  requested_sensor_ids integer[],
  request_id uuid
) returns public.walker_portal_experiments
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  walker_project constant uuid := '33333333-3333-4333-8333-333333333331'::uuid;
  walker_device constant text := 'balena:a1c4ace2b367fbee8521f1aff6a6329b';
  caller uuid := auth.uid();
  selected_ids integer[];
  result public.walker_portal_experiments;
begin
  if caller is null or not public.has_system_admin_installation_access(walker_project, walker_device, 'observe') then
    raise exception 'Walker observation access is required' using errcode = '42501';
  end if;
  if request_id is null or requested_name is null or char_length(btrim(requested_name)) not between 1 and 120 then
    raise exception 'Enter an experiment name (1–120 characters)' using errcode = '22023';
  end if;
  select array_agg(distinct sensor_id order by sensor_id) into selected_ids
    from unnest(requested_sensor_ids) sensor_id;
  if selected_ids is null or cardinality(selected_ids) not between 1 and 100 or array_position(selected_ids, null) is not null then
    raise exception 'Select 1–100 Walker sensors' using errcode = '22023';
  end if;
  if exists (
    select 1 from unnest(selected_ids) sensor_id
    where not exists (select 1 from public.walker_observation_sensor_metadata m
      where m.project_id = walker_project and m.device_id = walker_device and m.source_sensor_id = sensor_id)
  ) then
    raise exception 'A selected sensor does not belong to Walker Pi' using errcode = '22023';
  end if;

  insert into public.walker_portal_experiments (id, name, sensor_ids, created_by)
    values (request_id, btrim(requested_name), selected_ids, caller)
    on conflict (id) do nothing;
  select * into result from public.walker_portal_experiments where id = request_id;
  if result.created_by <> caller or result.name <> btrim(requested_name) or result.sensor_ids <> selected_ids then
    raise exception 'This request has already been used' using errcode = '22023';
  end if;
  return result;
end;
$$;

revoke all on function public.create_walker_portal_experiment(text, integer[], uuid) from public, anon;
grant execute on function public.create_walker_portal_experiment(text, integer[], uuid) to authenticated;
comment on table public.walker_portal_experiments is 'Named, time-bounded Walker observation selections. Does not configure sensors or irrigation.';
commit;
