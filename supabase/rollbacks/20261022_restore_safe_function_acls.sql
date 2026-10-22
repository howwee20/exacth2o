-- ROLLBACK for 01_restore_safe_function_acls.sql (review only).
--
-- Restores the previous create_project_invite body (supabase/migrations/
-- 20261012170000_harden_portal_control_boundaries.sql:184-249). ACL, owner and signature are
-- unchanged by CREATE OR REPLACE.
--
-- The REVOKE statements are deliberately NOT reversed: they only remove grants that production
-- never had (baseline ACLs). Re-granting EXECUTE to anon/authenticated would reintroduce the
-- defect in restored environments. If a rollback must be byte-for-byte, the only safe inverse
-- in production is "do nothing".

create or replace function public.create_project_invite(
  invitee_email text,
  invited_project_id uuid default '22222222-2222-4222-8222-222222222222'::uuid,
  invite_role text default 'member',
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
