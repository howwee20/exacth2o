begin;
do $$
declare org uuid; proj uuid := '22222222-2222-4222-8222-222222222222'; result jsonb; n int;
begin
 select organization_id into org from public.projects where id=proj;
 insert into public.devices(id,organization_id,project_id,name) values ('identity-test-a',org,proj,'test'),('identity-test-b',org,proj,'test');
 insert into public.device_secrets(device_id,token_hash) values ('identity-test-a',encode(extensions.digest('token-a','sha256'),'hex')),('identity-test-b',encode(extensions.digest('token-b','sha256'),'hex'));
 result:=public.device_ingest('token-a','{"device_id":"identity-test-a","events":[{"type":"sensor_reading","event_id":"same-local-id","recorded_at":"2026-11-01T00:00:00Z","raw_value":1}]}');
 if (result->>'inserted_readings')::int<>1 then raise exception 'first insert failed';end if;
 result:=public.device_ingest('token-b','{"device_id":"identity-test-b","events":[{"type":"sensor_reading","event_id":"same-local-id","recorded_at":"2026-11-01T00:00:00Z","raw_value":2}]}');
 if (result->>'inserted_readings')::int<>1 then raise exception 'cross-device collision';end if;
 result:=public.device_ingest('token-a','{"device_id":"identity-test-a","events":[{"type":"sensor_reading","event_id":"same-local-id","recorded_at":"2026-11-01T00:00:00Z","raw_value":1}]}');
 if (result->>'duplicate_events')::int<>1 then raise exception 'retry not idempotent';end if;
 begin
 perform public.device_ingest('token-a','{"device_id":"identity-test-b","events":[]}');
 raise exception 'spoof allowed';
 exception when invalid_authorization_specification then null;
 end;
 begin
 delete from public.devices where id='identity-test-a';
 raise exception 'delete allowed';
 exception when raise_exception then if sqlerrm not like 'Research identities cannot be deleted%' then raise;end if;
 end;
 select count(*) into n from public.sensor_readings where device_id in ('identity-test-a','identity-test-b');
 if n<>2 then raise exception 'science rows lost';end if;
 if has_table_privilege('anon','public.sensor_readings','TRUNCATE') then raise exception 'truncate still allowed';end if;
end $$;
rollback;
