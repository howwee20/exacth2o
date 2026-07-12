-- Explicit allowlist for the private R&D Lab. Portal role alone is insufficient.
-- Matt and howeej2255 are intentionally absent and retain researcher-only access.

do $$
declare
  matt_project_id constant uuid := '22222222-2222-4222-8222-222222222222';
  expected_emails constant text[] := array[
    'basyalbi@msu.edu',
    'berkley@msu.edu',
    'hicksj23@msu.edu',
    'howeeva1@msu.edu'
  ];
  matched_count integer;
begin
  select count(*) into matched_count
  from auth.users
  where lower(email) = any(expected_emails);

  if matched_count <> cardinality(expected_emails) then
    raise exception 'R&D allowlist grant aborted: expected % users, found %',
      cardinality(expected_emails), matched_count;
  end if;

  insert into public.rd_system_admin_access (project_id, user_id, enabled)
  select matt_project_id, id, true
  from auth.users
  where lower(email) = any(expected_emails)
  on conflict (project_id, user_id) do update
  set enabled = true,
      revoked_at = null,
      granted_at = now();
end $$;

comment on table public.rd_system_admin_access is
  'Explicit R&D Lab allowlist; independent from normal portal admin/researcher roles.';
