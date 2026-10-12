-- Disposable fixtures. Run after the October 10 read-path migration.
-- Exercise the real authenticated role, including denied installation access.
begin;
create schema perf_test;
create table perf_test.users(label text primary key,id uuid not null);
insert into perf_test.users values
 ('admin','99999999-9999-4999-8999-999999999901'),
 ('researcher','99999999-9999-4999-8999-999999999902'),
 ('nobody','99999999-9999-4999-8999-999999999903');
grant usage on schema perf_test to authenticated;
grant select on perf_test.users to authenticated;
insert into auth.users(id,email) select id,label||'@perf-test.invalid' from perf_test.users;
insert into public.profiles(id,email) select id,label||'@perf-test.invalid' from perf_test.users on conflict(id) do nothing;
insert into public.organizations(id,slug,name) values
 ('99999999-9999-4999-8999-999999999900','status-perf-test','Status performance test');
insert into public.projects(id,organization_id,slug,name) values
 ('33333333-3333-4333-8333-333333333331','99999999-9999-4999-8999-999999999900','status-test-walker','Walker fixture'),
 ('22222222-2222-4222-8222-222222222222','99999999-9999-4999-8999-999999999900','status-test-portal','Portal fixture') on conflict(id) do nothing;
insert into public.devices(id,organization_id,project_id,name) values
 ('balena:a1c4ace2b367fbee8521f1aff6a6329b','99999999-9999-4999-8999-999999999900','33333333-3333-4333-8333-333333333331','Walker fixture') on conflict(id) do nothing;
insert into public.portal_access(project_id,user_id,email,role)
 select '22222222-2222-4222-8222-222222222222',id,label||'@perf-test.invalid',label from perf_test.users where label in ('admin','researcher');
insert into public.sales_support_staff(project_id,user_id)
 select '22222222-2222-4222-8222-222222222222',id from perf_test.users where label='admin';
insert into public.project_members(project_id,user_id,role)
 select '22222222-2222-4222-8222-222222222222',id,label from perf_test.users where label in ('admin','researcher');
insert into public.system_admin_installation_access(project_id,device_id,portal_project_id,user_id)
 values ('33333333-3333-4333-8333-333333333331','balena:a1c4ace2b367fbee8521f1aff6a6329b','22222222-2222-4222-8222-222222222222','99999999-9999-4999-8999-999999999901');
insert into public.software_terms_acceptances(user_id,project_id,email,terms_version)
 select id,'22222222-2222-4222-8222-222222222222',label||'@perf-test.invalid','test' from perf_test.users where label <> 'nobody';
insert into public.support_threads(id,subject,customer_email) values ('99999999-9999-4999-8999-999999999910','Fixture','test@perf-test.invalid');
create function perf_test.act_as(label text) returns void language plpgsql as $$
declare subject uuid;
begin
 select id into subject from perf_test.users u where u.label=act_as.label;
 perform set_config('request.jwt.claim.sub',subject::text,true);
 perform set_config('request.jwt.claims',json_build_object('sub',subject,'role','authenticated')::text,true);
 execute 'set local role authenticated';
end $$;
create function perf_test.denied(statement text) returns void language plpgsql as $$
begin
 begin execute statement;
 exception when insufficient_privilege or raise_exception then return;
 end;
 raise exception 'Expected authorization refusal for %',statement;
end $$;
grant execute on all functions in schema perf_test to authenticated;

select perf_test.act_as('nobody');
do $$ begin
 if (select count(*) from public.profiles where email like '%@perf-test.invalid') <> 1 then raise exception 'Profiles leaked another identity'; end if;
 if exists(select 1 from public.project_members) then raise exception 'Memberships leaked'; end if;
 if exists(select 1 from public.software_terms_acceptances) then raise exception 'Terms leaked'; end if;
end $$;
select perf_test.denied('select public.walker_live_observation_status()');
reset role;
select perf_test.act_as('researcher');
do $$ begin
 if (select count(*) from public.project_members)<>1 then raise exception 'Own membership missing or others exposed'; end if;
 if (select count(*) from public.software_terms_acceptances)<>1 then raise exception 'Own terms missing or others exposed'; end if;
end $$;
select perf_test.denied('select public.walker_live_observation_status()');
select perf_test.denied($q$insert into public.support_notes(thread_id,author_user_id,note) values ('99999999-9999-4999-8999-999999999910','99999999-9999-4999-8999-999999999902','refuse researcher')$q$);
reset role;
select perf_test.act_as('admin');
do $$ begin
 if (select count(*) from public.software_terms_acceptances)<>2 then raise exception 'Admin terms access changed'; end if;
 if public.walker_live_observation_status()->>'freshness'<>'awaiting_publisher' then raise exception 'Empty archive freshness changed'; end if;
 if (public.walker_live_observation_status()->>'current_sensor_count')::int<>0 then raise exception 'Empty archive count changed'; end if;
end $$;
select perf_test.denied($q$select public.walker_live_observation_status('22222222-2222-4222-8222-222222222222')$q$);
insert into public.support_notes(thread_id,author_user_id,note) values ('99999999-9999-4999-8999-999999999910','99999999-9999-4999-8999-999999999901','Allowed own admin note');
select perf_test.denied($q$insert into public.support_notes(thread_id,author_user_id,note) values ('99999999-9999-4999-8999-999999999910','99999999-9999-4999-8999-999999999902','refuse spoof')$q$);
reset role;
insert into public.walker_observation_sensor_metadata(project_id,device_id,source_sensor_id,sensor_key,display_label,source_pairing_name,board_serial_id,sensor_address)
 select '33333333-3333-4333-8333-333333333331','balena:a1c4ace2b367fbee8521f1aff6a6329b',g,'test:'||g,'Sensor '||g,'Pot '||g,'TEST',g::text from generate_series(1,2)g;
insert into public.walker_live_telemetry_readings(id,project_id,device_id,source_reading_id,event_id,source_sensor_id,sensor_key,pairing_name,raw_value,calibrated_value,device_recorded_at,source_created_at) overriding system value
 values (1,'33333333-3333-4333-8333-333333333331','balena:a1c4ace2b367fbee8521f1aff6a6329b',1,'walker:a1c4ace2b367fbee8521f1aff6a6329b:live-reading:perf:1',1,'test:1','Pot 1',100,20,now()-interval '2 hours',now()-interval '2 hours');
select perf_test.act_as('admin');
do $$ begin
 if public.walker_live_observation_status()->>'freshness'<>'stale' then raise exception 'Stale freshness changed'; end if;
end $$;
reset role;
insert into public.walker_live_telemetry_readings(id,project_id,device_id,source_reading_id,event_id,source_sensor_id,sensor_key,pairing_name,raw_value,calibrated_value,device_recorded_at,source_created_at) overriding system value
 values (5,'33333333-3333-4333-8333-333333333331','balena:a1c4ace2b367fbee8521f1aff6a6329b',5,'walker:a1c4ace2b367fbee8521f1aff6a6329b:live-reading:perf:5',1,'test:1','Pot 1',100,20,now()-interval '25 minutes',now()-interval '25 minutes');
select perf_test.act_as('admin');
do $$ begin
 if public.walker_live_observation_status()->>'freshness'<>'delayed' then raise exception 'Delayed freshness changed'; end if;
end $$;
reset role;
insert into public.walker_live_telemetry_readings(id,project_id,device_id,source_reading_id,event_id,source_sensor_id,sensor_key,pairing_name,raw_value,calibrated_value,device_recorded_at,source_created_at) overriding system value
 values (2,'33333333-3333-4333-8333-333333333331','balena:a1c4ace2b367fbee8521f1aff6a6329b',2,'walker:a1c4ace2b367fbee8521f1aff6a6329b:live-reading:perf:2',1,'test:1','Pot 1',101,21,now()-interval '1 minute',now()-interval '2 minutes'),
 (3,'33333333-3333-4333-8333-333333333331','balena:a1c4ace2b367fbee8521f1aff6a6329b',3,'walker:a1c4ace2b367fbee8521f1aff6a6329b:live-reading:perf:3',1,'test:1','Pot 1',102,22,now()-interval '2 hours',now()-interval '1 minute');
select perf_test.act_as('admin');
do $$ declare s jsonb; begin
 s:=public.walker_live_observation_status();
 if s->>'overall_status'<>'scanning' or (s->>'current_sensor_count')::int<>1 or (s->>'stale_sensor_count')::int<>1 then raise exception 'Distinct current sensor count changed: %',s; end if;
 if (s->>'latest_live_reading_at')::timestamptz<>now()-interval '1 minute' then raise exception 'Independent device maximum changed'; end if;
end $$;
reset role;
insert into public.walker_live_telemetry_readings(id,project_id,device_id,source_reading_id,event_id,source_sensor_id,sensor_key,pairing_name,raw_value,calibrated_value,device_recorded_at,source_created_at) overriding system value
 values (4,'33333333-3333-4333-8333-333333333331','balena:a1c4ace2b367fbee8521f1aff6a6329b',4,'walker:a1c4ace2b367fbee8521f1aff6a6329b:live-reading:perf:4',2,'test:2','Pot 2',103,23,now()-interval '3 minutes',now());
select perf_test.act_as('admin');
do $$ begin
 if public.walker_live_observation_status()->>'overall_status'<>'operational' then raise exception 'Full current coverage changed'; end if;
end $$;
reset role;
select perf_test.denied($q$update public.walker_live_telemetry_readings set source_created_at=now()-interval '2 hours'$q$);
rollback;
