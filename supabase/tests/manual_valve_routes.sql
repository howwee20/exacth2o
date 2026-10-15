-- Disposable checks for admin-confirmed valve routes. Never run against a live controller.
begin;
create schema route_test;
create table route_test.ids(label text primary key, id uuid not null);
insert into route_test.ids values ('admin',gen_random_uuid()),('researcher',gen_random_uuid());
insert into auth.users(id,email) select id,label||'@route-test.invalid' from route_test.ids;
insert into public.portal_access(project_id,user_id,email,role,access_scope)
select '22222222-2222-4222-8222-222222222222',id,label||'@route-test.invalid',label,'project' from route_test.ids;
insert into public.device_config_state(project_id,device_id,board_config,pairings) values (
  '22222222-2222-4222-8222-222222222222','route-test-device',
  '[{"address":32,"resetPin":16},{"address":36,"resetPin":16}]',
  '[{"name":"Zone3-Pot18","Valve":{"address":"18","relayAddress":"0x24"}},{"name":"Zone2-Pot49","Valve":{"address":"1","relayAddress":"0x20"}}]');

create function route_test.rejected(statement text, expected text) returns void language plpgsql as $$
begin
  begin execute statement; exception when others then
    if sqlerrm not ilike '%'||expected||'%' then raise exception 'Expected "%", got "%"', expected, sqlerrm; end if;
    return;
  end;
  raise exception 'Expected rejection: %', statement;
end; $$;

create function route_test.confirm(actor_label text, pot integer, relay integer, chan integer) returns text language sql as $$
  select format('select public.confirm_manual_valve_route(%L,%L,%L,%s,%s,%s)',
    '22222222-2222-4222-8222-222222222222','route-test-device',(select id from route_test.ids where label=actor_label),pot,relay,chan)
$$;

-- Only project admins confirm routes.
select route_test.rejected(route_test.confirm('researcher',5,32,5),'admin access');
-- An admin confirms an unpaired pot on a free channel of a configured board.
select public.confirm_manual_valve_route('22222222-2222-4222-8222-222222222222','route-test-device',(select id from route_test.ids where label='admin'),5,32,5,'Traced tubing on bench 1');
-- Paired pots keep their pairing; pairing valves and confirmed valves are never shared.
select route_test.rejected(route_test.confirm('admin',18,32,6),'is paired as Zone3-Pot18');
select route_test.rejected(route_test.confirm('admin',6,36,18),'already used by Zone3-Pot18');
select route_test.rejected(route_test.confirm('admin',7,32,1),'already used by Zone2-Pot49');
select route_test.rejected(route_test.confirm('admin',7,32,5),'already confirmed for pot 5');
-- Unconfigured board, out-of-range channel and pot are refused.
select route_test.rejected(route_test.confirm('admin',7,38,5),'not configured');
select route_test.rejected(route_test.confirm('admin',7,32,49),'between 1 and 48');
select route_test.rejected(route_test.confirm('admin',101,32,7),'between 1 and 100');
-- Re-confirming a pot moves its route; every change is audited.
select public.confirm_manual_valve_route('22222222-2222-4222-8222-222222222222','route-test-device',(select id from route_test.ids where label='admin'),5,32,6);
do $$ begin
  if (select channel from public.manual_valve_routes where device_id='route-test-device' and pot_number=5)<>6 then raise exception 'Route was not updated'; end if;
  if (select count(*) from public.project_control_audit where device_id='route-test-device' and action='manual_route_confirm')<>2 then raise exception 'Route confirmations were not audited'; end if;
end $$;
select route_test.rejected(format('select public.remove_manual_valve_route(%L,%L,%L,5)','22222222-2222-4222-8222-222222222222','route-test-device',(select id from route_test.ids where label='researcher')),'admin access');
do $$ begin
  if not public.remove_manual_valve_route('22222222-2222-4222-8222-222222222222','route-test-device',(select id from route_test.ids where label='admin'),5) then raise exception 'Route was not removed'; end if;
  if (select count(*) from public.project_control_audit where device_id='route-test-device' and action='manual_route_remove')<>1 then raise exception 'Route removal was not audited'; end if;
end $$;
-- Browsers cannot read or write routes or call the functions directly.
do $$ begin
  if has_table_privilege('authenticated','public.manual_valve_routes','select') or has_table_privilege('anon','public.manual_valve_routes','select') then raise exception 'Routes are readable by clients'; end if;
  if has_function_privilege('authenticated','public.confirm_manual_valve_route(uuid,text,uuid,integer,integer,integer,text)','execute') then raise exception 'Clients can confirm routes'; end if;
end $$;
rollback;
