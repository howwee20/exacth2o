-- Grant Walker Pi 5 observation to the four established system administrators.
-- This is read-only installation access and creates no controller, irrigation,
-- pairing, calibration, valve, or watering authority.

do $$
declare
  walker_project_id constant uuid :=
    '33333333-3333-4333-8333-333333333331'::uuid;
  walker_device_id constant text :=
    'balena:a1c4ace2b367fbee8521f1aff6a6329b';
  portal_project_id constant uuid :=
    '22222222-2222-4222-8222-222222222222'::uuid;
  expected_emails constant text[] := array[
    'basyalbi@msu.edu',
    'berkley@msu.edu',
    'hicksj23@msu.edu',
    'howeeva1@msu.edu'
  ];
  matched_count integer;
begin
  select count(*)
  into matched_count
  from auth.users users
  join public.portal_access portal
    on portal.project_id = portal_project_id
   and portal.user_id = users.id
   and portal.role = 'admin'
  where lower(users.email) = any(expected_emails);

  if matched_count <> cardinality(expected_emails) then
    raise exception
      'Walker observation grant aborted: expected % portal administrators, found %',
      cardinality(expected_emails),
      matched_count;
  end if;

  insert into public.system_admin_installation_access (
    project_id,
    device_id,
    portal_project_id,
    user_id,
    capability,
    enabled,
    revoked_at,
    granted_at,
    metadata
  )
  select
    walker_project_id,
    walker_device_id,
    portal_project_id,
    users.id,
    'observe',
    true,
    null,
    now(),
    jsonb_build_object(
      'reason', 'Walker Pi 5 system-admin observation',
      'email', lower(users.email)
    )
  from auth.users users
  join public.portal_access portal
    on portal.project_id = portal_project_id
   and portal.user_id = users.id
   and portal.role = 'admin'
  where lower(users.email) = any(expected_emails)
  on conflict (project_id, device_id, user_id, capability) do update
  set
    enabled = true,
    revoked_at = null,
    granted_at = now(),
    metadata = excluded.metadata;
end $$;
