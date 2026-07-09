alter table public.valve_events enable row level security;

grant select on table public.valve_events to authenticated;

drop policy if exists "Portal members can read valve events"
  on public.valve_events;

create policy "Portal members can read valve events"
  on public.valve_events
  for select
  to authenticated
  using (public.has_portal_access(project_id));
