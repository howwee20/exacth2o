-- Run in an isolated database after the redundant-index migration.
-- Proves the retained unique index still supports idempotent device ingestion.
begin;
insert into public.organizations(id,slug,name) values ('99999999-9999-4999-8999-999999999970','ingest-integrity-test','Ingest test');
insert into public.projects(id,organization_id,slug,name) values ('99999999-9999-4999-8999-999999999971','99999999-9999-4999-8999-999999999970','ingest-integrity-test','Ingest test');
insert into public.devices(id,organization_id,project_id,name) values ('ingest-integrity-test','99999999-9999-4999-8999-999999999970','99999999-9999-4999-8999-999999999971','Ingest test');
insert into public.device_secrets(device_id,token_hash) values ('ingest-integrity-test',encode(extensions.digest('disposable-test-token','sha256'),'hex'));
do $$
declare
 payload jsonb := '{"device_id":"ingest-integrity-test","events":[
 {"type":"sensor_reading","event_id":"ingest-integrity-test:reading:1","source_sensor_id":647,"sensor_key":"TEST:a","pairing_name":"Zone4-Pot26","recorded_at":"2026-10-10T21:00:00Z","raw_value":2417.87,"calibrated_value":22.8604,"temperature":26,"electrical_conductivity":64},
 {"type":"valve_event","event_id":"ingest-integrity-test:valve:1","source_valve_id":1610,"valve_key":"0x24:26","action":"open","duration_ms":2000,"recorded_at":"2026-10-10T21:00:05Z"}]}';
 result jsonb;
begin
 begin
  perform public.device_ingest('wrong-test-token',payload);
  raise exception 'Invalid token accepted';
 exception when invalid_authorization_specification then null;
 end;
 result:=public.device_ingest('disposable-test-token',payload);
 if (result->>'inserted_readings')::int<>1 or (result->>'inserted_valves')::int<>1 then raise exception 'First batch not persisted: %',result; end if;
 result:=public.device_ingest('disposable-test-token',payload);
 if (result->>'duplicate_events')::int<>2 or (result->>'inserted_readings')::int<>0 then raise exception 'Retry duplicated data: %',result; end if;
 if not exists(select 1 from public.sensor_readings where event_id='ingest-integrity-test:reading:1' and raw_value=2417.87 and calibrated_value=22.8604 and sensor_key='TEST:a' and source_sensor_id=647 and temperature=26 and electrical_conductivity=64 and device_recorded_at='2026-10-10T21:00:00Z') then raise exception 'Stored values differ'; end if;
 if (select count(*) from public.valve_events where event_id='ingest-integrity-test:valve:1')<>1 then raise exception 'Valve history lost or duplicated'; end if;
 if not exists(select 1 from pg_index where indexrelid='public.sensor_readings_event_id_key'::regclass and indisunique and indisvalid) then raise exception 'Event uniqueness not enforced'; end if;
end $$;
rollback;
