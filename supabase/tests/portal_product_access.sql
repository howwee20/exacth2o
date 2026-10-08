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
  exception when insufficient_privilege or check_violation or raise_exception or foreign_key_violation then
    return;
  end;
  raise exception 'Expected to be refused: %', reason;
end;
$$;

grant execute on function portal_test.act_as(text), portal_test.expect_denied(text, text) to authenticated;

-- ---------------------------------------------------------------- notes

select portal_test.act_as('researcher');
insert into public.portal_pot_notes (id, project_id, device_id, pairing_name, body, tags, observed_at, author_label)
values ('11111111-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222', 'portal-product-test-controller',
        'Zone3-Pot17', 'Reseated the B3 ribbon cable.', array['sensor reseated'], now() - interval '20 minutes', 'spoofed name');
-- An offline retry of the same note is a no-op, not a duplicate.
insert into public.portal_pot_notes (id, project_id, device_id, pairing_name, body, observed_at, author_label)
values ('11111111-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222', 'portal-product-test-controller',
        'Zone3-Pot17', 'Reseated the B3 ribbon cable.', now() - interval '20 minutes', 'x')
on conflict (id) do nothing;
reset role;

do $$
declare
  note record;
begin
  select * into note from public.portal_pot_notes where id = '11111111-0000-4000-8000-000000000001';
  if note is null then raise exception 'Researcher note was not stored'; end if;
  if note.author_label <> 'researcher@portal-product-test.invalid' then
    raise exception 'Author label came from the client (%), not the account', note.author_label;
  end if;
  if note.created_by <> (select id from portal_test.users where label = 'researcher') then
    raise exception 'Note author is not the signed-in user';
  end if;
  if (select count(*) from public.portal_pot_notes where id = '11111111-0000-4000-8000-000000000001') <> 1 then
    raise exception 'A retried note was duplicated';
  end if;
end;
$$;

select portal_test.act_as('viewer');
do $$
begin
  if (select count(*) from public.portal_pot_notes where project_id = '22222222-2222-4222-8222-222222222222') <> 1 then
    raise exception 'Viewer cannot read the project''s notes';
  end if;
end;
$$;
select portal_test.expect_denied($q$
  insert into public.portal_pot_notes (id, project_id, device_id, pairing_name, body, observed_at, author_label)
  values (gen_random_uuid(), '22222222-2222-4222-8222-222222222222', 'portal-product-test-controller', 'Zone1-Pot1', 'viewer note', now(), 'v')
$q$, 'viewer writing a note');
reset role;

select portal_test.act_as('other');
do $$
begin
  if exists (select 1 from public.portal_pot_notes where project_id = '22222222-2222-4222-8222-222222222222') then
    raise exception 'Another project''s account can read greenhouse notes';
  end if;
end;
$$;
select portal_test.expect_denied($q$
  insert into public.portal_pot_notes (id, project_id, device_id, pairing_name, body, observed_at, author_label)
  values (gen_random_uuid(), '22222222-2222-4222-8222-222222222222', 'portal-product-test-controller', 'Zone1-Pot1', 'cross-project', now(), 'o')
$q$, 'cross-project note');
-- Writing into one's own project against another project's controller is refused.
select portal_test.expect_denied($q$
  insert into public.portal_pot_notes (id, project_id, device_id, pairing_name, body, observed_at, author_label)
  values (gen_random_uuid(), '99999999-9999-4999-8999-999999999991', 'portal-product-test-controller', 'Zone1-Pot1', 'wrong controller', now(), 'o')
$q$, 'note on another project''s controller');
reset role;

select portal_test.act_as('mixer');
do $$
begin
  if exists (select 1 from public.portal_pot_notes) then
    raise exception 'A gas-mixer-only account can read irrigation notes';
  end if;
end;
$$;
select portal_test.expect_denied($q$
  insert into public.portal_pot_notes (id, project_id, device_id, pairing_name, body, observed_at, author_label)
  values (gen_random_uuid(), '22222222-2222-4222-8222-222222222222', 'portal-product-test-controller', 'Zone1-Pot1', 'mixer', now(), 'm')
$q$, 'gas-mixer-scoped account writing a note');
reset role;

select portal_test.act_as('nobody');
do $$
begin
  if exists (select 1 from public.portal_pot_notes) then raise exception 'An account without access can read notes'; end if;
end;
$$;
reset role;

select portal_test.act_as('researcher');
-- Notes are append-only for everyone in the browser.
select portal_test.expect_denied($q$update public.portal_pot_notes set body = 'edited' where id = '11111111-0000-4000-8000-000000000001'$q$, 'editing a note');
select portal_test.expect_denied($q$delete from public.portal_pot_notes where id = '11111111-0000-4000-8000-000000000001'$q$, 'deleting a note');
select portal_test.expect_denied($q$
  insert into public.portal_pot_notes (id, project_id, device_id, pairing_name, body, observed_at, author_label)
  values (gen_random_uuid(), '22222222-2222-4222-8222-222222222222', 'portal-product-test-controller', 'Zone1-Pot1', 'from the future', now() + interval '2 days', 'r')
$q$, 'note dated in the future');
-- A correction must refer to a note about the same pot.
select portal_test.expect_denied($q$
  insert into public.portal_pot_notes (id, project_id, device_id, pairing_name, body, observed_at, author_label, supersedes_id)
  values (gen_random_uuid(), '22222222-2222-4222-8222-222222222222', 'portal-product-test-controller', 'Zone1-Pot1', 'wrong pot', now(), 'r', '11111111-0000-4000-8000-000000000001')
$q$, 'correction of a note about another pot');
insert into public.portal_pot_notes (id, project_id, device_id, pairing_name, body, observed_at, author_label, supersedes_id)
values (gen_random_uuid(), '22222222-2222-4222-8222-222222222222', 'portal-product-test-controller', 'Zone3-Pot17',
        'Correction: it was the B3 cable at the controller end.', now(), 'r', '11111111-0000-4000-8000-000000000001');
reset role;

do $$
begin
  if (select body from public.portal_pot_notes where id = '11111111-0000-4000-8000-000000000001') <> 'Reseated the B3 ribbon cable.' then
    raise exception 'A note was edited through the browser role';
  end if;
  if (select count(*) from public.portal_pot_notes where pairing_name = 'Zone3-Pot17') <> 2 then
    raise exception 'The correction did not add a second, linked note';
  end if;
end;
$$;

-- ---------------------------------------------------------------- bench layouts

select portal_test.act_as('researcher');
select portal_test.expect_denied($q$
  insert into public.portal_bench_layout_versions (project_id, device_id, version, layout, author_label)
  values ('22222222-2222-4222-8222-222222222222', 'portal-product-test-controller', 1,
    '{"benches":[{"id":"A","label":"Bench A","rows":2,"columns":4}],"positions":[]}', 'r')
$q$, 'researcher recording a layout');
reset role;

select portal_test.act_as('admin');
insert into public.portal_bench_layout_versions (project_id, device_id, version, layout, author_label)
values ('22222222-2222-4222-8222-222222222222', 'portal-product-test-controller', 99,
  '{"benches":[{"id":"A","label":"Bench A","rows":2,"columns":4}],"positions":[{"pairing_name":"Zone1-Pot1","bench":"A","row":1,"column":1},{"pairing_name":"Zone1-Pot2","bench":"A","row":1,"column":2}]}', 'a');
insert into public.portal_bench_layout_versions (project_id, device_id, version, layout, author_label)
values ('22222222-2222-4222-8222-222222222222', 'portal-product-test-controller', 1,
  '{"benches":[{"id":"A","label":"Bench A","rows":2,"columns":4}],"positions":[{"pairing_name":"Zone1-Pot1","bench":"A","row":2,"column":1}]}', 'a');
select portal_test.expect_denied($q$
  insert into public.portal_bench_layout_versions (project_id, device_id, version, layout, author_label)
  values ('22222222-2222-4222-8222-222222222222', 'portal-product-test-controller', 1,
    '{"benches":[{"id":"A","label":"Bench A","rows":2,"columns":4}],"positions":[{"pairing_name":"Zone1-Pot1","bench":"A","row":1,"column":1},{"pairing_name":"Zone1-Pot2","bench":"A","row":1,"column":1}]}', 'a')
$q$, 'two pots in one place');
select portal_test.expect_denied($q$
  insert into public.portal_bench_layout_versions (project_id, device_id, version, layout, author_label)
  values ('22222222-2222-4222-8222-222222222222', 'portal-product-test-controller', 1,
    '{"benches":[{"id":"A","label":"Bench A","rows":2,"columns":4}],"positions":[{"pairing_name":"Zone1-Pot1","bench":"A","row":5,"column":1}]}', 'a')
$q$, 'position outside its bench');
select portal_test.expect_denied($q$update public.portal_bench_layout_versions set note = 'edited'$q$, 'editing a layout version');
reset role;

do $$
begin
  if (select array_agg(version order by version) from public.portal_bench_layout_versions
      where device_id = 'portal-product-test-controller') <> array[1, 2] then
    raise exception 'Layout versions were not assigned in sequence by the database';
  end if;
  if exists (select 1 from public.portal_bench_layout_versions where note = 'edited') then
    raise exception 'A layout version was edited through the browser role';
  end if;
end;
$$;

select portal_test.act_as('other');
do $$
begin
  if exists (select 1 from public.portal_bench_layout_versions where project_id = '22222222-2222-4222-8222-222222222222') then
    raise exception 'Another project''s account can read greenhouse layouts';
  end if;
end;
$$;
reset role;

rollback;
