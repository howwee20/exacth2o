-- Disposable checks for physical pot valve routes. Never run against a live controller.
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
  '[{"name":"Zone3-Pot16","Valve":{"address":"18","relayAddress":"0x20"}}]');
-- A recorded route awaiting a physical check, as the field-record migration creates.
insert into public.manual_valve_routes(project_id,device_id,pot_number,status,relay_address,channel,source,evidence)
values ('22222222-2222-4222-8222-222222222222','route-test-device',77,'needs_confirmation',32,30,'field_record_2026-06-15','Not re-tested');

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
-- An admin confirms a pot's route; a pairing on the same valve does not block it, because
-- pairing names are research labels, not physical pot identity.
select public.confirm_manual_valve_route('22222222-2222-4222-8222-222222222222','route-test-device',(select id from route_test.ids where label='admin'),66,32,18,'Watched 0x20:18 water pot 66');
-- One confirmed pot per valve; unconfigured boards, channels and pots out of range are refused.
select route_test.rejected(route_test.confirm('admin',16,32,18),'already confirmed for pot 66');
select route_test.rejected(route_test.confirm('admin',7,38,5),'not configured');
select route_test.rejected(route_test.confirm('admin',7,32,49),'between 1 and 48');
select route_test.rejected(route_test.confirm('admin',101,32,7),'between 1 and 100');
-- Confirming a recorded route after a physical check promotes it.
select public.confirm_manual_valve_route('22222222-2222-4222-8222-222222222222','route-test-device',(select id from route_test.ids where label='admin'),77,32,30,'Watched it');
do $$ begin
  if (select status||':'||source from public.manual_valve_routes where device_id='route-test-device' and pot_number=77)<>'confirmed:admin' then raise exception 'Recorded route was not confirmed'; end if;
  if (select count(*) from public.project_control_audit where device_id='route-test-device' and action='manual_route_confirm')<>2 then raise exception 'Route confirmations were not audited'; end if;
end $$;
-- Table rules hold even for direct writes: a confirmed route needs a valve, a pot without a
-- water line has none, and two confirmed pots never share a valve.
select route_test.rejected($$insert into public.manual_valve_routes(project_id,device_id,pot_number,status,source) values ('22222222-2222-4222-8222-222222222222','route-test-device',8,'confirmed','test')$$,'check constraint');
select route_test.rejected($$insert into public.manual_valve_routes(project_id,device_id,pot_number,status,relay_address,channel,source) values ('22222222-2222-4222-8222-222222222222','route-test-device',86,'no_water_line',32,39,'test')$$,'check constraint');
select route_test.rejected($$insert into public.manual_valve_routes(project_id,device_id,pot_number,status,relay_address,channel,source) values ('22222222-2222-4222-8222-222222222222','route-test-device',9,'confirmed',32,18,'test')$$,'duplicate key');
-- Removal is admin-only and audited.
select route_test.rejected(format('select public.remove_manual_valve_route(%L,%L,%L,66)','22222222-2222-4222-8222-222222222222','route-test-device',(select id from route_test.ids where label='researcher')),'admin access');
do $$ begin
  if not public.remove_manual_valve_route('22222222-2222-4222-8222-222222222222','route-test-device',(select id from route_test.ids where label='admin'),66) then raise exception 'Route was not removed'; end if;
  if (select count(*) from public.project_control_audit where device_id='route-test-device' and action='manual_route_remove')<>1 then raise exception 'Route removal was not audited'; end if;
end $$;
-- Browsers cannot read or write routes or call the functions directly.
do $$ begin
  if has_table_privilege('authenticated','public.manual_valve_routes','select') or has_table_privilege('anon','public.manual_valve_routes','select') then raise exception 'Routes are readable by clients'; end if;
  if has_function_privilege('authenticated','public.confirm_manual_valve_route(uuid,text,uuid,integer,integer,integer,text)','execute') then raise exception 'Clients can confirm routes'; end if;
  if has_function_privilege('authenticated','public.remove_manual_valve_route(uuid,text,uuid,integer)','execute') then raise exception 'Clients can remove routes'; end if;
end $$;
rollback;
