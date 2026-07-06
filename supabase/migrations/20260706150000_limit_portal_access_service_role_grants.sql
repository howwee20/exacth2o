-- The invite Edge Function only needs profile and membership writes.
-- Keep data-table reads behind authenticated user RLS, not service_role.
revoke select on table public.pairings from service_role;
revoke select on table public.sensor_readings from service_role;
revoke select on table public.latest_device_state from service_role;
