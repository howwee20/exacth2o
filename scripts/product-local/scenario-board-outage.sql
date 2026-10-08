-- Sensor board B3 (pots 17–24 of Matt Experiment 2) stops reporting 3 hours ago; the controller
-- stays present. Readings are held aside, not deleted, so scenario-normal restores them.
\ir scenario-normal.sql
insert into product_local.hidden_readings
select * from public.sensor_readings
where project_id = '22222222-2222-4222-8222-222222222222'
  and sensor_key like 'B3:%' and device_recorded_at > now() - interval '3 hours';
delete from public.sensor_readings r using product_local.hidden_readings h where r.event_id = h.event_id;
