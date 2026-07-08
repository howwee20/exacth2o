create or replace function public.invite_profile_name(invite_email text)
returns text
language sql
immutable
as $$
  select case lower(trim(invite_email))
    when 'howeeva1@msu.edu' then 'EJ Howe'
    when 'howeej2255@gmail.com' then 'EJ Howe'
    when 'statamat@msu.edu' then 'Matt Stata'
    when 'basyalbi@msu.edu' then 'Binod Basyal'
    when 'hicksj23@msu.edu' then 'Jake Hicks'
    when 'berkley@msu.edu' then 'Berkley'
    else split_part(lower(trim(invite_email)), '@', 1)
  end;
$$;

create or replace function public.portal_role_for_email(account_email text)
returns text
language sql
immutable
as $$
  select case lower(trim(account_email))
    when 'howeeva1@msu.edu' then 'admin'
    when 'basyalbi@msu.edu' then 'admin'
    when 'hicksj23@msu.edu' then 'admin'
    when 'berkley@msu.edu' then 'admin'
    when 'statamat@msu.edu' then 'researcher'
    when 'howeej2255@gmail.com' then 'researcher'
    else null
  end;
$$;

insert into public.project_invites (
  token_hash,
  project_id,
  email,
  role,
  expires_at,
  created_by
)
values
  (
    '86e7716da5a2fe8e36bae54095b9e6d288d9733a81a2160394dd23fe413d83d2',
    '22222222-2222-4222-8222-222222222222'::uuid,
    'hicksj23@msu.edu',
    'owner',
    now() + interval '14 days',
    null
  ),
  (
    'fb6d682eede04f3f28542574a4f6b98afd9f8a1a2ce9e8eae6296f41554e0bf3',
    '22222222-2222-4222-8222-222222222222'::uuid,
    'berkley@msu.edu',
    'owner',
    now() + interval '14 days',
    null
  )
on conflict (token_hash) do nothing;

with named_users as (
  select
    id,
    lower(email) as email
  from auth.users
  where lower(email) in (
    'hicksj23@msu.edu',
    'berkley@msu.edu'
  )
)
insert into public.profiles (id, email, full_name)
select
  id,
  email,
  public.invite_profile_name(email)
from named_users
on conflict (id) do update
set email = excluded.email,
    full_name = coalesce(public.profiles.full_name, excluded.full_name);

with named_users as (
  select
    id,
    lower(email) as email
  from auth.users
  where lower(email) in (
    'hicksj23@msu.edu',
    'berkley@msu.edu'
  )
)
insert into public.project_members (project_id, user_id, role)
select
  '22222222-2222-4222-8222-222222222222'::uuid,
  id,
  'owner'
from named_users
on conflict (project_id, user_id) do update
set role = excluded.role;

with named_users as (
  select
    id,
    lower(email) as email,
    public.portal_role_for_email(email) as portal_role
  from auth.users
  where lower(email) in (
    'hicksj23@msu.edu',
    'berkley@msu.edu'
  )
)
insert into public.portal_access (project_id, user_id, email, role)
select
  '22222222-2222-4222-8222-222222222222'::uuid,
  id,
  email,
  portal_role
from named_users
where portal_role is not null
on conflict (project_id, user_id) do update
set email = excluded.email,
    role = excluded.role,
    updated_at = now();
