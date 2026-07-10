\set ON_ERROR_STOP on

begin;

do $$
declare
  fixture_project_id uuid;
  fixture_user_id uuid;
  fixture_email text;
  invite_id uuid;
  invite_role text;
  expected_member_role text;
  expected_portal_role text;
  actual_member_role text;
  actual_portal_role text;
  role_matrix text[][] := array[
    array['owner', 'owner', 'admin'],
    array['admin', 'admin', 'admin'],
    array['member', 'researcher', 'researcher'],
    array['viewer', 'viewer', 'viewer']
  ];
  role_row text[];
begin
  select project_id, user_id, email
  into fixture_project_id, fixture_user_id, fixture_email
  from public.portal_access
  order by created_at
  limit 1;

  if fixture_project_id is null or fixture_user_id is null or fixture_email is null then
    raise exception 'Invite role verification requires one portal access fixture';
  end if;

  foreach role_row slice 1 in array role_matrix loop
    invite_role := role_row[1];
    expected_member_role := role_row[2];
    expected_portal_role := role_row[3];

    if public.project_member_role_for_invite(invite_role) is distinct from expected_member_role then
      raise exception 'Unexpected project member mapping for %', invite_role;
    end if;
    if public.portal_role_for_invite(invite_role) is distinct from expected_portal_role then
      raise exception 'Unexpected portal mapping for %', invite_role;
    end if;

    insert into public.project_invites (
      token_hash,
      project_id,
      email,
      role,
      expires_at
    ) values (
      encode(extensions.digest(gen_random_uuid()::text || invite_role, 'sha256'), 'hex'),
      fixture_project_id,
      lower(trim(fixture_email)),
      invite_role,
      now() + interval '1 hour'
    )
    returning id into invite_id;

    update public.project_invites
    set accepted_at = now(),
        accepted_by = fixture_user_id
    where id = invite_id;

    select role into actual_member_role
    from public.project_members
    where project_id = fixture_project_id
      and user_id = fixture_user_id;

    select role into actual_portal_role
    from public.portal_access
    where project_id = fixture_project_id
      and user_id = fixture_user_id;

    if actual_member_role is distinct from expected_member_role then
      raise exception 'Invite % produced project member role %, expected %',
        invite_role, actual_member_role, expected_member_role;
    end if;
    if actual_portal_role is distinct from expected_portal_role then
      raise exception 'Invite % produced portal role %, expected %',
        invite_role, actual_portal_role, expected_portal_role;
    end if;
  end loop;

  if public.project_member_role_for_invite('unknown') is not null
    or public.portal_role_for_invite('unknown') is not null then
    raise exception 'Unknown invite roles must fail closed';
  end if;

  perform set_config('request.jwt.claim.sub', fixture_user_id::text, true);
  if not exists (
    select 1
    from public.portal_project_ids()
    where allowed_project_id = fixture_project_id
  ) then
    raise exception 'Viewer lost read-only project access';
  end if;
  if exists (
    select 1
    from public.portal_admin_project_ids()
    where allowed_project_id = fixture_project_id
  ) then
    raise exception 'Viewer incorrectly retained portal admin access';
  end if;
end
$$;

rollback;

select 'invite role mapping verification passed' as result;
