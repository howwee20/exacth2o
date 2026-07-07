create table if not exists public.software_terms_acceptances (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid not null,
  invite_id uuid references public.project_invites(id) on delete set null,
  email text not null check (char_length(trim(email)) between 3 and 200),
  terms_version text not null check (char_length(trim(terms_version)) between 1 and 64),
  accepted_at timestamptz not null default now(),
  ip_address text,
  user_agent text,
  created_at timestamptz not null default now(),
  constraint software_terms_acceptances_email_lowercase
    check (email = lower(trim(email))),
  constraint software_terms_acceptances_user_version_unique
    unique (user_id, terms_version)
);

alter table public.software_terms_acceptances enable row level security;

revoke all on table public.software_terms_acceptances from anon;
revoke all on table public.software_terms_acceptances from authenticated;
grant select on table public.software_terms_acceptances to authenticated;
grant select, insert, update, delete on table public.software_terms_acceptances to service_role;

create index if not exists software_terms_acceptances_project_idx
  on public.software_terms_acceptances (project_id, accepted_at desc);

create index if not exists software_terms_acceptances_email_idx
  on public.software_terms_acceptances (email);

drop policy if exists "Users can read software terms acceptances" on public.software_terms_acceptances;
create policy "Users can read software terms acceptances"
  on public.software_terms_acceptances
  for select
  to authenticated
  using (
    user_id = auth.uid()
    or public.is_portal_admin(project_id)
  );

comment on table public.software_terms_acceptances
  is 'Versioned click-through acceptance audit for exactH2O portal software access terms.';
