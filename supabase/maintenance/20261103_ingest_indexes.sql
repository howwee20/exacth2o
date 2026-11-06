CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS sensor_readings_device_event_key ON public.sensor_readings(device_id,event_id);
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS valve_events_device_event_key ON public.valve_events(device_id,event_id);
