alter table public.device_health_snapshots
  add column if not exists raw_health jsonb not null default '{}'::jsonb;
