-- Transaction-only checks for the zero-invocation Edge usage monitor.
begin;
do $$
declare
  admin_user uuid := gen_random_uuid();
  outsider uuid := gen_random_uuid();
  first_row public.edge_usage_observations%rowtype;
  later_row public.edge_usage_observations%rowtype;
  summary jsonb;
begin
  delete from public.edge_usage_observations;
  if public.record_edge_usage_observation() <> 'unknown' then
    raise exception 'The first observation has no baseline and must be unknown';
  end if;
  select * into first_row from public.edge_usage_observations order by observed_at desc limit 1;
  if first_row.counters is null or first_row.projected_31_day_calls <> 0 then
    raise exception 'The first observation must record counters only';
  end if;

  -- A synthetic previous hour 10,000 calls below the current counters.
  update public.edge_usage_observations
  set observed_at = now() - interval '1 hour',
      counters = (select jsonb_object_agg(key, greatest(0, value::bigint - 10000)) from jsonb_each_text(first_row.counters))
  where observed_at = first_row.observed_at;
  perform public.record_edge_usage_observation();
  select * into later_row from public.edge_usage_observations order by observed_at desc limit 1;
  if first_row.counters <> '{}'::jsonb then
    if later_row.window_seconds < 3590 or later_row.estimated_calls < 1 then
      raise exception 'Hourly deltas were not computed: %', to_jsonb(later_row);
    end if;
    if later_row.projected_31_day_calls <> round(later_row.estimated_calls::numeric * 31 * 86400 / later_row.window_seconds) then
      raise exception 'Projection does not scale the window to 31 days';
    end if;
    if later_row.status not in ('ok', 'warn', 'critical') then
      raise exception 'A complete window must be classified: %', later_row.status;
    end if;
  end if;

  -- A counter reset (current below previous) is reported as unknown, never as a low rate.
  update public.edge_usage_observations
  set counters = (select jsonb_object_agg(key, value::bigint + 1000000) from jsonb_each_text(later_row.counters))
  where observed_at = later_row.observed_at;
  if first_row.counters <> '{}'::jsonb and public.record_edge_usage_observation() <> 'unknown' then
    raise exception 'A counter reset must be reported as unknown';
  end if;

  -- Only portal administrators can read the summary.
  insert into auth.users(id, email) values (admin_user, 'usage-admin@example.invalid'), (outsider, 'usage-outsider@example.invalid');
  insert into public.portal_access(project_id, user_id, email, role, access_scope)
    values ('22222222-2222-4222-8222-222222222222', admin_user, 'usage-admin@example.invalid', 'admin', 'project');
  perform set_config('request.jwt.claim.sub', admin_user::text, true);
  summary := public.edge_usage_budget();
  if summary->'latest' is null or summary->'latest' ? 'counters' or (summary->>'included_calls')::bigint <> 2000000 then
    raise exception 'Admin summary is incomplete: %', summary;
  end if;
  perform set_config('request.jwt.claim.sub', outsider::text, true);
  begin
    perform public.edge_usage_budget();
    raise exception 'A non-admin read the usage summary';
  exception when insufficient_privilege then null;
  end;
end;
$$;
rollback;
