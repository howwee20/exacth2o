do $$
declare
  matt_project_id uuid := '22222222-2222-4222-8222-222222222222'::uuid;
  trigger_source text;
  policy_count integer;
begin
  if public.portal_role_for_email('hicksj23@msu.edu') <> 'admin' then
    raise exception 'Jake is not mapped to portal admin access';
  end if;

  if public.portal_role_for_email('berkley@msu.edu') <> 'admin' then
    raise exception 'Berkley is not mapped to portal admin access';
  end if;

  if not exists (
    select 1
    from public.project_invites
    where token_hash = '86e7716da5a2fe8e36bae54095b9e6d288d9733a81a2160394dd23fe413d83d2'
      and project_id = matt_project_id
      and email = 'hicksj23@msu.edu'
      and role = 'owner'
      and accepted_at is null
      and expires_at > now()
  ) then
    raise exception 'Jake invite is missing, accepted, expired, or not owner-level';
  end if;

  if not exists (
    select 1
    from public.project_invites
    where token_hash = 'fb6d682eede04f3f28542574a4f6b98afd9f8a1a2ce9e8eae6296f41554e0bf3'
      and project_id = matt_project_id
      and email = 'berkley@msu.edu'
      and role = 'owner'
      and accepted_at is null
      and expires_at > now()
  ) then
    raise exception 'Berkley invite is missing, accepted, expired, or not owner-level';
  end if;

  select p.prosrc
  into trigger_source
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'apply_project_invite_membership'
  limit 1;

  if trigger_source is null
    or position('portal_access' in trigger_source) = 0
    or position('portal_role_for_email' in trigger_source) = 0 then
    raise exception 'Invite acceptance trigger function does not grant portal access';
  end if;

  if not exists (
    select 1
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'project_invites'
      and t.tgname = 'project_invites_apply_membership_after_accept'
      and not t.tgisinternal
      and t.tgenabled in ('O', 'A')
  ) then
    raise exception 'Project invite acceptance trigger is missing or disabled';
  end if;

  if not exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'portal_access'
      and c.relrowsecurity
  ) then
    raise exception 'portal_access RLS is not enabled';
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'portal_access'
      and policyname = 'Users can read their portal access'
      and cmd in ('SELECT', 'ALL')
  ) then
    raise exception 'portal_access read policy is missing';
  end if;

  foreach trigger_source in array array[
    'pairings',
    'sensor_readings',
    'latest_device_state',
    'valve_events',
    'device_health_snapshots',
    'project_control_commands',
    'quote_requests',
    'support_threads'
  ] loop
    if not has_table_privilege('authenticated', 'public.' || quote_ident(trigger_source), 'SELECT') then
      raise exception 'authenticated role cannot select from %.%', 'public', trigger_source;
    end if;

    select count(*)
    into policy_count
    from pg_policies
    where schemaname = 'public'
      and tablename = trigger_source
      and cmd in ('SELECT', 'ALL');

    if policy_count = 0 then
      raise exception 'No SELECT RLS policy found for %.%', 'public', trigger_source;
    end if;
  end loop;
end $$;
