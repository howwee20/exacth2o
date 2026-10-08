-- The controller stopped reporting 95 minutes ago: presence lapses and no pot reports after it.
\ir scenario-normal.sql
insert into product_local.hidden_readings
select * from public.sensor_readings
where project_id = '22222222-2222-4222-8222-222222222222' and device_recorded_at > now() - interval '95 minutes';
delete from public.sensor_readings r using product_local.hidden_readings h where r.event_id = h.event_id;
update public.device_runtime_state
set state_observed_at = now() - interval '95 minutes', state_fresh_until = now() - interval '85 minutes', updated_at = now()
where project_id = '22222222-2222-4222-8222-222222222222';
update public.latest_device_state set last_seen_at = now() - interval '95 minutes' where project_id = '22222222-2222-4222-8222-222222222222';
