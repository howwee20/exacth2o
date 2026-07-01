create table if not exists public.quote_requests (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  name text not null check (char_length(trim(name)) between 1 and 120),
  email text not null check (char_length(trim(email)) between 3 and 200),
  phone text,
  organization text,
  application text not null check (char_length(trim(application)) between 1 and 120),
  timeline text,
  message text not null check (char_length(trim(message)) between 1 and 3000),
  source_url text,
  referrer text,
  origin text,
  user_agent text,
  notification_email text not null default 'bslbinod@gmail.com',
  notification_status text not null default 'pending'
    check (notification_status in ('pending', 'sent', 'failed')),
  notification_error text,
  resend_id text,
  metadata jsonb not null default '{}'::jsonb
);

alter table public.quote_requests enable row level security;

revoke all on table public.quote_requests from anon;
revoke all on table public.quote_requests from authenticated;

create index if not exists quote_requests_created_at_idx
  on public.quote_requests (created_at desc);

create index if not exists quote_requests_notification_status_idx
  on public.quote_requests (notification_status, created_at desc);
