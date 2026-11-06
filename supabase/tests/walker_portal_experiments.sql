-- Run inside a transaction and roll it back. These checks never send a command.
do $$
declare
  actor uuid;
  sensor integer;
  request uuid := gen_random_uuid();
  created public.walker_portal_experiments;
  retried public.walker_portal_experiments;
begin
  select a.user_id into actor from public.system_admin_installation_access a
    join public.portal_access p on p.user_id = a.user_id and p.project_id = a.portal_project_id and p.role = 'admin'
    where a.project_id = '33333333-3333-4333-8333-333333333331'::uuid
      and a.device_id = 'balena:a1c4ace2b367fbee8521f1aff6a6329b'
      and a.capability = 'observe' and a.enabled and a.revoked_at is null limit 1;
  select source_sensor_id into sensor from public.walker_observation_sensor_metadata
    where project_id = '33333333-3333-4333-8333-333333333331'::uuid order by source_sensor_id limit 1;
  if actor is null or sensor is null then raise exception 'Missing authorized Walker fixture'; end if;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', actor, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  created := public.create_walker_portal_experiment('Release verification', array[sensor], request);
  retried := public.create_walker_portal_experiment('Release verification', array[sensor], request);
  if created.id <> retried.id or created.project_id <> '33333333-3333-4333-8333-333333333331'::uuid or created.sensor_ids <> array[sensor] then
    raise exception 'Scope or retry failed';
  end if;
  if (select count(*) from public.walker_portal_experiments where id = request) <> 1 then raise exception 'Retry duplicated the record'; end if;
  begin
    perform public.create_walker_portal_experiment('Bad sensor', array[-9999], gen_random_uuid());
    raise exception 'Invalid sensor was accepted';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.create_walker_portal_experiment('Empty selection', array[]::integer[], gen_random_uuid());
    raise exception 'Empty selection was accepted';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.create_walker_portal_experiment('Different record', array[sensor], request);
    raise exception 'Idempotency conflict was accepted';
  exception when invalid_parameter_value then null;
  end;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', gen_random_uuid(), 'role', 'authenticated')::text, true);
  begin
    perform public.create_walker_portal_experiment('Unauthorized', array[sensor], gen_random_uuid());
    raise exception 'Unauthorized caller was accepted';
  exception when insufficient_privilege then null;
  end;
  if exists (select 1 from public.walker_portal_experiments where id = request) then raise exception 'RLS exposed a record to an unauthorized user'; end if;
  if has_table_privilege('authenticated', 'public.walker_portal_experiments', 'INSERT') or
     has_table_privilege('authenticated', 'public.walker_portal_experiments', 'UPDATE') or
     has_table_privilege('authenticated', 'public.walker_portal_experiments', 'DELETE') then raise exception 'Unexpected direct write grant'; end if;
  execute 'reset role';
end;
$$;
