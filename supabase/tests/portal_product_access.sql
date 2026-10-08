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

-- ---------------------------------------------------------------- notes

select portal_test.act_as('researcher');
select portal_test.expect_denied($q$
  insert into public.portal_pot_notes (id, project_id, device_id, pairing_name, body, observed_at, author_label, created_by)
  values (gen_random_uuid(), '22222222-2222-4222-8222-222222222222', 'portal-product-test-controller',
          'Zone3-Pot17', 'Another account''s queued draft', now(), 'r', (select id from portal_test.users where label = 'viewer'))
$q$, 're-attributing a queued draft to another signed-in account');
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
  if (select count(*) from public.portal_pot_notes where id = '11111111-0000-4000-8000-000000000001') <> 1 then
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
select portal_test.expect_denied($q$
  insert into public.portal_pot_notes (id, project_id, device_id, pairing_name, body, observed_at, author_label, supersedes_id)
  values (gen_random_uuid(), '22222222-2222-4222-8222-222222222222', 'portal-product-second-controller',
          'Zone3-Pot17', 'Same pairing name on another controller', now(), 'r', '11111111-0000-4000-8000-000000000001')
$q$, 'correction on another controller with the same pairing name');
insert into public.portal_pot_notes (id, project_id, device_id, pairing_name, body, observed_at, author_label, supersedes_id)
values (gen_random_uuid(), '22222222-2222-4222-8222-222222222222', 'portal-product-test-controller', 'Zone3-Pot17',
        'Correction: it was the B3 cable at the controller end.', now(), 'r', '11111111-0000-4000-8000-000000000001');
reset role;

do $$
begin
  if (select body from public.portal_pot_notes where id = '11111111-0000-4000-8000-000000000001') <> 'Reseated the B3 ribbon cable.' then
    raise exception 'A note was edited through the browser role';
  end if;
  if (select count(*) from public.portal_pot_notes where supersedes_id = '11111111-0000-4000-8000-000000000001' and pairing_name = 'Zone3-Pot17') <> 1 then
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
do $$
declare malformed jsonb;
begin
  for malformed in select value from jsonb_array_elements('[
    {},
    {"benches":null,"positions":[]},
    {"benches":[{"id":"A","label":"Bench A","rows":2,"columns":4}]},
    {"benches":[{"id":"A","rows":2,"columns":4}],"positions":[]},
    {"benches":[{"id":"A","label":"Bench A","rows":null,"columns":4}],"positions":[]},
    {"benches":[{"id":"A","label":"Bench A","rows":1.5,"columns":4}],"positions":[]},
    {"benches":[{"id":"A","label":"Bench A","rows":2,"columns":4}],"positions":[{}]},
    {"benches":[{"id":"A","label":"Bench A","rows":2,"columns":4}],"positions":[{"pairing_name":"Zone1-Pot1","bench":"A","row":1.5,"column":1}]},
    {"benches":[{"id":"A","label":"Bench A","rows":2,"columns":4}],"positions":[{"pairing_name":"Zone1-Pot1","bench":null,"row":1,"column":1}]},
    {"benches":[{"id":"A","label":"Bench A","rows":2,"columns":4}],"positions":[{"pairing_name":"Zone1-Pot1","bench":"A","row":1,"column":1},{"pairing_name":"Zone1-Pot2","bench":"A","row":1.0,"column":1.0}]}
  ]'::jsonb) loop
    perform portal_test.expect_denied(format($q$
      insert into public.portal_bench_layout_versions (project_id, device_id, version, layout, author_label)
      values ('22222222-2222-4222-8222-222222222222', 'portal-product-test-controller', 1, %L::jsonb, 'a')
    $q$, malformed), 'missing, null or fractional bench layout field');
  end loop;
end;
$$;
insert into public.portal_bench_layout_versions (project_id, device_id, version, layout, author_label)
values ('22222222-2222-4222-8222-222222222222', 'portal-product-test-controller', 99,
  '{"benches":[{"id":"A","label":"Bench A","rows":2.0,"columns":4.0}],"positions":[{"pairing_name":"Zone1-Pot1","bench":"A","row":1.0,"column":1.0},{"pairing_name":"Zone1-Pot2","bench":"A","row":1,"column":2}]}', 'a');
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

-- ---------------------------------------------------------------- comparisons and exclusions

reset role;
insert into public.project_members (project_id, user_id, role)
select '22222222-2222-4222-8222-222222222222', id, label from portal_test.users where label in ('admin', 'researcher', 'viewer');
insert into public.project_members (project_id, user_id, role)
select '99999999-9999-4999-8999-999999999991', id, 'researcher' from portal_test.users where label = 'other';
insert into public.experiments (id, project_id, slug, name, mode, visible_to_roles) values
  ('77777777-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222', 'portal-product-admin-only', 'Admin-only trial', 'observation', array['admin']),
  ('77777777-0000-4000-8000-000000000002', '22222222-2222-4222-8222-222222222222', 'portal-product-shared', 'Shared trial', 'observation', array['admin', 'researcher']);
-- 120 readings, one a minute, alternating between two pots; and one open valve event.
insert into public.sensor_readings (event_id, organization_id, project_id, device_id, pairing_name, device_recorded_at, raw_value, calibrated_value)
select 'portal-product-test-' || n, (select organization_id from public.projects where id = '22222222-2222-4222-8222-222222222222'),
       '22222222-2222-4222-8222-222222222222', 'portal-product-test-controller', 'Zone1-Pot' || (n % 2 + 1),
       now() - make_interval(mins => n), 500 + n, 30 + (n % 5)
from generate_series(1, 120) n;
insert into public.valve_events (event_id, organization_id, project_id, device_id, pairing_name, action, duration_ms, device_recorded_at)
values ('portal-product-test-valve-1', (select organization_id from public.projects where id = '22222222-2222-4222-8222-222222222222'),
        '22222222-2222-4222-8222-222222222222', 'portal-product-test-controller', 'Zone1-Pot1', 'open', 3000, now() - interval '10 minutes');

select portal_test.act_as('researcher');
insert into public.portal_comparisons (id, project_id, device_id, experiment_id, question, definition, sharing, author_label) values
  ('88888888-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222', 'portal-product-test-controller',
   '77777777-0000-4000-8000-000000000002', 'Did pot 1 dry faster than pot 2?', '{"measure":"vwc"}', 'private', 'spoofed'),
  ('88888888-0000-4000-8000-000000000002', '22222222-2222-4222-8222-222222222222', 'portal-product-test-controller',
   '77777777-0000-4000-8000-000000000002', 'Are the two pots alike?', '{"measure":"vwc"}', 'project', 'spoofed');
do $$
begin
  if (select author_label from public.portal_comparisons where id = '88888888-0000-4000-8000-000000000001') <> 'researcher@portal-product-test.invalid' then
    raise exception 'The comparison author was taken from the client';
  end if;
end;
$$;
select portal_test.expect_denied($q$
  insert into public.portal_comparisons (project_id, device_id, experiment_id, question, definition, author_label)
  values ('22222222-2222-4222-8222-222222222222', 'portal-product-test-controller', '77777777-0000-4000-8000-000000000001', 'About a hidden trial?', '{}', 'x')
$q$, 'a comparison about an experiment the researcher cannot see');
select portal_test.expect_denied($q$
  insert into public.portal_comparisons (project_id, device_id, question, definition, author_label)
  values ('22222222-2222-4222-8222-222222222222', 'portal-product-other-controller', 'Wrong controller?', '{}', 'x')
$q$, 'a comparison on another project''s controller');
select portal_test.expect_denied($q$
  update public.portal_comparisons set device_id = 'portal-product-other-controller' where id = '88888888-0000-4000-8000-000000000001'
$q$, 'moving a comparison to another controller');
update public.portal_comparisons set question = 'Did pot 1 dry faster than pot 2 last night?', sharing = 'private'
where id = '88888888-0000-4000-8000-000000000001';

insert into public.portal_comparison_exclusions (id, comparison_id, project_id, pairing_name, starts_at, ends_at, reason, author_label)
values ('99990000-0000-4000-8000-000000000001', '88888888-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222',
        'Zone1-Pot1', now() - interval '60 minutes', now() - interval '30 minutes', 'Sensor reseated; readings unreliable', 'spoofed');
-- The aggregate leaves out exactly the readings in scope (pot 1 at even minutes 32–60: 15 readings).
do $$
declare
  kept integer;
  dropped integer;
  ranges jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object('pairing_name', pairing_name, 'starts_at', starts_at, 'ends_at', ends_at)), '[]'::jsonb)
  into ranges from public.portal_comparison_exclusions
  where comparison_id = '88888888-0000-4000-8000-000000000001' and revoked_at is null;
  select sum(readings), sum(excluded) into kept, dropped
  from public.portal_reading_buckets('22222222-2222-4222-8222-222222222222', 'portal-product-test-controller',
    array['Zone1-Pot1', 'Zone1-Pot2'], now() - interval '3 hours', now(), 3600, ranges);
  if kept <> 105 or dropped <> 15 then
    raise exception 'Exclusions were not applied exactly (kept %, excluded %)', kept, dropped;
  end if;
  if (select sum(openings) from public.portal_valve_open_buckets('22222222-2222-4222-8222-222222222222', 'portal-product-test-controller',
        array['Zone1-Pot1'], now() - interval '3 hours', now(), 3600)) <> 1 then
    raise exception 'Valve openings were not counted';
  end if;
end;
$$;
do $$
begin
  -- Readings run until now; a window reaching three hours past now ends in one ongoing gap per pot.
  if (select count(*) from public.portal_reading_gaps('22222222-2222-4222-8222-222222222222', 'portal-product-test-controller',
        array['Zone1-Pot1', 'Zone1-Pot2'], now() - interval '3 hours', now() + interval '3 hours', 3600, 2) where ongoing) <> 2 then
    raise exception 'Gaps in readings were not found';
  end if;
end;
$$;
select portal_test.expect_denied($q$
  select * from public.portal_reading_buckets('22222222-2222-4222-8222-222222222222', 'portal-product-test-controller',
    array['Zone1-Pot1'], now() - interval '200 days', now(), 3600, '[]'::jsonb)
$q$, 'an unbounded history request');
select portal_test.expect_denied($q$
  update public.portal_comparison_exclusions set reason = 'changed my mind' where id = '99990000-0000-4000-8000-000000000001'
$q$, 'editing an exclusion');
select portal_test.expect_denied($q$
  delete from public.portal_comparison_exclusions where id = '99990000-0000-4000-8000-000000000001'
$q$, 'deleting an exclusion');
update public.portal_comparison_exclusions set revoke_reason = 'The reseat did not affect readings.'
where id = '99990000-0000-4000-8000-000000000001';
do $$
begin
  if not exists (
    select 1 from public.portal_comparison_exclusions
    where id = '99990000-0000-4000-8000-000000000001' and revoked_at is not null
      and revoked_by = (select id from portal_test.users where label = 'researcher')
      and reason = 'Sensor reseated; readings unreliable'
  ) then
    raise exception 'Revoking did not keep the original exclusion with who revoked it';
  end if;
end;
$$;
select portal_test.expect_denied($q$
  update public.portal_comparison_exclusions set revoke_reason = 'again' where id = '99990000-0000-4000-8000-000000000001'
$q$, 'revoking an exclusion twice');

-- Admins see shared comparisons, not private ones, and cannot change someone else's.
select portal_test.act_as('admin');
do $$
begin
  if exists (select 1 from public.portal_comparisons where id = '88888888-0000-4000-8000-000000000001') then
    raise exception 'A private comparison is visible to another member';
  end if;
  if not exists (select 1 from public.portal_comparisons where id = '88888888-0000-4000-8000-000000000002') then
    raise exception 'A shared comparison is not visible to another member';
  end if;
  if (select count(*) from public.portal_comparison_exclusions) <> 0 then
    raise exception 'Exclusions on a private comparison are visible to another member';
  end if;
end;
$$;
update public.portal_comparisons set question = 'Hijacked?' where id = '88888888-0000-4000-8000-000000000002';
select portal_test.expect_denied($q$
  insert into public.portal_comparison_exclusions (comparison_id, project_id, reason, author_label)
  values ('88888888-0000-4000-8000-000000000002', '22222222-2222-4222-8222-222222222222', 'Not my comparison', 'x')
$q$, 'adding an exclusion to someone else''s comparison');
reset role;
do $$
begin
  if (select question from public.portal_comparisons where id = '88888888-0000-4000-8000-000000000002') <> 'Are the two pots alike?' then
    raise exception 'Another member changed a shared comparison';
  end if;
end;
$$;

-- Viewers cannot see experiments, so they see no comparison about one, and cannot save any.
select portal_test.act_as('viewer');
do $$
begin
  if exists (select 1 from public.portal_comparisons) then
    raise exception 'A viewer can read a comparison about an experiment hidden from viewers';
  end if;
end;
$$;
select portal_test.expect_denied($q$
  insert into public.portal_comparisons (project_id, device_id, question, definition, author_label)
  values ('22222222-2222-4222-8222-222222222222', 'portal-product-test-controller', 'Viewer question?', '{}', 'x')
$q$, 'a viewer saving a comparison');

-- Another project's account sees none of it, and aggregates nothing from this project.
select portal_test.act_as('other');
do $$
begin
  if exists (select 1 from public.portal_comparisons) or exists (select 1 from public.portal_comparison_exclusions) then
    raise exception 'Another project''s account can read greenhouse comparisons';
  end if;
  if exists (select 1 from public.portal_reading_buckets('22222222-2222-4222-8222-222222222222', 'portal-product-test-controller',
        array['Zone1-Pot1', 'Zone1-Pot2'], now() - interval '3 hours', now(), 3600, '[]'::jsonb)) then
    raise exception 'Another project''s account can aggregate greenhouse readings';
  end if;
  if exists (select 1 from public.portal_valve_open_buckets('22222222-2222-4222-8222-222222222222', 'portal-product-test-controller',
        array['Zone1-Pot1'], now() - interval '3 hours', now(), 3600)) then
    raise exception 'Another project''s account can count greenhouse valve openings';
  end if;
  if exists (select 1 from public.portal_reading_gaps('22222222-2222-4222-8222-222222222222', 'portal-product-test-controller',
        array['Zone1-Pot1', 'Zone1-Pot2'], now() - interval '6 hours', now() + interval '3 hours', 3600, 1)) then
    raise exception 'Another project''s account can see gaps in greenhouse readings';
  end if;
end;
$$;

-- ---------------------------------------------------------------- since you last looked

select portal_test.act_as('researcher');
insert into public.portal_experiment_views (user_id, project_id, experiment_id, last_seen_at)
values ((select id from portal_test.users where label = 'admin'), '22222222-2222-4222-8222-222222222222',
        '77777777-0000-4000-8000-000000000002', now() + interval '1 day');
do $$
begin
  if not exists (
    select 1 from public.portal_experiment_views
    where user_id = (select id from portal_test.users where label = 'researcher') and last_seen_at <= now()
  ) then
    raise exception 'A view mark was written for someone else or in the future';
  end if;
end;
$$;
update public.portal_experiment_views set last_seen_at = now() - interval '5 days'
where experiment_id = '77777777-0000-4000-8000-000000000002';
do $$
begin
  if (select last_seen_at from public.portal_experiment_views where experiment_id = '77777777-0000-4000-8000-000000000002') < now() then
    raise exception 'A view mark moved backwards';
  end if;
end;
$$;
select portal_test.act_as('admin');
do $$
begin
  if exists (select 1 from public.portal_experiment_views) then
    raise exception 'One member can read another member''s view marks';
  end if;
end;
$$;

rollback;
