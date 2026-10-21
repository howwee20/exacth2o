-- Disposable checks for full-scale autocalibration and hold-to-water records. Never run against a live controller.
begin;
create schema autocal_test;
create table autocal_test.ids(label text primary key, id uuid not null);
insert into autocal_test.ids values ('admin',gen_random_uuid()),('researcher',gen_random_uuid()),('viewer',gen_random_uuid()),('outsider',gen_random_uuid());
insert into auth.users(id,email) select id,label||'@autocal-test.invalid' from autocal_test.ids;
insert into public.portal_access(project_id,user_id,email,role,access_scope)
select '22222222-2222-4222-8222-222222222222',id,label||'@autocal-test.invalid',label,'project' from autocal_test.ids where label<>'outsider';

create function autocal_test.rejected(statement text, expected text) returns void language plpgsql as $$
begin
  begin execute statement; exception when others then
    if sqlerrm not ilike '%'||expected||'%' then raise exception 'Expected "%", got "%"', expected, sqlerrm; end if;
    return;
  end;
  raise exception 'Expected rejection: %', statement;
end; $$;
grant usage on schema autocal_test to authenticated;
grant execute on function autocal_test.rejected(text,text) to authenticated;

-- Researchers may remap and restore through the reviewed path; viewers may not; deletion stays admin-only.
select public.assert_portal_command_access('22222222-2222-4222-8222-222222222222',id,'remap_pairing_valves') from autocal_test.ids where label in ('admin','researcher');
select public.assert_portal_command_access('22222222-2222-4222-8222-222222222222',id,'restore_pairing_settings') from autocal_test.ids where label in ('admin','researcher');
select autocal_test.rejected(format('select public.assert_portal_command_access(%L,%L,%L)','22222222-2222-4222-8222-222222222222',id,'remap_pairing_valves'),'control access is required') from autocal_test.ids where label='viewer';
select autocal_test.rejected(format('select public.assert_portal_command_access(%L,%L,%L)','22222222-2222-4222-8222-222222222222',id,'delete_pairing'),'not permitted') from autocal_test.ids where label='researcher';
do $$ begin
  if not exists (select 1 from pg_constraint where conname='project_control_commands_command_type_check' and pg_get_constraintdef(oid) like '%remap_pairing_valves%restore_pairing_settings%') then
    raise exception 'New command types are not allowed by the table constraint';
  end if;
  if position('remap_pairing_valves' in pg_get_functiondef('public.enqueue_portal_control_command_batch(uuid,text,uuid,uuid,timestamptz,text,text,jsonb)'::regprocedure)) = 0 then
    raise exception 'Settings batches do not accept the remap command';
  end if;
end $$;

-- A device whose controller readback shows a completed remap of two pots.
insert into public.device_config_state(project_id,device_id,pairings,config_hash) values (
  '22222222-2222-4222-8222-222222222222','autocal-test-device',
  '[{"name":"Zone1-Pot1","Sensor":{"boardSerialId":"D30GQN2D","address":"p"},"Valve":{"relayAddress":"0x24","address":"2"}},
    {"name":"Zone1-Pot2","Sensor":{"boardSerialId":"D30GQN2D","address":"P"},"Valve":{"relayAddress":"0x24","address":"1"}}]','hash-after');
-- The test project may predate no site backfill: give it its primary site here.
insert into public.research_sites(organization_id,project_id,slug,name)
select organization_id,id,'primary',name from public.projects where id='22222222-2222-4222-8222-222222222222'
on conflict (project_id,slug) do nothing;
insert into public.research_pots(id,project_id,site_id,pot_number,label)
select gen_random_uuid(),'22222222-2222-4222-8222-222222222222',site.id,9000+n,'Autocal test pot '||n
from public.research_sites site, generate_series(1,2) n where site.project_id='22222222-2222-4222-8222-222222222222' and site.slug='primary';
insert into public.hardware_bindings(project_id,device_id,pot_id,pairing_name,sensor_key,valve_key,physical_status,source)
select '22222222-2222-4222-8222-222222222222','autocal-test-device',pot.id,'Zone1-Pot'||(pot.pot_number-9000),
  case pot.pot_number when 9001 then 'D30GQN2D:p' else 'D30GQN2D:P' end,
  case pot.pot_number when 9001 then '0x24:1' else '0x24:2' end,
  case pot.pot_number when 9001 then 'researcher_confirmed' else 'software_only' end,'pairing_snapshot'
from public.research_pots pot where pot.pot_number in (9001,9002);

-- Binding reconciliation: requires operator access and controller readback, keeps pot identity, resets physical status.
select set_config('request.jwt.claims',json_build_object('sub',(select id from autocal_test.ids where label='viewer'),'role','authenticated')::text,true);
select set_config('request.jwt.claim.sub',(select id::text from autocal_test.ids where label='viewer'),true);
set local role authenticated;
select autocal_test.rejected($q$select public.reconcile_autocalibration_bindings('22222222-2222-4222-8222-222222222222','autocal-test-device','run-x','[]'::jsonb)$q$,'control access');
-- Viewers can read sessions but not start them.
select autocal_test.rejected($q$insert into public.commissioning_sessions(project_id,device_id,run_id,pot_count,original_snapshot) values ('22222222-2222-4222-8222-222222222222','autocal-test-device','hw-20261021-viewer',2,'[]')$q$,'row-level security');
select autocal_test.rejected($q$insert into public.manual_hold_sessions(id,project_id,device_id,owner_id,destination_kind,relay_address,channel) values (gen_random_uuid(),'22222222-2222-4222-8222-222222222222','autocal-test-device',(select auth.uid()),'solenoid',32,1)$q$,'permission denied');
reset role;

select set_config('request.jwt.claims',json_build_object('sub',(select id from autocal_test.ids where label='researcher'),'role','authenticated')::text,true);
select set_config('request.jwt.claim.sub',(select id::text from autocal_test.ids where label='researcher'),true);
set local role authenticated;
do $$
declare result jsonb;
begin
  result := public.reconcile_autocalibration_bindings('22222222-2222-4222-8222-222222222222','autocal-test-device','hw-20261021-test',
    '[{"pairing_name":"Zone1-Pot1","sensor_key":"D30GQN2D:p","valve_key":"0x24:2"},
      {"pairing_name":"Zone1-Pot2","sensor_key":"D30GQN2D:P","valve_key":"0x24:1"},
      {"pairing_name":"Zone1-Pot3","sensor_key":"D30GQN2D:q","valve_key":"0x24:9"}]'::jsonb);
  if (result->>'reconciled')::int <> 2 then raise exception 'Expected two reconciled bindings, got %', result; end if;
  if jsonb_array_length(result->'skipped') <> 1 then raise exception 'A pot without readback must be skipped: %', result; end if;
end $$;
-- Sessions: one active per controller; original settings immutable.
insert into public.commissioning_sessions(project_id,device_id,run_id,pot_count,original_snapshot)
values ('22222222-2222-4222-8222-222222222222','autocal-test-device','hw-20261021-first',100,'[{"pairingName":"Zone1-Pot1"}]');
select autocal_test.rejected($q$insert into public.commissioning_sessions(project_id,device_id,run_id,pot_count,original_snapshot) values ('22222222-2222-4222-8222-222222222222','autocal-test-device','hw-20261021-second',2,'[]')$q$,'duplicate key');
select autocal_test.rejected($q$update public.commissioning_sessions set original_snapshot='[]' where run_id='hw-20261021-first'$q$,'cannot be changed');
update public.commissioning_sessions set status='restored', active=false where run_id='hw-20261021-first';
select autocal_test.rejected($q$update public.commissioning_sessions set active=true where run_id='hw-20261021-first'$q$,'cannot become active again');
insert into public.commissioning_sessions(project_id,device_id,run_id,pot_count,original_snapshot)
values ('22222222-2222-4222-8222-222222222222','autocal-test-device','hw-20261021-second',2,'[]');
reset role;

do $$ begin
  if (select count(*) from public.hardware_bindings where device_id='autocal-test-device' and retired_at is null) <> 2 then raise exception 'Expected exactly two active bindings'; end if;
  if exists (select 1 from public.hardware_bindings where device_id='autocal-test-device' and retired_at is null and (physical_status<>'software_only' or source<>'autocalibration')) then
    raise exception 'Remapped bindings must be software-only autocalibration records';
  end if;
  if (select valve_key from public.hardware_bindings where device_id='autocal-test-device' and pairing_name='Zone1-Pot1' and retired_at is null) <> '0x24:2' then raise exception 'Pot 1 binding was not moved'; end if;
  if (select metadata->>'previous_physical_status' from public.hardware_bindings where device_id='autocal-test-device' and pairing_name='Zone1-Pot1' and retired_at is null) <> 'researcher_confirmed' then
    raise exception 'The previous confirmation must be retained as history';
  end if;
  if (select count(distinct pot_id) from public.hardware_bindings where device_id='autocal-test-device') <> 2 then raise exception 'Pot identity changed'; end if;
  if not exists (select 1 from public.project_control_audit where device_id='autocal-test-device' and action='autocalibration_bindings') then raise exception 'Reconciliation was not audited'; end if;
end $$;

-- Run ownership: one screen holds a run segment; renewals need its token; a fresh
-- heartbeat blocks a second screen; a stop request is stamped by the database.
select set_config('request.jwt.claims',json_build_object('sub',(select id from autocal_test.ids where label='researcher'),'role','authenticated')::text,true);
select set_config('request.jwt.claim.sub',(select id::text from autocal_test.ids where label='researcher'),true);
insert into autocal_test.ids values ('first-screen',gen_random_uuid()),('second-screen',gen_random_uuid());
grant select on autocal_test.ids to authenticated;
set local role authenticated;
do $$
declare
  first_token uuid := (select id from autocal_test.ids where label='first-screen');
  second_token uuid := (select id from autocal_test.ids where label='second-screen');
  claimed public.commissioning_sessions;
  lease jsonb;
begin
  claimed := public.claim_commissioning_run('22222222-2222-4222-8222-222222222222','autocal-test-device','hw-20261021-second',first_token);
  if claimed.status <> 'running' or claimed.run_token <> first_token or claimed.heartbeat_at is null then raise exception 'Claim did not take the session'; end if;
  lease := public.renew_commissioning_run('22222222-2222-4222-8222-222222222222','autocal-test-device','hw-20261021-second',first_token);
  if lease->>'stop_requested_at' is not null then raise exception 'No stop was requested yet: %', lease; end if;
  begin
    perform public.claim_commissioning_run('22222222-2222-4222-8222-222222222222','autocal-test-device','hw-20261021-second',second_token);
    raise exception 'second claim accepted';
  exception when others then
    if sqlerrm not ilike '%Another screen%' then raise exception 'A second screen must not take a run with a fresh heartbeat (%)', sqlerrm; end if;
  end;
  -- A browser's clock never sets the times.
  update public.commissioning_sessions set stop_requested_at='2000-01-01', heartbeat_at='2000-01-01' where run_id='hw-20261021-second';
  lease := public.renew_commissioning_run('22222222-2222-4222-8222-222222222222','autocal-test-device','hw-20261021-second',first_token);
  if (lease->>'stop_requested_at')::timestamptz < now() - interval '1 minute' or (lease->>'heartbeat_at')::timestamptz < now() - interval '1 minute' then
    raise exception 'Stop and heartbeat times must come from the database clock: %', lease;
  end if;
  if (lease->>'stop_requested_by')::uuid is distinct from (select auth.uid()) then raise exception 'The stop request must record who asked'; end if;
  -- The evidence matrix is an object, saved apart from the record.
  update public.commissioning_sessions set run_result='{"proposals":[],"evidence":[]}' where run_id='hw-20261021-second';
  perform autocal_test.rejected($q$update public.commissioning_sessions set run_result='[]' where run_id='hw-20261021-second'$q$,'check constraint');
end $$;
reset role;
-- The first screen goes quiet (simulated without the trigger, which would stamp now()).
set local session_replication_role = replica;
update public.commissioning_sessions set heartbeat_at = now() - interval '10 minutes' where run_id='hw-20261021-second';
set local session_replication_role = origin;
set local role authenticated;
do $$
declare
  first_token uuid := (select id from autocal_test.ids where label='first-screen');
  second_token uuid := (select id from autocal_test.ids where label='second-screen');
  claimed public.commissioning_sessions;
  touched integer;
begin
  claimed := public.claim_commissioning_run('22222222-2222-4222-8222-222222222222','autocal-test-device','hw-20261021-second',second_token);
  if claimed.run_token <> second_token or claimed.stop_requested_at is not null then raise exception 'A stale run must pass to the new screen with its stop request cleared'; end if;
  begin
    perform public.renew_commissioning_run('22222222-2222-4222-8222-222222222222','autocal-test-device','hw-20261021-second',first_token);
    raise exception 'old screen renewed';
  exception when others then
    if sqlerrm not ilike '%no longer holds%' then raise exception 'The first screen must learn it lost the run (%)', sqlerrm; end if;
  end;
  update public.commissioning_sessions set status='interrupted' where run_id='hw-20261021-second' and run_token=first_token;
  get diagnostics touched = row_count;
  if touched <> 0 then raise exception 'A screen that lost the run must not save over it'; end if;
end $$;
reset role;

-- Bench confirmation: the last of the four facts, versioned, never for wiring the controller no longer reports.
select set_config('request.jwt.claims',json_build_object('sub',(select id from autocal_test.ids where label='viewer'),'role','authenticated')::text,true);
select set_config('request.jwt.claim.sub',(select id::text from autocal_test.ids where label='viewer'),true);
set local role authenticated;
select autocal_test.rejected($q$select public.confirm_autocalibration_delivery('22222222-2222-4222-8222-222222222222','autocal-test-device','hw-20261021-test',array['Zone1-Pot1'])$q$,'control access');
reset role;
select set_config('request.jwt.claims',json_build_object('sub',(select id from autocal_test.ids where label='researcher'),'role','authenticated')::text,true);
select set_config('request.jwt.claim.sub',(select id::text from autocal_test.ids where label='researcher'),true);
set local role authenticated;
do $$
declare result jsonb;
begin
  result := public.confirm_autocalibration_delivery('22222222-2222-4222-8222-222222222222','autocal-test-device','hw-20261021-test',array['Zone1-Pot1','Zone1-Pot3'],'Watched at the bench');
  if (result->>'confirmed')::int <> 1 or jsonb_array_length(result->'skipped') <> 1 then raise exception 'Expected one confirmation and one skip: %', result; end if;
  result := public.confirm_autocalibration_delivery('22222222-2222-4222-8222-222222222222','autocal-test-device','hw-20261021-test',array['Zone1-Pot1']);
  if (result->>'confirmed')::int <> 0 then raise exception 'A confirmed binding must not be confirmed again: %', result; end if;
  perform autocal_test.rejected($q$select public.confirm_autocalibration_delivery('22222222-2222-4222-8222-222222222222','autocal-test-device','hw-20261021-test',array[]::text[])$q$,'between 1 and 200');
end $$;
reset role;
do $$ begin
  if (select physical_status||'/'||source from public.hardware_bindings where device_id='autocal-test-device' and pairing_name='Zone1-Pot1' and retired_at is null) <> 'researcher_confirmed/researcher_confirmed' then
    raise exception 'Pot 1 should now carry a researcher confirmation';
  end if;
  if (select count(*) from public.hardware_bindings where device_id='autocal-test-device' and pairing_name='Zone1-Pot1') <> 3 then raise exception 'Bindings must be versioned, not edited in place'; end if;
  if (select valve_key from public.hardware_bindings where device_id='autocal-test-device' and pairing_name='Zone1-Pot1' and retired_at is null) <> '0x24:2' then raise exception 'Confirmation must keep the verified valve'; end if;
  if not exists (select 1 from public.project_control_audit where device_id='autocal-test-device' and action='autocalibration_delivery_confirmed') then raise exception 'Bench confirmation was not audited'; end if;
end $$;
rollback;
