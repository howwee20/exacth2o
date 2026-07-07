create or replace function public.portal_role_for_email(account_email text)
returns text
language sql
immutable
as $$
  select case lower(trim(account_email))
    when 'howeeva1@msu.edu' then 'admin'
    when 'basyalbi@msu.edu' then 'admin'
    when 'statamat@msu.edu' then 'researcher'
    when 'howeej2255@gmail.com' then 'researcher'
    else null
  end;
$$;

with named_users as (
  select
    id,
    lower(email) as email,
    public.portal_role_for_email(email) as portal_role
  from auth.users
  where lower(email) in (
    'howeeva1@msu.edu',
    'basyalbi@msu.edu',
    'statamat@msu.edu',
    'howeej2255@gmail.com'
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
