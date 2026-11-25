-- Reserve the daily slot and write the invitation together across concurrent requests.
create function public.reserve_project_member_invite(
  requested_project uuid, inviting_user uuid, invited_email text,
  new_token_hash text, valid_until timestamptz
) returns table(outcome text, invitation_id uuid, reserved_at timestamptz)
language plpgsql security invoker set search_path = '' as $$
declare
  stamp timestamptz;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('exacth2o-member-invite:' || requested_project::text, 0));
  stamp := clock_timestamp();
  if not exists (
    select 1 from public.portal_access a where a.user_id=inviting_user and a.project_id=requested_project
      and a.access_scope='project' and a.role='admin'
  ) then return query select 'forbidden'::text,null::uuid,null::timestamptz; return; end if;
  if exists (select 1 from public.portal_access a where a.project_id=requested_project and lower(a.email)=lower(invited_email) and a.access_scope='project')
  then return query select 'member'::text,null::uuid,null::timestamptz; return; end if;
  if (select count(*) from public.project_invites i where i.project_id=requested_project and i.created_at >= stamp - interval '1 day') >= 20
  then return query select 'limit'::text,null::uuid,null::timestamptz; return; end if;
  return query
    insert into public.project_invites as i(token_hash, project_id, email, role, access_scope, expires_at, created_by, created_at)
    values(new_token_hash,requested_project,lower(invited_email),'member','project',valid_until,inviting_user,stamp)
    returning 'reserved'::text,i.id,i.created_at;
end;
$$;
revoke all on function public.reserve_project_member_invite(uuid,uuid,text,text,timestamptz) from public, anon, authenticated;
grant execute on function public.reserve_project_member_invite(uuid,uuid,text,text,timestamptz) to service_role;
