-- Access matrix for the portal's notes and bench layouts (and, when present, saved comparisons,
-- exclusions and per-user experiment views). Runs inside one transaction that is rolled back:
-- every user, device and row below is a disposable fixture.
--
-- Policies are exercised as the `authenticated` role with an impersonated JWT subject, so row
-- level security is enforced (a superuser would bypass it).
begin;

-- Helpers live in a schema created and discarded inside this transaction.
create schema portal_test;
create table portal_test.users (label text primary key, id uuid not null);
grant usage on schema portal_test to authenticated;
grant select on portal_test.users to authenticated;

do $$
declare
  greenhouse constant uuid := '22222222-2222-4222-8222-222222222222';
  other_project constant uuid := '99999999-9999-4999-8999-999999999991';
begin
  insert into public.organizations (id, slug, name)
  values ('99999999-9999-4999-8999-999999999990', 'portal-product-test-org', 'Portal product test org')
  on conflict (id) do nothing;
  insert into public.projects (id, organization_id, slug, name)
  values (greenhouse, '99999999-9999-4999-8999-999999999990', 'portal-product-greenhouse', 'Greenhouse (test)')
  on conflict (id) do nothing;
  insert into public.projects (id, organization_id, slug, name)
  values (other_project, '99999999-9999-4999-8999-999999999990', 'portal-product-other', 'Other project (test)')
  on conflict (id) do nothing;
  insert into public.devices (id, organization_id, project_id, name)
  values ('portal-product-test-controller', (select organization_id from public.projects where id = greenhouse), greenhouse, 'Test controller'),
         ('portal-product-second-controller', (select organization_id from public.projects where id = greenhouse), greenhouse, 'Second test controller'),
         ('portal-product-other-controller', '99999999-9999-4999-8999-999999999990', other_project, 'Other controller')
  on conflict (id) do nothing;

  insert into portal_test.users values
    ('admin', gen_random_uuid()), ('researcher', gen_random_uuid()), ('viewer', gen_random_uuid()),
    ('other', gen_random_uuid()), ('mixer', gen_random_uuid()), ('nobody', gen_random_uuid());
  insert into auth.users (id, email)
  select id, label || '@portal-product-test.invalid' from portal_test.users;
  insert into public.portal_access (project_id, user_id, email, role, access_scope)
  select greenhouse, id, label || '@portal-product-test.invalid', label, 'project'
  from portal_test.users where label in ('admin', 'researcher', 'viewer');
  insert into public.portal_access (project_id, user_id, email, role, access_scope)
  select other_project, id, 'other@portal-product-test.invalid', 'researcher', 'project'
  from portal_test.users where label = 'other';
  insert into public.portal_access (project_id, user_id, email, role, access_scope)
  select '44444444-4444-4444-8444-444444444441'::uuid, id, 'mixer@portal-product-test.invalid', 'researcher', 'gas_mixer'
  from portal_test.users where label = 'mixer';
end;
$$;

create function portal_test.act_as(label text) returns void language plpgsql as $$
declare
  user_id uuid;
begin
  select id into user_id from portal_test.users where users.label = act_as.label;
  perform set_config('request.jwt.claim.sub', user_id::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', user_id, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
end;
$$;

create function portal_test.expect_denied(statement text, reason text) returns void language plpgsql as $$
begin
  begin
    execute statement;
  exception when insufficient_privilege or check_violation or raise_exception or foreign_key_violation or invalid_parameter_value then
    return;
  end;
  raise exception 'Expected to be refused: %', reason;
end;
$$;

grant execute on function portal_test.act_as(text), portal_test.expect_denied(text, text) to authenticated;


-- New product RPCs are read-only and do not expose invite tokens or widen installation access.
insert into public.project_invites(project_id,email,role,token_hash,expires_at)
values ('22222222-2222-4222-8222-222222222222','pending@product-test.invalid','viewer',repeat('a',64),now()+interval '1 day');
insert into public.system_admin_installation_access(project_id,device_id,portal_project_id,user_id,capability)
select '33333333-3333-4333-8333-333333333331','balena:a1c4ace2b367fbee8521f1aff6a6329b','22222222-2222-4222-8222-222222222222',id,'observe' from portal_test.users where label='admin';
select portal_test.act_as('admin');
do $$ declare payload jsonb; recorded jsonb; expected timestamptz; begin
 payload := public.portal_team_snapshot('22222222-2222-4222-8222-222222222222');
 if not (payload->'members') @> '[{"email":"admin@portal-product-test.invalid"},{"email":"researcher@portal-product-test.invalid"},{"email":"viewer@portal-product-test.invalid"}]'::jsonb or not (payload->'invites') @> '[{"email":"pending@product-test.invalid"}]'::jsonb then raise exception 'Incomplete team snapshot'; end if;
 if (payload->'members') @> '[{"email":"other@portal-product-test.invalid"}]'::jsonb then raise exception 'Cross-project member leaked'; end if;
 if payload::text like '%token_hash%' or payload::text like '%user_id%' then raise exception 'Team snapshot contains private identifiers'; end if;
 recorded := public.walker_latest_recorded_snapshot('33333333-3333-4333-8333-333333333331','balena:a1c4ace2b367fbee8521f1aff6a6329b',99999,99999);
 if (recorded->>'window_hours')::integer<>168 or (recorded->>'point_budget')::integer<>576 then raise exception 'Unbounded Walker window'; end if;
 if recorded->>'portal_control_available'<>'false' then raise exception 'Walker observation exposed control'; end if;
end $$;
select portal_test.expect_denied($q$ select public.portal_team_snapshot('99999999-9999-4999-8999-999999999991') $q$,'admin reading another project');
select portal_test.expect_denied($q$ select public.walker_latest_recorded_snapshot('22222222-2222-4222-8222-222222222222','portal-product-test-controller',72,288) $q$,'wrong installation');
select portal_test.act_as('researcher');
select portal_test.expect_denied($q$ select public.portal_team_snapshot('22222222-2222-4222-8222-222222222222') $q$,'researcher reading team directory');
select portal_test.expect_denied($q$ select public.walker_latest_recorded_snapshot() $q$,'ordinary project member reading Walker');
select portal_test.act_as('viewer');
select portal_test.expect_denied($q$ select public.portal_team_snapshot('22222222-2222-4222-8222-222222222222') $q$,'viewer reading team directory');
select portal_test.act_as('mixer');
select portal_test.expect_denied($q$ select public.portal_team_snapshot('44444444-4444-4444-8444-444444444441') $q$,'scoped equipment member reading team');
select portal_test.act_as('nobody');
select portal_test.expect_denied($q$ select public.portal_team_snapshot('22222222-2222-4222-8222-222222222222') $q$,'unassigned account reading team');
reset role;
do $$ begin
 if has_function_privilege('anon','public.portal_team_snapshot(uuid)','EXECUTE') or has_function_privilege('anon','public.walker_latest_recorded_snapshot(uuid,text,integer,integer)','EXECUTE') then raise exception 'Anonymous RPC access'; end if;
end $$;
rollback;
