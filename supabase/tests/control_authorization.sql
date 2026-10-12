-- Disposable role/revocation and intake-gate regression tests. Never run against a live controller.
begin;
create schema control_auth_test;
create table control_auth_test.ids(label text primary key, id uuid not null);
insert into control_auth_test.ids values ('admin',gen_random_uuid()),('researcher',gen_random_uuid()),('viewer',gen_random_uuid());
insert into auth.users(id,email) select id,label||'@control-auth-test.invalid' from control_auth_test.ids;
insert into public.portal_access(project_id,user_id,email,role,access_scope)
select '22222222-2222-4222-8222-222222222222',id,label||'@control-auth-test.invalid',label,'project' from control_auth_test.ids;

create function control_auth_test.denied(statement text) returns void language plpgsql as $$
begin
  begin execute statement; exception when insufficient_privilege then return; end;
  raise exception 'Expected an authorization denial: %',statement;
end; $$;

-- Exact same guard is called by single enqueue, hence by the batch and v2 wrappers.
select public.assert_portal_command_access('22222222-2222-4222-8222-222222222222',id,'update_pairing') from control_auth_test.ids where label in ('admin','researcher');
select public.assert_portal_command_access('22222222-2222-4222-8222-222222222222',id,'delete_pairing') from control_auth_test.ids where label='admin';
select control_auth_test.denied(format('select public.assert_portal_command_access(%L,%L,%L)','22222222-2222-4222-8222-222222222222',id,'update_pairing')) from control_auth_test.ids where label='viewer';
select control_auth_test.denied(format('select public.assert_portal_command_access(%L,%L,%L)','22222222-2222-4222-8222-222222222222',id,'delete_pairing')) from control_auth_test.ids where label='researcher';
select control_auth_test.denied(format('select public.assert_portal_command_access(%L,%L,%L)','22222222-2222-4222-8222-222222222222',id,'initialize_sensors')) from control_auth_test.ids where label='admin';
select control_auth_test.denied(format('select public.assert_portal_command_access(%L,%L,%L)','99999999-9999-4999-8999-999999999991',id,'update_pairing')) from control_auth_test.ids where label='admin';

update public.control_command_intake_settings set enabled=false;
select control_auth_test.denied(format('select public.assert_portal_command_access(%L,%L,%L)','22222222-2222-4222-8222-222222222222',id,'update_system_state')) from control_auth_test.ids where label='admin';
update public.control_command_intake_settings set enabled=true;

-- Permission changes are consulted at enqueue time, including before idempotent replays.
delete from public.portal_access where user_id=(select id from control_auth_test.ids where label='researcher');
select control_auth_test.denied(format('select public.assert_portal_command_access(%L,%L,%L)','22222222-2222-4222-8222-222222222222',id,'update_pairing')) from control_auth_test.ids where label='researcher';
update public.portal_access set role='researcher' where user_id=(select id from control_auth_test.ids where label='admin');
select control_auth_test.denied(format('select public.assert_portal_command_access(%L,%L,%L)','22222222-2222-4222-8222-222222222222',id,'delete_pairing')) from control_auth_test.ids where label='admin';

-- A legacy membership cannot retain telemetry access after portal revocation.
insert into public.project_members(project_id,user_id,role) select '22222222-2222-4222-8222-222222222222',id,'researcher' from control_auth_test.ids where label='researcher';
select set_config('request.jwt.claim.sub',(select id::text from control_auth_test.ids where label='researcher'),true);
do $$ begin if exists(select 1 from public.member_project_ids()) then raise exception 'Revoked member retained telemetry access'; end if; end; $$;

-- Viewer reads remain available; creating a calibration study is refused by RLS.
select set_config('request.jwt.claim.sub',(select id::text from control_auth_test.ids where label='viewer'),true);
select set_config('request.jwt.claims',json_build_object('sub',(select id from control_auth_test.ids where label='viewer'),'role','authenticated')::text,true);
grant usage on schema control_auth_test to authenticated;
grant execute on function control_auth_test.denied(text) to authenticated;
set local role authenticated;
select control_auth_test.denied($q$insert into public.calibration_studies(project_id,experiment_id,name,pairing_name,sensor_key) values ('22222222-2222-4222-8222-222222222222','matt-experiment','Test','Test pot','test:sensor')$q$);
select count(*) from public.calibration_studies;
reset role;
rollback;
