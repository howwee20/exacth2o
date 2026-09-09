-- Transaction-only fixtures: no device commands and no persistent accounts.
begin;
do $$
declare
  u uuid := gen_random_uuid();
  stranger uuid := gen_random_uuid();
  invitation record;
  gas_project uuid := '44444444-4444-4444-8444-444444444441';
  gas_device text := 'gas-mixer:b827eb548a44';
  snapshot jsonb;
begin
  insert into auth.users(id,email) values(u, 'mixer-permission-test@example.invalid');
  select * into invitation from public.create_gas_mixer_invite('mixer-permission-test@example.invalid');
  update public.project_invites set accepted_at=now(),accepted_by=u where id=invitation.invite_id;
  if exists(select 1 from public.project_members where user_id=u) then
    raise exception 'Mixer invitation granted general project membership';
  end if;
  if not exists(select 1 from public.portal_access where user_id=u and access_scope='gas_mixer' and role='researcher') then
    raise exception 'Mixer invitation did not grant scoped portal access';
  end if;
  perform set_config('request.jwt.claim.sub',u::text,true);
  if exists(select 1 from public.portal_project_ids()) or exists(select 1 from public.portal_admin_project_ids())
    or public.has_portal_access(gas_project) or public.is_project_member(gas_project) then
    raise exception 'Mixer researcher received irrigation or admin access';
  end if;
  if not public.has_gas_mixer_native_access(gas_project,gas_device,'remote_control') then
    raise exception 'Mixer researcher cannot control native mixer';
  end if;
  snapshot := public.gas_mixer_native_status(gas_project,gas_device);
  if snapshot->>'remote_control_allowed' <> 'true' then raise exception 'Native status permission mismatch'; end if;
  if public.has_system_admin_installation_access(gas_project,gas_device,'remote_view')
    or public.has_system_admin_installation_access(gas_project,gas_device,'remote_control')
    or public.has_gas_mixer_native_access('33333333-3333-4333-8333-333333333331',gas_device,'remote_control')
    or public.has_gas_mixer_native_access(gas_project,'wrong-device','remote_control')
    or public.has_gas_mixer_native_access(gas_project,gas_device,'lighting_control')
    or public.has_gas_mixer_native_access(null,gas_device,'remote_view') then
    raise exception 'Mixer permission escaped its native device scope';
  end if;
  if not public.has_gas_mixer_module_access(gas_project,gas_device,'remote_control')
    or not public.has_gas_mixer_module_access(gas_project,'lighting:beagle','remote_control') then
    raise exception 'Researcher lacks a required Gas Mixer tile module';
  end if;
  snapshot := public.gas_mixer_remote_status(gas_project,gas_device);
  if snapshot->>'remote_control_allowed' <> 'true' then raise exception 'Remote control permission missing'; end if;
  snapshot := public.lighting_native_status(gas_project,'lighting:beagle');
  if snapshot->>'remote_control_allowed' <> 'true' then raise exception 'Lighting permission missing'; end if;
  if public.has_gas_mixer_module_access('33333333-3333-4333-8333-333333333331',gas_device,'remote_view')
    or public.has_gas_mixer_module_access(gas_project,'wrong-device','remote_view')
    or public.has_gas_mixer_module_access(gas_project,gas_device,'observe')
    or public.has_gas_mixer_module_access(null,gas_device,'remote_view') then
    raise exception 'Module access escaped its installation scope';
  end if;
  update public.gas_mixer_researcher_access set can_control=false where user_id=u;
  if public.has_gas_mixer_native_access(gas_project,gas_device,'remote_control')
    or not public.has_gas_mixer_native_access(gas_project,gas_device,'remote_view') then
    raise exception 'Read-only grant is incorrect';
  end if;
  if public.has_gas_mixer_module_access(gas_project,gas_device,'remote_control')
    or public.has_gas_mixer_module_access(gas_project,'lighting:beagle','remote_control')
    or not public.has_gas_mixer_module_access(gas_project,'lighting:beagle','remote_view') then
    raise exception 'Read-only module grant is incorrect';
  end if;
  update public.gas_mixer_researcher_access set revoked_at=now() where user_id=u;
  if public.has_gas_mixer_native_access(gas_project,gas_device,'remote_view') then
    raise exception 'Revoked mixer grant still works';
  end if;
  begin
    perform public.gas_mixer_native_status(gas_project,gas_device);
    raise exception 'Revoked researcher could read mixer state';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.gas_mixer_remote_status(gas_project,gas_device);
    raise exception 'Revoked researcher could read remote status';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.lighting_native_status(gas_project,'lighting:beagle');
    raise exception 'Revoked researcher could read lighting status';
  exception when insufficient_privilege then null;
  end;
  perform set_config('request.jwt.claim.sub',stranger::text,true);
  if public.has_gas_mixer_native_access(gas_project,gas_device,'remote_view')
    or public.has_gas_mixer_module_access(gas_project,gas_device,'remote_view') then
    raise exception 'Unrelated user received mixer access';
  end if;
  perform set_config('request.jwt.claim.sub','',true);
  if public.has_gas_mixer_native_access(gas_project,gas_device,'remote_view')
    or public.has_gas_mixer_module_access(gas_project,'lighting:beagle','remote_view') then
    raise exception 'Anonymous user received mixer access';
  end if;
  if has_table_privilege('authenticated','public.gas_mixer_researcher_access','INSERT')
    or has_function_privilege('authenticated','public.create_gas_mixer_invite(text)','EXECUTE') then
    raise exception 'Authenticated users can grant themselves access';
  end if;
end;
$$;
rollback;
