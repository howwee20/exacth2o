-- Backstop invite acceptance at the database layer.
-- When a valid invite is accepted, the accepted Auth user receives the matching
-- profile and project_members row immediately, so RLS can see the project.

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
    else split_part(lower(trim(invite_email)), '@', 1)
  end;
$$;
create or replace function public.apply_project_invite_membership()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.accepted_at is null or new.accepted_by is null then
    return new;
  end if;

  insert into public.profiles (id, email, full_name)
  values (
    new.accepted_by,
    lower(trim(new.email)),
    public.invite_profile_name(new.email)
  )
  on conflict (id) do update
  set email = excluded.email,
      full_name = coalesce(public.profiles.full_name, excluded.full_name);

  insert into public.project_members (project_id, user_id, role)
  values (
    new.project_id,
    new.accepted_by,
    new.role
  )
  on conflict (project_id, user_id) do update
  set role = excluded.role;

  return new;
end;
$$;
drop trigger if exists project_invites_apply_membership_after_accept
  on public.project_invites;
create trigger project_invites_apply_membership_after_accept
after update of accepted_at, accepted_by
on public.project_invites
for each row
when (
  new.accepted_at is not null
  and new.accepted_by is not null
)
execute function public.apply_project_invite_membership();
-- Backfill accepted invite users, including the Gmail test account.
with accepted_invites as (
  select distinct on (accepted_by)
    accepted_by,
    lower(trim(email)) as email
  from public.project_invites
  where accepted_at is not null
    and accepted_by is not null
  order by accepted_by, accepted_at desc
)
insert into public.profiles (id, email, full_name)
select
  accepted_by,
  email,
  public.invite_profile_name(email)
from accepted_invites
on conflict (id) do update
set email = excluded.email,
    full_name = coalesce(public.profiles.full_name, excluded.full_name);
with accepted_invites as (
  select distinct on (project_id, accepted_by)
    project_id,
    accepted_by,
    role,
    accepted_at
  from public.project_invites
  where accepted_at is not null
    and accepted_by is not null
  order by project_id, accepted_by, accepted_at desc
)
insert into public.project_members (project_id, user_id, role)
select
  project_id,
  accepted_by,
  role
from accepted_invites
on conflict (project_id, user_id) do update
set role = excluded.role;
-- Also align any already-created named accounts with the Matt project.
with named_users as (
  select
    id,
    lower(email) as email
  from auth.users
  where lower(email) in (
    'howeeva1@msu.edu',
    'howeej2255@gmail.com',
    'statamat@msu.edu',
    'basyalbi@msu.edu'
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
  select id
  from auth.users
  where lower(email) in (
    'howeeva1@msu.edu',
    'howeej2255@gmail.com',
    'statamat@msu.edu',
    'basyalbi@msu.edu'
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
