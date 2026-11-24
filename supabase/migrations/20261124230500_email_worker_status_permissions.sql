-- The dispatcher uses these columns to filter updates to its own current lease.
grant select (id, status, attempt_count) on public.notification_outbox to service_role;
