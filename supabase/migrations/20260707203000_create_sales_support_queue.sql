create extension if not exists pgcrypto with schema extensions;

alter table public.quote_requests
  add column if not exists project_id uuid not null default '22222222-2222-4222-8222-222222222222'::uuid,
  add column if not exists status text not null default 'new'
    check (status in ('new', 'open', 'quoted', 'waiting_on_customer', 'won', 'lost', 'closed')),
  add column if not exists priority text not null default 'normal'
    check (priority in ('low', 'normal', 'high', 'urgent')),
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists closed_at timestamptz;

create index if not exists quote_requests_project_status_created_idx
  on public.quote_requests (project_id, status, created_at desc);

grant select, update on table public.quote_requests to authenticated;

drop policy if exists "Portal admins can read quote requests"
  on public.quote_requests;
create policy "Portal admins can read quote requests"
  on public.quote_requests
  for select
  to authenticated
  using (public.is_portal_admin(project_id));

drop policy if exists "Portal admins can update quote requests"
  on public.quote_requests;
create policy "Portal admins can update quote requests"
  on public.quote_requests
  for update
  to authenticated
  using (public.is_portal_admin(project_id))
  with check (public.is_portal_admin(project_id));

create table if not exists public.support_threads (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null default '22222222-2222-4222-8222-222222222222'::uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_message_at timestamptz not null default now(),
  source text not null default 'form'
    check (source in ('email', 'form', 'quote', 'portal', 'other')),
  status text not null default 'new'
    check (status in ('new', 'open', 'waiting_on_customer', 'quoted', 'won', 'lost', 'closed')),
  priority text not null default 'normal'
    check (priority in ('low', 'normal', 'high', 'urgent')),
  request_type text not null default 'support'
    check (request_type in ('support', 'quote', 'demo', 'docs', 'training', 'billing', 'install', 'other')),
  subject text not null check (char_length(trim(subject)) between 1 and 240),
  customer_name text,
  customer_email text not null check (char_length(trim(customer_email)) between 3 and 240),
  customer_phone text,
  customer_organization text,
  quote_request_id uuid references public.quote_requests(id) on delete set null,
  external_thread_key text,
  assigned_to text,
  metadata jsonb not null default '{}'::jsonb,
  unique (quote_request_id)
);

create index if not exists support_threads_project_status_last_message_idx
  on public.support_threads (project_id, status, last_message_at desc);

create index if not exists support_threads_customer_email_idx
  on public.support_threads (lower(customer_email));

alter table public.support_threads enable row level security;

revoke all on table public.support_threads from anon;
revoke all on table public.support_threads from authenticated;
grant select, update on table public.support_threads to authenticated;
grant select, insert, update, delete on table public.support_threads to service_role;

drop policy if exists "Portal admins can read support threads"
  on public.support_threads;
create policy "Portal admins can read support threads"
  on public.support_threads
  for select
  to authenticated
  using (public.is_portal_admin(project_id));

drop policy if exists "Portal admins can update support threads"
  on public.support_threads;
create policy "Portal admins can update support threads"
  on public.support_threads
  for update
  to authenticated
  using (public.is_portal_admin(project_id))
  with check (public.is_portal_admin(project_id));

create table if not exists public.support_messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.support_threads(id) on delete cascade,
  project_id uuid not null default '22222222-2222-4222-8222-222222222222'::uuid,
  created_at timestamptz not null default now(),
  direction text not null check (direction in ('inbound', 'outbound', 'internal', 'system')),
  channel text not null default 'form'
    check (channel in ('email', 'form', 'portal', 'system')),
  from_email text,
  from_name text,
  to_emails text[] not null default '{}'::text[],
  cc_emails text[] not null default '{}'::text[],
  subject text,
  body_text text,
  body_html text,
  external_message_id text,
  external_email_id text,
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists support_messages_thread_created_idx
  on public.support_messages (thread_id, created_at asc);

create unique index if not exists support_messages_external_message_idx
  on public.support_messages (external_message_id)
  where external_message_id is not null;

create unique index if not exists support_messages_external_email_idx
  on public.support_messages (external_email_id)
  where external_email_id is not null;

alter table public.support_messages enable row level security;

revoke all on table public.support_messages from anon;
revoke all on table public.support_messages from authenticated;
grant select on table public.support_messages to authenticated;
grant select, insert, update, delete on table public.support_messages to service_role;

drop policy if exists "Portal admins can read support messages"
  on public.support_messages;
create policy "Portal admins can read support messages"
  on public.support_messages
  for select
  to authenticated
  using (public.is_portal_admin(project_id));

create table if not exists public.support_notes (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.support_threads(id) on delete cascade,
  project_id uuid not null default '22222222-2222-4222-8222-222222222222'::uuid,
  created_at timestamptz not null default now(),
  author_user_id uuid references auth.users(id) on delete set null,
  note text not null check (char_length(trim(note)) between 1 and 4000)
);

create index if not exists support_notes_thread_created_idx
  on public.support_notes (thread_id, created_at desc);

alter table public.support_notes enable row level security;

revoke all on table public.support_notes from anon;
revoke all on table public.support_notes from authenticated;
grant select, insert on table public.support_notes to authenticated;
grant select, insert, update, delete on table public.support_notes to service_role;

drop policy if exists "Portal admins can read support notes"
  on public.support_notes;
create policy "Portal admins can read support notes"
  on public.support_notes
  for select
  to authenticated
  using (public.is_portal_admin(project_id));

drop policy if exists "Portal admins can add support notes"
  on public.support_notes;
create policy "Portal admins can add support notes"
  on public.support_notes
  for insert
  to authenticated
  with check (
    public.is_portal_admin(project_id)
    and author_user_id = auth.uid()
  );

create or replace function public.touch_support_thread_from_message()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.support_threads
  set last_message_at = greatest(new.created_at, last_message_at),
      updated_at = now()
  where id = new.thread_id;

  return new;
end;
$$;

drop trigger if exists touch_support_thread_from_message
  on public.support_messages;
create trigger touch_support_thread_from_message
after insert on public.support_messages
for each row
execute function public.touch_support_thread_from_message();

do $$
begin
  alter publication supabase_realtime add table public.support_threads;
exception
  when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.support_messages;
exception
  when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.quote_requests;
exception
  when duplicate_object then null;
end $$;
