-- supabase/tests/autocalibration_manual_hold.sql). Disposable; never run against a live controller.
-- Requires the project fixture 22222222-2222-4222-8222-222222222222 that
-- scripts/verify-database-baseline.sh seeds.
begin;
create schema lease_test;
create table lease_test.ids(label text primary key, id uuid not null);
insert into lease_test.ids values
  ('researcher_a', gen_random_uuid()), ('researcher_b', gen_random_uuid()),
  ('token_a', gen_random_uuid()), ('token_b', gen_random_uuid());
insert into auth.users(id, email)
select id, label || '@lease-test.invalid' from lease_test.ids where label like 'researcher_%';
insert into public.portal_access(project_id, user_id, email, role, access_scope)
select '22222222-2222-4222-8222-222222222222', id, label || '@lease-test.invalid', 'researcher', 'project'
from lease_test.ids where label like 'researcher_%';
grant usage on schema lease_test to authenticated;
grant select on lease_test.ids to authenticated;

-- Researcher A opens a session and claims a live run segment.
select set_config('request.jwt.claims', json_build_object('sub', (select id from lease_test.ids where label = 'researcher_a'), 'role', 'authenticated')::text, true);
select set_config('request.jwt.claim.sub', (select id::text from lease_test.ids where label = 'researcher_a'), true);
set local role authenticated;
insert into public.commissioning_sessions(project_id, device_id, run_id, pot_count, original_snapshot)
values ('22222222-2222-4222-8222-222222222222', 'lease-test-device', 'lease-test-run-1', 2, '[]');
select public.claim_commissioning_run('22222222-2222-4222-8222-222222222222', 'lease-test-device', 'lease-test-run-1',
  (select id from lease_test.ids where label = 'token_a'));
reset role;

-- Researcher B cannot take the live run by patching the row directly (PostgREST PATCH path)…
select set_config('request.jwt.claims', json_build_object('sub', (select id from lease_test.ids where label = 'researcher_b'), 'role', 'authenticated')::text, true);
select set_config('request.jwt.claim.sub', (select id::text from lease_test.ids where label = 'researcher_b'), true);
set local role authenticated;
do $$
begin
  begin
    update public.commissioning_sessions
    set run_token = (select id from lease_test.ids where label = 'token_b'), status = 'running', heartbeat_at = now()
    where run_id = 'lease-test-run-1';
    raise exception 'direct takeover accepted';
  exception when lock_not_available then
    if sqlerrm not ilike '%Another screen%' then raise; end if;
  end;
  -- …but can still ask the running screen to stop (stop requests stay unrestricted).
  update public.commissioning_sessions set stop_requested_at = now() where run_id = 'lease-test-run-1';
  if not found then raise exception 'stop request was refused'; end if;
  if (select run_token from public.commissioning_sessions where run_id = 'lease-test-run-1')
       is distinct from (select id from lease_test.ids where label = 'token_a') then
    raise exception 'run token changed';
  end if;
end;
$$;
reset role;

-- Once the holder's heartbeat is stale, the takeover is allowed (as claim_commissioning_run allows it).
set local session_replication_role = replica;
update public.commissioning_sessions set heartbeat_at = now() - interval '10 minutes' where run_id = 'lease-test-run-1';
set local session_replication_role = origin;
set local role authenticated;
do $$
declare claimed public.commissioning_sessions;
begin
  claimed := public.claim_commissioning_run('22222222-2222-4222-8222-222222222222', 'lease-test-device', 'lease-test-run-1',
    (select id from lease_test.ids where label = 'token_b'));
  if claimed.run_token is distinct from (select id from lease_test.ids where label = 'token_b') then
    raise exception 'stale run was not handed over';
  end if;
end;
$$;
reset role;
rollback;
