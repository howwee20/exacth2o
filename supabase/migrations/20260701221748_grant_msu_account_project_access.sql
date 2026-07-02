-- Give the confirmed MSU account access to the live Matt greenhouse project.
-- The frontend still uses only the Supabase anon key; RLS gates live data by
-- project_members membership.

do $$
declare
  target_user_id uuid;
begin
  select id
  into target_user_id
  from auth.users
  where lower(email) = lower('howeeva1@msu.edu')
  limit 1;

  if target_user_id is null then
    raise exception 'Auth user howeeva1@msu.edu does not exist yet';
  end if;

  insert into public.profiles (id, email, full_name)
  values (target_user_id, 'howeeva1@msu.edu', 'EJ Howe')
  on conflict (id) do update
  set email = excluded.email,
      full_name = coalesce(public.profiles.full_name, excluded.full_name);

  insert into public.project_members (project_id, user_id, role)
  values (
    '22222222-2222-4222-8222-222222222222'::uuid,
    target_user_id,
    'owner'
  )
  on conflict (project_id, user_id) do update
  set role = excluded.role;
end $$;
