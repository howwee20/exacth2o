-- Parent identities may not silently cascade-delete the research record.
create or replace function public.guard_research_identity_delete()
returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
  if current_setting('exacth2o.allow_identity_delete', true) is distinct from 'on' then
    raise exception 'Research identities cannot be deleted without an explicit archival maintenance transaction';
  end if;
  return old;
end $$;
revoke all on function public.guard_research_identity_delete() from public,anon,authenticated;
create trigger guard_research_identity_delete before delete on public.projects for each row execute function public.guard_research_identity_delete();
create trigger guard_research_identity_delete before delete on public.devices for each row execute function public.guard_research_identity_delete();
create trigger guard_research_identity_delete before delete on public.organizations for each row execute function public.guard_research_identity_delete();
revoke truncate,trigger,references,maintain on public.sensor_readings,public.valve_events,public.device_secrets from anon,authenticated;
alter default privileges for role postgres in schema public revoke truncate,trigger,references,maintain on tables from anon,authenticated;
