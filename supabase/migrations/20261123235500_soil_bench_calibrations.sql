create table public.soil_bench_calibrations (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id),
  device_id text not null check (length(device_id) between 1 and 200),
  name text not null check (name = btrim(name) and length(name) between 1 and 120),
  coefficients double precision[] not null check (array_ndims(coefficients) = 1 and cardinality(coefficients) between 1 and 6
    and array_position(coefficients, null) is null and '-Infinity'::float8 < all(coefficients) and 'Infinity'::float8 > all(coefficients)),
  worksheet jsonb not null check (jsonb_typeof(worksheet) = 'object' and octet_length(worksheet::text) <= 512000),
  created_by uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now()
);
create unique index soil_bench_curve_names on public.soil_bench_calibrations (project_id, device_id, lower(name));
alter table public.soil_bench_calibrations enable row level security;
revoke all on public.soil_bench_calibrations from public, anon, authenticated;
grant select, insert on public.soil_bench_calibrations to authenticated;
create policy "Read project bench curves" on public.soil_bench_calibrations for select to authenticated
  using (public.has_portal_access(project_id));
create policy "Operators save their bench curves" on public.soil_bench_calibrations for insert to authenticated
  with check (created_by = (select auth.uid()) and exists (
    select 1 from public.devices d where d.id = soil_bench_calibrations.device_id and d.project_id = soil_bench_calibrations.project_id
  ) and exists (
    select 1 from public.portal_access a where a.user_id = (select auth.uid()) and a.project_id = soil_bench_calibrations.project_id
      and a.access_scope = 'project' and a.role in ('admin', 'researcher')
  ));
