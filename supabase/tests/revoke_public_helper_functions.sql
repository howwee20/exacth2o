begin;
do $$
begin
  if has_function_privilege('anon', 'public.portal_role_for_email(text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.invite_profile_name(text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.support_message_preview(text,text,text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.is_project_member(uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.portal_role_for_email(text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.invite_profile_name(text)', 'EXECUTE') then
    raise exception 'Staff role/name helpers are callable through the API';
  end if;
  if not has_function_privilege('authenticated', 'public.is_project_member(uuid)', 'EXECUTE') then
    raise exception 'Signed-in users lost is_project_member';
  end if;
end;
$$;

-- The SECURITY DEFINER callers still work for a non-owner caller: accept an invite as
-- service_role (the accept-invite Edge Function's role) and check the profile name was derived.
do $$
declare
  invited uuid := gen_random_uuid();
  invitation record;
begin
  insert into auth.users(id, email) values (invited, 'helper-acl-test@example.invalid');
  select * into invitation from public.create_project_invite(
    'helper-acl-test@example.invalid', '22222222-2222-4222-8222-222222222222', 'viewer', now() + interval '1 day');
  perform set_config('lease.helper_invite', invitation.invite_id::text, true);
  perform set_config('lease.helper_user', invited::text, true);
end;
$$;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;
update public.project_invites
set accepted_at = now(), accepted_by = current_setting('lease.helper_user')::uuid
where id = current_setting('lease.helper_invite')::uuid;
reset role;
do $$
begin
  if (select full_name from public.profiles where id = current_setting('lease.helper_user')::uuid)
       is distinct from 'helper-acl-test' then
    raise exception 'Invite acceptance no longer derives the profile name';
  end if;
end;
$$;
rollback;
