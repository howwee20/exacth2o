-- Allow server-side portal invite repair and acceptance to create the protected
-- profile and membership rows that RLS uses for portal data access.
grant usage on schema public to service_role;

grant select, insert, update on table public.profiles to service_role;
grant select, insert, update on table public.project_members to service_role;

grant select on table public.pairings to service_role;
grant select on table public.sensor_readings to service_role;
grant select on table public.latest_device_state to service_role;
