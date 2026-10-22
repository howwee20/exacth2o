-- Without 20261022090000_experiment_lifecycle_authorization the "outsider" and "mixer" cases complete/restore the experiments; after it,
-- they are refused while project researchers/admins keep working.
-- Requires the project fixture 22222222-2222-4222-8222-222222222222 seeded by
-- scripts/verify-database-baseline.sh.
begin;
create schema lifecycle_test;
create table lifecycle_test.ids(label text primary key, id uuid not null);
insert into lifecycle_test.ids values
  ('outsider', gen_random_uuid()), ('viewer', gen_random_uuid()), ('creator', gen_random_uuid()),
  ('other_researcher', gen_random_uuid()), ('mixer', gen_random_uuid()),
  ('to_complete', gen_random_uuid()), ('to_restore', gen_random_uuid()), ('revision', gen_random_uuid());
grant usage on schema lifecycle_test to authenticated;
grant select on lifecycle_test.ids to authenticated;

create function lifecycle_test.expect_error(statement text, expected text) returns void language plpgsql as $$
begin
  begin
    execute statement;
  exception when others then
    if sqlerrm not ilike '%' || expected || '%' then
      raise exception 'Expected "%", got "%"', expected, sqlerrm;
    end if;
    return;
  end;
  raise exception 'Expected a refusal: %', statement;
end;
$$;
grant execute on function lifecycle_test.expect_error(text, text) to authenticated;

create function lifecycle_test.act_as(who text) returns void language plpgsql as $$
declare
  uid uuid := (select id from lifecycle_test.ids where label = who);
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', uid::text, true);
end;
$$;

do $$
declare
  project constant uuid := '22222222-2222-4222-8222-222222222222';
  invitation record;
begin
  insert into auth.users(id, email)
  select id, label || '@lifecycle-test.invalid' from lifecycle_test.ids
  where label in ('outsider', 'viewer', 'creator', 'other_researcher', 'mixer');
  insert into public.portal_access(project_id, user_id, email, role, access_scope)
  select project, id, label || '@lifecycle-test.invalid',
         case label when 'viewer' then 'viewer' else 'researcher' end, 'project'
  from lifecycle_test.ids where label in ('viewer', 'creator', 'other_researcher');
  -- A gas-mixer-only account (access_scope 'gas_mixer' in the chamber project).
  select * into invitation from public.create_gas_mixer_invite('mixer@lifecycle-test.invalid');
  update public.project_invites set accepted_at = now(), accepted_by = (select id from lifecycle_test.ids where label = 'mixer')
  where id = invitation.invite_id;

  insert into public.experiments(id, project_id, slug, name, mode, status, watering_state, created_by)
  values ((select id from lifecycle_test.ids where label = 'to_complete'), project,
          'lifecycle-test-complete', 'Lifecycle test complete', 'observation', 'published_sensing', 'off',
          (select id from lifecycle_test.ids where label = 'creator'));
  insert into public.experiments(id, project_id, slug, name, mode, status, watering_state, created_by, current_revision_id)
  values ((select id from lifecycle_test.ids where label = 'to_restore'), project,
          'lifecycle-test-restore', 'Lifecycle test restore', 'observation', 'archived', 'off',
          (select id from lifecycle_test.ids where label = 'creator'),
          (select id from lifecycle_test.ids where label = 'revision'));
  insert into public.experiment_revisions(id, experiment_id, project_id, version, source, spec, created_by)
  values ((select id from lifecycle_test.ids where label = 'revision'),
          (select id from lifecycle_test.ids where label = 'to_restore'), project, 1, 'manual', '{}'::jsonb,
          (select id from lifecycle_test.ids where label = 'creator'));
end;
$$;

-- Non-members (another tenant, a mixer-only account) and viewers are refused.
select lifecycle_test.act_as('outsider');
set local role authenticated;
select lifecycle_test.expect_error(format('select * from public.complete_assistant_experiment(%L, %L)',
  '22222222-2222-4222-8222-222222222222', (select id from lifecycle_test.ids where label = 'to_complete')), 'Researcher or administrator access is required');
select lifecycle_test.expect_error(format('select * from public.restore_assistant_experiment(%L, %L)',
  '22222222-2222-4222-8222-222222222222', (select id from lifecycle_test.ids where label = 'to_restore')), 'Researcher or administrator access is required');
reset role;

select lifecycle_test.act_as('mixer');
set local role authenticated;
select lifecycle_test.expect_error(format('select * from public.complete_assistant_experiment(%L, %L)',
  '22222222-2222-4222-8222-222222222222', (select id from lifecycle_test.ids where label = 'to_complete')), 'Researcher or administrator access is required');
do $$
begin
  if public.current_portal_role('44444444-4444-4444-8444-444444444441') is not null then
    raise exception 'A gas-mixer-only account has a project role';
  end if;
  begin
    insert into public.experiment_builder_requests(project_id, user_id, source, status)
    values ('44444444-4444-4444-8444-444444444441', (select id from lifecycle_test.ids where label = 'mixer'), 'manual', 'started');
    raise exception 'A gas-mixer-only account created a builder request';
  exception when insufficient_privilege then null;
  end;
end;
$$;
reset role;

select lifecycle_test.act_as('viewer');
set local role authenticated;
select lifecycle_test.expect_error(format('select * from public.complete_assistant_experiment(%L, %L)',
  '22222222-2222-4222-8222-222222222222', (select id from lifecycle_test.ids where label = 'to_complete')), 'Researcher or administrator access is required');
reset role;

-- A researcher who did not create the archived experiment cannot restore it.
select lifecycle_test.act_as('other_researcher');
set local role authenticated;
select lifecycle_test.expect_error(format('select * from public.restore_assistant_experiment(%L, %L)',
  '22222222-2222-4222-8222-222222222222', (select id from lifecycle_test.ids where label = 'to_restore')), 'Only the creator or an administrator');
reset role;

do $$
begin
  if (select status from public.experiments where id = (select id from lifecycle_test.ids where label = 'to_complete')) <> 'published_sensing'
     or (select status from public.experiments where id = (select id from lifecycle_test.ids where label = 'to_restore')) <> 'archived' then
    raise exception 'A refused caller changed experiment state';
  end if;
end;
$$;

-- Positive control: the creator (project researcher) completes and restores.
select lifecycle_test.act_as('creator');
set local role authenticated;
select * from public.complete_assistant_experiment('22222222-2222-4222-8222-222222222222', (select id from lifecycle_test.ids where label = 'to_complete'));
select * from public.restore_assistant_experiment('22222222-2222-4222-8222-222222222222', (select id from lifecycle_test.ids where label = 'to_restore'));
reset role;
do $$
begin
  if (select status from public.experiments where id = (select id from lifecycle_test.ids where label = 'to_complete')) <> 'completed'
     or (select status from public.experiments where id = (select id from lifecycle_test.ids where label = 'to_restore')) <> 'published_sensing' then
    raise exception 'Researcher lifecycle actions stopped working';
  end if;
end;
$$;
rollback;
