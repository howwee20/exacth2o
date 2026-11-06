-- Run only in the disposable database populated by verify-database-baseline.sh.
begin;
create schema lease_test;
create table lease_test.ids(label text primary key, id uuid not null);
insert into lease_test.ids values
  ('researcher_a', gen_random_uuid()), ('researcher_b', gen_random_uuid()),
  ('viewer', gen_random_uuid()), ('outsider', gen_random_uuid()),
  ('token_a', gen_random_uuid()), ('token_b', gen_random_uuid());
insert into auth.users(id, email)
select id, label || '@lease-test.invalid' from lease_test.ids where label not like 'token_%';
insert into public.portal_access(project_id, user_id, email, role, access_scope)
select '22222222-2222-4222-8222-222222222222', id, label || '@lease-test.invalid',
  case when label = 'viewer' then 'viewer' else 'researcher' end, 'project'
from lease_test.ids where label in ('researcher_a', 'researcher_b', 'viewer');
grant usage on schema lease_test to authenticated;
grant select on lease_test.ids to authenticated;

create function lease_test.rejected(statement text, expected text) returns void language plpgsql as $$
begin
  begin execute statement; exception when others then
    if sqlerrm not ilike '%' || expected || '%' then raise; end if;
    return;
  end;
  raise exception 'Expected rejection: %', statement;
end;
$$;
grant execute on function lease_test.rejected(text, text) to authenticated;

-- The raw token is never available through a table read, insert or update.
do $$
begin
  if has_column_privilege('authenticated', 'public.commissioning_sessions', 'run_token', 'SELECT')
     or has_column_privilege('authenticated', 'public.commissioning_sessions', 'run_token', 'INSERT')
     or has_column_privilege('authenticated', 'public.commissioning_sessions', 'run_token', 'UPDATE') then
    raise exception 'Run token capability exposed';
  end if;
  if has_table_privilege('anon', 'public.commissioning_sessions', 'SELECT') then
    raise exception 'Anonymous session access exposed';
  end if;
end;
$$;

select set_config('request.jwt.claims', json_build_object('sub', (select id from lease_test.ids where label = 'researcher_a'), 'role', 'authenticated')::text, true);
select set_config('request.jwt.claim.sub', (select id::text from lease_test.ids where label = 'researcher_a'), true);
set local role authenticated;
insert into public.commissioning_sessions(project_id, device_id, run_id, pot_count, original_snapshot)
values ('22222222-2222-4222-8222-222222222222', 'lease-test-device', 'lease-test-run-1', 2, '[]');
select public.save_commissioning_session('22222222-2222-4222-8222-222222222222', 'lease-test-device', 'lease-test-run-1', '{"status":"prepared","record":{"step":"ready"}}');
select public.claim_commissioning_run('22222222-2222-4222-8222-222222222222', 'lease-test-device', 'lease-test-run-1',
  (select id from lease_test.ids where label = 'token_a'), lease_protocol => 2);
select lease_test.rejected(format($q$select public.claim_commissioning_run('22222222-2222-4222-8222-222222222222','lease-test-device','lease-test-run-1',%L)$q$,
  (select id from lease_test.ids where label = 'token_a')), 'Reload the portal');
-- A second tab using the same account still needs the private token.
select lease_test.rejected(format($q$select public.claim_commissioning_run('22222222-2222-4222-8222-222222222222','lease-test-device','lease-test-run-1',%L,lease_protocol => 2)$q$,
  (select id from lease_test.ids where label = 'token_b')), 'Another screen');
select lease_test.rejected($q$select run_token from public.commissioning_sessions$q$, 'permission denied');
select lease_test.rejected($q$select public.save_commissioning_session('22222222-2222-4222-8222-222222222222','lease-test-device','lease-test-run-1','{"status":"interrupted"}')$q$, 'Another screen');
reset role;

select set_config('request.jwt.claims', json_build_object('sub', (select id from lease_test.ids where label = 'researcher_b'), 'role', 'authenticated')::text, true);
select set_config('request.jwt.claim.sub', (select id::text from lease_test.ids where label = 'researcher_b'), true);
set local role authenticated;
do $$
declare saved public.commissioning_sessions;
begin
  -- Original three bypasses and direct replacement are denied at the same boundary.
  perform lease_test.rejected($q$update public.commissioning_sessions set run_token = null where run_id = 'lease-test-run-1'$q$, 'permission denied');
  perform lease_test.rejected($q$update public.commissioning_sessions set heartbeat_at = null where run_id = 'lease-test-run-1'$q$, 'permission denied');
  perform lease_test.rejected($q$update public.commissioning_sessions set status = 'interrupted' where run_id = 'lease-test-run-1'$q$, 'permission denied');
  perform lease_test.rejected(format($q$update public.commissioning_sessions set run_token = %L where run_id = 'lease-test-run-1'$q$, (select id from lease_test.ids where label = 'token_b')), 'permission denied');
  perform lease_test.rejected($q$update public.commissioning_sessions set active = false where run_id = 'lease-test-run-1'$q$, 'permission denied');
  perform lease_test.rejected($q$select public.save_commissioning_session('22222222-2222-4222-8222-222222222222','lease-test-device','lease-test-run-1','{"run_token":null,"heartbeat_at":null}')$q$, 'Another screen');
  perform lease_test.rejected(format($q$select public.claim_commissioning_run('22222222-2222-4222-8222-222222222222','lease-test-device','lease-test-run-1',%L,0,2)$q$, (select id from lease_test.ids where label = 'token_b')), 'Another screen');
  saved := public.save_commissioning_session('22222222-2222-4222-8222-222222222222','lease-test-device','lease-test-run-1','{"record":{"step":"wrong owner"}}', (select id from lease_test.ids where label = 'token_b'));
  if saved.id is not null then raise exception 'Wrong token saved a record'; end if;
  perform lease_test.rejected(format($q$select public.renew_commissioning_run('22222222-2222-4222-8222-222222222222','lease-test-device','lease-test-run-1',%L)$q$, (select id from lease_test.ids where label = 'token_b')), 'no longer holds');
  -- Stop remains available and is stamped by the database.
  update public.commissioning_sessions set stop_requested_at = '2000-01-01' where run_id = 'lease-test-run-1';
  if not found then raise exception 'Stop request refused'; end if;
end;
$$;
reset role;

-- The holder can checkpoint, see the stop, and release after completion or error.
select set_config('request.jwt.claims', json_build_object('sub', (select id from lease_test.ids where label = 'researcher_a'), 'role', 'authenticated')::text, true);
select set_config('request.jwt.claim.sub', (select id::text from lease_test.ids where label = 'researcher_a'), true);
set local role authenticated;
do $$
declare saved public.commissioning_sessions; lease jsonb; token uuid := (select id from lease_test.ids where label = 'token_a');
begin
  lease := public.renew_commissioning_run('22222222-2222-4222-8222-222222222222','lease-test-device','lease-test-run-1',token);
  if (lease->>'stop_requested_at')::timestamptz < now() - interval '1 minute'
     or (lease->>'stop_requested_by')::uuid is distinct from (select id from lease_test.ids where label = 'researcher_b') then
    raise exception 'Stop signal lost';
  end if;
  saved := public.save_commissioning_session('22222222-2222-4222-8222-222222222222','lease-test-device','lease-test-run-1','{"record":{"step":"checkpoint"}}',token);
  if saved.record->>'step' <> 'checkpoint' then raise exception 'Holder checkpoint failed'; end if;
  perform lease_test.rejected(format($q$select public.save_commissioning_session('22222222-2222-4222-8222-222222222222','lease-test-device','lease-test-run-1','{"original_snapshot":[]}',%L)$q$,token), 'Invalid autocalibration');
  perform lease_test.rejected(format($q$select public.save_commissioning_session('22222222-2222-4222-8222-222222222222','lease-test-device','lease-test-run-1','{"heartbeat_at":null}',%L)$q$,token), 'Release the run token');
  saved := public.save_commissioning_session('22222222-2222-4222-8222-222222222222','lease-test-device','lease-test-run-1','{"status":"interrupted","run_token":null,"heartbeat_at":null}',token);
  if saved.run_token is not null or saved.heartbeat_at is not null then raise exception 'Holder release failed'; end if;
  saved := public.save_commissioning_session('22222222-2222-4222-8222-222222222222','lease-test-device','lease-test-run-1','{"status":"prepared"}');
  if saved.status <> 'prepared' then raise exception 'Between-run edit failed'; end if;
  perform public.claim_commissioning_run('22222222-2222-4222-8222-222222222222','lease-test-device','lease-test-run-1',token,lease_protocol => 2);
end;
$$;
reset role;

-- Database-fixture aging proves recovery without sleeping or touching a controller.
set local session_replication_role = replica;
update public.commissioning_sessions set heartbeat_at = now() - interval '10 minutes' where run_id = 'lease-test-run-1';
set local session_replication_role = origin;
select set_config('request.jwt.claims', json_build_object('sub', (select id from lease_test.ids where label = 'researcher_b'), 'role', 'authenticated')::text, true);
select set_config('request.jwt.claim.sub', (select id::text from lease_test.ids where label = 'researcher_b'), true);
set local role authenticated;
do $$
declare saved public.commissioning_sessions; token uuid := (select id from lease_test.ids where label = 'token_b');
begin
  saved := public.save_commissioning_session('22222222-2222-4222-8222-222222222222','lease-test-device','lease-test-run-1','{"status":"restoring"}');
  if saved.status <> 'restoring' or saved.run_token is not null then raise exception 'Stale restore without running failed'; end if;
  saved := public.claim_commissioning_run('22222222-2222-4222-8222-222222222222','lease-test-device','lease-test-run-1',token,lease_protocol => 2);
  if saved.run_token <> token then raise exception 'Stale takeover failed'; end if;
  saved := public.save_commissioning_session('22222222-2222-4222-8222-222222222222','lease-test-device','lease-test-run-1','{"status":"analyzed","run_result":{"evidence":[]},"run_token":null,"heartbeat_at":null}',token);
  if saved.status <> 'analyzed' then raise exception 'Completion save failed'; end if;
end;
$$;
reset role;

-- All SECURITY DEFINER entrypoints retain the project/role boundary.
do $$
declare actor_label text;
begin
  foreach actor_label in array array['viewer', 'outsider'] loop
    perform set_config('request.jwt.claims', json_build_object('sub', (select id from lease_test.ids where ids.label = actor_label), 'role', 'authenticated')::text, true);
    perform set_config('request.jwt.claim.sub', (select id::text from lease_test.ids where ids.label = actor_label), true);
    set local role authenticated;
    perform lease_test.rejected(format($q$select public.claim_commissioning_run('22222222-2222-4222-8222-222222222222','lease-test-device','lease-test-run-1',%L,lease_protocol => 2)$q$, (select id from lease_test.ids where ids.label = 'token_a')), 'Project operator access');
    perform lease_test.rejected(format($q$select public.renew_commissioning_run('22222222-2222-4222-8222-222222222222','lease-test-device','lease-test-run-1',%L)$q$, (select id from lease_test.ids where ids.label = 'token_a')), 'Project operator access');
    perform lease_test.rejected($q$select public.save_commissioning_session('22222222-2222-4222-8222-222222222222','lease-test-device','lease-test-run-1','{}')$q$, 'Project operator access');
    reset role;
  end loop;
end;
$$;
rollback;
