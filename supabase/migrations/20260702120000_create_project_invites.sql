create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create table if not exists public.project_invites (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique check (char_length(token_hash) = 64),
  project_id uuid not null,
  email text not null check (char_length(trim(email)) between 3 and 200),
  role text not null default 'owner'
    check (role in ('owner', 'admin', 'member', 'viewer')),
  expires_at timestamptz not null default now() + interval '14 days',
  accepted_at timestamptz,
  accepted_by uuid,
  created_by uuid,
  created_at timestamptz not null default now(),
  constraint project_invites_email_lowercase
    check (email = lower(trim(email))),
  constraint project_invites_acceptance_pair
    check (
      (accepted_at is null and accepted_by is null)
      or (accepted_at is not null and accepted_by is not null)
    )
);

alter table public.project_invites enable row level security;

revoke all on table public.project_invites from anon;
revoke all on table public.project_invites from authenticated;
grant select, insert, update on table public.project_invites to service_role;

create index if not exists project_invites_project_email_idx
  on public.project_invites (project_id, email);

create index if not exists project_invites_expires_at_idx
  on public.project_invites (expires_at)
  where accepted_at is null;

create or replace function public.create_project_invite(
  invitee_email text,
  invited_project_id uuid default '22222222-2222-4222-8222-222222222222'::uuid,
  invite_role text default 'owner',
  invite_expires_at timestamptz default now() + interval '14 days'
)
returns table (
  invite_id uuid,
  email text,
  project_id uuid,
  role text,
  invite_url text,
  raw_token text,
  expires_at timestamptz
)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  clean_email text := lower(trim(invitee_email));
  generated_token text := encode(gen_random_bytes(32), 'hex');
  inserted_id uuid;
begin
  if clean_email !~* '^[^\s@]+@[^\s@]+\.[^\s@]+$' then
    raise exception 'Invalid invite email';
  end if;

  if invite_role not in ('owner', 'admin', 'member', 'viewer') then
    raise exception 'Invalid invite role';
  end if;

  if invite_expires_at <= now() then
    raise exception 'Invite expiry must be in the future';
  end if;

  insert into public.project_invites (
    token_hash,
    project_id,
    email,
    role,
    expires_at,
    created_by
  )
  values (
    encode(digest(generated_token, 'sha256'), 'hex'),
    invited_project_id,
    clean_email,
    invite_role,
    invite_expires_at,
    auth.uid()
  )
  returning id into inserted_id;

  return query
  select
    inserted_id,
    clean_email,
    invited_project_id,
    invite_role,
    'https://exacth2o.com/portal.html?invite=' || generated_token,
    generated_token,
    invite_expires_at;
end;
$$;

revoke all on function public.create_project_invite(text, uuid, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.create_project_invite(text, uuid, text, timestamptz)
  to service_role;

comment on function public.create_project_invite(text, uuid, text, timestamptz)
  is 'Admin helper for one-time exactH2O portal invite links. Returns the raw token once; only token_hash is stored.';
