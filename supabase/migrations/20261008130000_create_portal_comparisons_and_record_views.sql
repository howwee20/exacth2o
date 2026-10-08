-- Workbench comparisons, reversible exclusions, per-user "last looked" marks, and three read-only
-- aggregate functions for history beyond the portal's live window.
--
-- Additive only. Nothing here writes readings, valve events, controller commands, targets,
-- pairings, calibration, schedules or identity tables. The functions are SECURITY INVOKER,
-- so the caller's existing row-level security on sensor_readings and valve_events decides what
-- they can aggregate.
--
-- Exclusions are never deleted: revoking one records who revoked it, when and why, and the
-- original row stays. Comparisons are archived, not deleted.
--
-- Rollback (nothing else depends on these): drop function public.portal_valve_open_buckets(uuid,
-- text, text[], timestamptz, timestamptz, integer); drop function public.portal_reading_gaps(uuid,
-- text, text[], timestamptz, timestamptz, integer, integer); drop function public.portal_reading_buckets(uuid,
-- text, text[], timestamptz, timestamptz, integer, jsonb); drop table
-- public.portal_experiment_views; drop table public.portal_comparison_exclusions; drop table
-- public.portal_comparisons; then the four trigger functions defined below. Back up the three
-- tables first if they hold rows.

-- ---------------------------------------------------------------- comparisons

create table if not exists public.portal_comparisons (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  device_id text not null references public.devices(id) on delete cascade,
  experiment_id uuid,
  -- The comparison is titled by the question it answers.
  question text not null check (char_length(btrim(question)) between 3 and 200),
  -- { measure, grouping, window, alignment, bucket, weighting, hidden, ... } — presentation and
  -- query parameters only; never data.
  definition jsonb not null check (jsonb_typeof(definition) = 'object' and pg_column_size(definition) <= 16384),
  sharing text not null default 'private' check (sharing in ('private', 'project')),
  created_by uuid not null default auth.uid() references auth.users(id) on delete restrict,
  author_label text not null check (char_length(author_label) between 1 and 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  constraint portal_comparisons_id_project_unique unique (id, project_id),
  constraint portal_comparisons_experiment_fk foreign key (experiment_id, project_id)
    references public.experiments(id, project_id) on delete restrict
);

create index if not exists portal_comparisons_project_idx
  on public.portal_comparisons (project_id, updated_at desc);

create or replace function public.portal_comparisons_before_write()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  writer_email text;
begin
  if tg_op = 'INSERT' then
    new.created_by := (select auth.uid());
    new.created_at := now();
    if new.created_by is null then
      raise exception 'A signed-in portal member is required to save a comparison.' using errcode = '42501';
    end if;
    if not exists (select 1 from public.devices device where device.id = new.device_id and device.project_id = new.project_id) then
      raise exception 'The controller does not belong to this project.' using errcode = '23514';
    end if;
    select access.email into writer_email
    from public.portal_access access
    where access.project_id = new.project_id and access.user_id = new.created_by and access.access_scope = 'project'
    limit 1;
    new.author_label := coalesce(writer_email, new.author_label);
  else
    if new.id <> old.id or new.project_id <> old.project_id or new.device_id <> old.device_id
       or new.created_by <> old.created_by or new.author_label <> old.author_label or new.created_at <> old.created_at
       or new.experiment_id is distinct from old.experiment_id then
      raise exception 'Only the question, definition, sharing and archive state of a comparison can change.' using errcode = '23514';
    end if;
  end if;
  new.question := btrim(new.question);
  new.updated_at := now();
  return new;
end;
$$;

revoke all on function public.portal_comparisons_before_write() from public, anon, authenticated;

drop trigger if exists portal_comparisons_before_write on public.portal_comparisons;
create trigger portal_comparisons_before_write
  before insert or update on public.portal_comparisons
  for each row execute function public.portal_comparisons_before_write();

alter table public.portal_comparisons enable row level security;

-- Visible to the owner, or to every member when shared — and only while the reader can see the
-- experiment it is about (experiments are themselves limited by role).
drop policy if exists "members read own or shared comparisons" on public.portal_comparisons;
create policy "members read own or shared comparisons"
  on public.portal_comparisons for select to authenticated
  using (
    public.has_portal_access(project_id)
    and (created_by = (select auth.uid()) or sharing = 'project')
    and (
      experiment_id is null
      or exists (select 1 from public.experiments experiment where experiment.id = portal_comparisons.experiment_id and experiment.project_id = portal_comparisons.project_id)
    )
  );

drop policy if exists "researchers and admins save comparisons" on public.portal_comparisons;
create policy "researchers and admins save comparisons"
  on public.portal_comparisons for insert to authenticated
  with check (
    created_by = (select auth.uid())
    and public.has_portal_project_role(project_id, array['admin', 'researcher'])
    and (
      experiment_id is null
      or exists (select 1 from public.experiments experiment where experiment.id = portal_comparisons.experiment_id and experiment.project_id = portal_comparisons.project_id)
    )
  );

drop policy if exists "owners update their comparisons" on public.portal_comparisons;
create policy "owners update their comparisons"
  on public.portal_comparisons for update to authenticated
  using (created_by = (select auth.uid()) and public.has_portal_project_role(project_id, array['admin', 'researcher']))
  with check (created_by = (select auth.uid()) and public.has_portal_project_role(project_id, array['admin', 'researcher']));

revoke all on public.portal_comparisons from public, anon, authenticated;
grant select, insert on public.portal_comparisons to authenticated;
grant update (question, definition, sharing, archived_at) on public.portal_comparisons to authenticated;
grant select, insert, update, delete on public.portal_comparisons to service_role;

-- ---------------------------------------------------------------- exclusions

create table if not exists public.portal_comparison_exclusions (
  id uuid primary key default gen_random_uuid(),
  comparison_id uuid not null,
  project_id uuid not null,
  -- Scope: one pot (or every pot in the comparison when null), over a time range (open at
  -- either end when null). Readings in scope are left out of statistics, figure and exports.
  pairing_name text check (pairing_name is null or char_length(pairing_name) between 1 and 120),
  starts_at timestamptz,
  ends_at timestamptz,
  reason text not null check (char_length(btrim(reason)) between 3 and 500),
  created_by uuid not null default auth.uid() references auth.users(id) on delete restrict,
  author_label text not null check (char_length(author_label) between 1 and 200),
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by uuid references auth.users(id) on delete restrict,
  revoked_by_label text,
  revoke_reason text check (revoke_reason is null or char_length(btrim(revoke_reason)) between 3 and 500),
  constraint portal_comparison_exclusions_comparison_fk foreign key (comparison_id, project_id)
    references public.portal_comparisons(id, project_id) on delete restrict,
  constraint portal_comparison_exclusions_range check (starts_at is null or ends_at is null or ends_at > starts_at),
  constraint portal_comparison_exclusions_revocation check (
    (revoked_at is null and revoked_by is null and revoke_reason is null and revoked_by_label is null)
    or (revoked_at is not null and revoked_by is not null and revoke_reason is not null)
  )
);

create index if not exists portal_comparison_exclusions_comparison_idx
  on public.portal_comparison_exclusions (comparison_id, created_at);

create or replace function public.portal_comparison_exclusions_before_write()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  writer uuid := (select auth.uid());
  writer_email text;
begin
  if writer is null then
    raise exception 'A signed-in portal member is required.' using errcode = '42501';
  end if;
  select access.email into writer_email
  from public.portal_access access
  where access.project_id = new.project_id and access.user_id = writer and access.access_scope = 'project'
  limit 1;
  if tg_op = 'INSERT' then
    new.created_by := writer;
    new.created_at := now();
    new.author_label := coalesce(writer_email, new.author_label);
    new.revoked_at := null;
    new.revoked_by := null;
    new.revoked_by_label := null;
    new.revoke_reason := null;
    new.reason := btrim(new.reason);
    return new;
  end if;
  -- An exclusion is revoked once, and nothing else about it ever changes.
  if old.revoked_at is not null then
    raise exception 'This exclusion was already revoked.' using errcode = '23514';
  end if;
  if new.comparison_id <> old.comparison_id or new.project_id <> old.project_id
     or new.pairing_name is distinct from old.pairing_name or new.starts_at is distinct from old.starts_at
     or new.ends_at is distinct from old.ends_at or new.reason <> old.reason or new.created_by <> old.created_by
     or new.author_label <> old.author_label or new.created_at <> old.created_at then
    raise exception 'An exclusion cannot be edited; revoke it and add a new one.' using errcode = '23514';
  end if;
  if new.revoke_reason is null then
    raise exception 'Say why the exclusion is revoked.' using errcode = '23514';
  end if;
  new.revoked_at := now();
  new.revoked_by := writer;
  new.revoked_by_label := coalesce(writer_email, 'portal member');
  new.revoke_reason := btrim(new.revoke_reason);
  return new;
end;
$$;

revoke all on function public.portal_comparison_exclusions_before_write() from public, anon, authenticated;

drop trigger if exists portal_comparison_exclusions_before_write on public.portal_comparison_exclusions;
create trigger portal_comparison_exclusions_before_write
  before insert or update on public.portal_comparison_exclusions
  for each row execute function public.portal_comparison_exclusions_before_write();

alter table public.portal_comparison_exclusions enable row level security;

drop policy if exists "readers of a comparison read its exclusions" on public.portal_comparison_exclusions;
create policy "readers of a comparison read its exclusions"
  on public.portal_comparison_exclusions for select to authenticated
  using (exists (
    select 1 from public.portal_comparisons comparison
    where comparison.id = portal_comparison_exclusions.comparison_id
      and comparison.project_id = portal_comparison_exclusions.project_id
  ));

drop policy if exists "comparison owners add exclusions" on public.portal_comparison_exclusions;
create policy "comparison owners add exclusions"
  on public.portal_comparison_exclusions for insert to authenticated
  with check (
    created_by = (select auth.uid())
    and public.has_portal_project_role(project_id, array['admin', 'researcher'])
    and exists (
      select 1 from public.portal_comparisons comparison
      where comparison.id = portal_comparison_exclusions.comparison_id
        and comparison.project_id = portal_comparison_exclusions.project_id
        and comparison.created_by = (select auth.uid())
    )
  );

drop policy if exists "comparison owners revoke exclusions" on public.portal_comparison_exclusions;
create policy "comparison owners revoke exclusions"
  on public.portal_comparison_exclusions for update to authenticated
  using (
    public.has_portal_project_role(project_id, array['admin', 'researcher'])
    and exists (
      select 1 from public.portal_comparisons comparison
      where comparison.id = portal_comparison_exclusions.comparison_id
        and comparison.project_id = portal_comparison_exclusions.project_id
        and comparison.created_by = (select auth.uid())
    )
  )
  with check (
    public.has_portal_project_role(project_id, array['admin', 'researcher'])
    and exists (
      select 1 from public.portal_comparisons comparison
      where comparison.id = portal_comparison_exclusions.comparison_id
        and comparison.project_id = portal_comparison_exclusions.project_id
        and comparison.created_by = (select auth.uid())
    )
  );

revoke all on public.portal_comparison_exclusions from public, anon, authenticated;
grant select, insert on public.portal_comparison_exclusions to authenticated;
grant update (revoke_reason) on public.portal_comparison_exclusions to authenticated;
grant select, insert, update, delete on public.portal_comparison_exclusions to service_role;

-- ---------------------------------------------------------------- "since you last looked"

create table if not exists public.portal_experiment_views (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  experiment_id uuid not null,
  last_seen_at timestamptz not null default now(),
  primary key (user_id, experiment_id),
  constraint portal_experiment_views_experiment_fk foreign key (experiment_id, project_id)
    references public.experiments(id, project_id) on delete cascade
);

create or replace function public.portal_experiment_views_before_write()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  new.user_id := (select auth.uid());
  if new.user_id is null then
    raise exception 'A signed-in portal member is required.' using errcode = '42501';
  end if;
  -- Never in the future, and never earlier than what this person already saw (two tabs).
  new.last_seen_at := least(coalesce(new.last_seen_at, now()), now());
  if tg_op = 'UPDATE' then
    if new.project_id <> old.project_id or new.experiment_id <> old.experiment_id then
      raise exception 'A view mark cannot move to another experiment.' using errcode = '23514';
    end if;
    new.last_seen_at := greatest(old.last_seen_at, new.last_seen_at);
  end if;
  return new;
end;
$$;

revoke all on function public.portal_experiment_views_before_write() from public, anon, authenticated;

drop trigger if exists portal_experiment_views_before_write on public.portal_experiment_views;
create trigger portal_experiment_views_before_write
  before insert or update on public.portal_experiment_views
  for each row execute function public.portal_experiment_views_before_write();

alter table public.portal_experiment_views enable row level security;

drop policy if exists "members read their own view marks" on public.portal_experiment_views;
create policy "members read their own view marks"
  on public.portal_experiment_views for select to authenticated
  using (user_id = (select auth.uid()) and public.has_portal_access(project_id));

drop policy if exists "members set their own view marks" on public.portal_experiment_views;
create policy "members set their own view marks"
  on public.portal_experiment_views for insert to authenticated
  with check (user_id = (select auth.uid()) and public.has_portal_access(project_id));

drop policy if exists "members move their own view marks" on public.portal_experiment_views;
create policy "members move their own view marks"
  on public.portal_experiment_views for update to authenticated
  using (user_id = (select auth.uid()) and public.has_portal_access(project_id))
  with check (user_id = (select auth.uid()) and public.has_portal_access(project_id));

revoke all on public.portal_experiment_views from public, anon, authenticated;
grant select, insert on public.portal_experiment_views to authenticated;
grant update (last_seen_at) on public.portal_experiment_views to authenticated;
grant select, insert, update, delete on public.portal_experiment_views to service_role;

-- ---------------------------------------------------------------- aggregates (read-only)

-- Per pot, per bucket: reading count and means, with readings in the given exclusions left out
-- (and counted separately). Buckets start at p_start, so a comparison aligned to an event can
-- pass the event time. Bounded: at most 120 days, 200 pots and 60 000 pot-buckets per call.
create or replace function public.portal_reading_buckets(
  p_project_id uuid,
  p_device_id text,
  p_pairing_names text[],
  p_start timestamptz,
  p_end timestamptz,
  p_bucket_seconds integer,
  p_exclusions jsonb default '[]'::jsonb
)
returns table (
  pairing_name text,
  bucket_start timestamptz,
  readings integer,
  excluded integer,
  vwc_mean double precision,
  raw_mean double precision,
  temperature_mean double precision,
  ec_mean double precision
)
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
begin
  if p_start is null or p_end is null or p_end <= p_start or p_end - p_start > interval '120 days' then
    raise exception 'Choose a window of up to 120 days.' using errcode = '22023';
  end if;
  if p_bucket_seconds is null or p_bucket_seconds < 60 or p_bucket_seconds > 7 * 86400 then
    raise exception 'Buckets must be between one minute and seven days.' using errcode = '22023';
  end if;
  if p_pairing_names is null or cardinality(p_pairing_names) not between 1 and 200 then
    raise exception 'Choose between 1 and 200 pots.' using errcode = '22023';
  end if;
  if ceil(extract(epoch from p_end - p_start) / p_bucket_seconds) * cardinality(p_pairing_names) > 60000 then
    raise exception 'Too many pot-buckets for one request; use larger buckets or fewer pots.' using errcode = '22023';
  end if;
  if p_exclusions is null or jsonb_typeof(p_exclusions) <> 'array' or jsonb_array_length(p_exclusions) > 200 then
    raise exception 'Exclusions must be a list of at most 200 ranges.' using errcode = '22023';
  end if;

  return query
  with scope as (
    select nullif(item ->> 'pairing_name', '') as pot,
           (item ->> 'starts_at')::timestamptz as starts_at,
           (item ->> 'ends_at')::timestamptz as ends_at
    from jsonb_array_elements(p_exclusions) item
  ),
  marked as (
    select reading.pairing_name as pot,
           reading.device_recorded_at as at,
           reading.calibrated_value, reading.raw_value, reading.temperature, reading.electrical_conductivity,
           exists (
             select 1 from scope
             where (scope.pot is null or scope.pot = reading.pairing_name)
               and (scope.starts_at is null or reading.device_recorded_at >= scope.starts_at)
               and (scope.ends_at is null or reading.device_recorded_at < scope.ends_at)
           ) as is_excluded
    from public.sensor_readings reading
    where reading.project_id = p_project_id
      and reading.device_id = p_device_id
      and reading.pairing_name = any (p_pairing_names)
      and reading.device_recorded_at >= p_start
      and reading.device_recorded_at < p_end
  )
  select marked.pot,
         p_start + floor(extract(epoch from marked.at - p_start) / p_bucket_seconds) * p_bucket_seconds * interval '1 second',
         (count(*) filter (where not marked.is_excluded))::integer,
         (count(*) filter (where marked.is_excluded))::integer,
         round((avg(marked.calibrated_value) filter (where not marked.is_excluded))::numeric, 4)::double precision,
         round((avg(marked.raw_value) filter (where not marked.is_excluded))::numeric, 4)::double precision,
         round((avg(marked.temperature) filter (where not marked.is_excluded))::numeric, 4)::double precision,
         round((avg(marked.electrical_conductivity) filter (where not marked.is_excluded))::numeric, 4)::double precision
  from marked
  group by 1, 2
  order by 1, 2;
end;
$$;

revoke all on function public.portal_reading_buckets(uuid, text, text[], timestamptz, timestamptz, integer, jsonb) from public, anon;
grant execute on function public.portal_reading_buckets(uuid, text, text[], timestamptz, timestamptz, integer, jsonb) to authenticated, service_role;

-- Stretches without readings, per pot: runs of at least p_min_buckets complete buckets with no
-- reading, counted from the pot's first reading in the window (a pot that never reported in the
-- window has no placeable gap). A run reaching the last complete bucket is ongoing. Returns only
-- the gaps, so the Record does not download every bucket to find them.
create or replace function public.portal_reading_gaps(
  p_project_id uuid,
  p_device_id text,
  p_pairing_names text[],
  p_start timestamptz,
  p_end timestamptz,
  p_bucket_seconds integer default 3600,
  p_min_buckets integer default 2
)
returns table (
  pairing_name text,
  gap_start timestamptz,
  gap_end timestamptz,
  ongoing boolean
)
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
declare
  complete_buckets integer;
begin
  if p_start is null or p_end is null or p_end <= p_start or p_end - p_start > interval '120 days' then
    raise exception 'Choose a window of up to 120 days.' using errcode = '22023';
  end if;
  if p_bucket_seconds is null or p_bucket_seconds < 600 or p_bucket_seconds > 86400 then
    raise exception 'Buckets must be between ten minutes and one day.' using errcode = '22023';
  end if;
  if p_pairing_names is null or cardinality(p_pairing_names) not between 1 and 200 then
    raise exception 'Choose between 1 and 200 pots.' using errcode = '22023';
  end if;
  if p_min_buckets is null or p_min_buckets < 1 then
    raise exception 'A gap is at least one bucket long.' using errcode = '22023';
  end if;
  complete_buckets := floor(extract(epoch from p_end - p_start) / p_bucket_seconds)::integer;
  if complete_buckets::bigint * cardinality(p_pairing_names) > 400000 then
    raise exception 'Too many pot-buckets for one request; use larger buckets or fewer pots.' using errcode = '22023';
  end if;

  return query
  with present as (
    select reading.pairing_name as pot,
           floor(extract(epoch from reading.device_recorded_at - p_start) / p_bucket_seconds)::integer as bucket
    from public.sensor_readings reading
    where reading.project_id = p_project_id
      and reading.device_id = p_device_id
      and reading.pairing_name = any (p_pairing_names)
      and reading.device_recorded_at >= p_start
      and reading.device_recorded_at < p_end
    group by 1, 2
  ),
  first_seen as (
    select present.pot, min(present.bucket) as first_bucket from present group by present.pot
  ),
  missing as (
    select first_seen.pot, grid.bucket
    from first_seen
    cross join lateral generate_series(first_seen.first_bucket, complete_buckets - 1) as grid(bucket)
    where not exists (select 1 from present where present.pot = first_seen.pot and present.bucket = grid.bucket)
  ),
  islands as (
    select missing.pot, missing.bucket,
           missing.bucket - row_number() over (partition by missing.pot order by missing.bucket)::integer as island
    from missing
  )
  select islands.pot,
         p_start + min(islands.bucket) * p_bucket_seconds * interval '1 second',
         p_start + (max(islands.bucket) + 1) * p_bucket_seconds * interval '1 second',
         max(islands.bucket) = complete_buckets - 1
  from islands
  group by islands.pot, islands.island
  having count(*) >= p_min_buckets
  order by 1, 2;
end;
$$;

revoke all on function public.portal_reading_gaps(uuid, text, text[], timestamptz, timestamptz, integer, integer) from public, anon;
grant execute on function public.portal_reading_gaps(uuid, text, text[], timestamptz, timestamptz, integer, integer) to authenticated, service_role;

-- Valve openings the controller recorded, per pot and bucket. These are controller events
-- (a valve was told to open, for this long); they are not measured water.
create or replace function public.portal_valve_open_buckets(
  p_project_id uuid,
  p_device_id text,
  p_pairing_names text[],
  p_start timestamptz,
  p_end timestamptz,
  p_bucket_seconds integer
)
returns table (
  pairing_name text,
  bucket_start timestamptz,
  openings integer,
  commanded_open_ms bigint
)
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
begin
  if p_start is null or p_end is null or p_end <= p_start or p_end - p_start > interval '120 days' then
    raise exception 'Choose a window of up to 120 days.' using errcode = '22023';
  end if;
  if p_bucket_seconds is null or p_bucket_seconds < 300 or p_bucket_seconds > 7 * 86400 then
    raise exception 'Buckets must be between five minutes and seven days.' using errcode = '22023';
  end if;
  if p_pairing_names is null or cardinality(p_pairing_names) not between 1 and 200 then
    raise exception 'Choose between 1 and 200 pots.' using errcode = '22023';
  end if;
  if ceil(extract(epoch from p_end - p_start) / p_bucket_seconds) * cardinality(p_pairing_names) > 60000 then
    raise exception 'Too many pot-buckets for one request; use larger buckets or fewer pots.' using errcode = '22023';
  end if;

  return query
  select event.pairing_name,
         p_start + floor(extract(epoch from event.device_recorded_at - p_start) / p_bucket_seconds) * p_bucket_seconds * interval '1 second',
         count(*)::integer,
         coalesce(sum(event.duration_ms), 0)::bigint
  from public.valve_events event
  where event.project_id = p_project_id
    and event.device_id = p_device_id
    and event.pairing_name = any (p_pairing_names)
    and event.action = 'open'
    and event.device_recorded_at >= p_start
    and event.device_recorded_at < p_end
  group by 1, 2
  order by 1, 2;
end;
$$;

revoke all on function public.portal_valve_open_buckets(uuid, text, text[], timestamptz, timestamptz, integer) from public, anon;
grant execute on function public.portal_valve_open_buckets(uuid, text, text[], timestamptz, timestamptz, integer) to authenticated, service_role;

notify pgrst, 'reload schema';
