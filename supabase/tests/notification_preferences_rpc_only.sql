begin;
create schema notify_test;
create table notify_test.ids(label text primary key, id uuid not null);
insert into notify_test.ids values ('member', gen_random_uuid());
grant usage on schema notify_test to authenticated;
grant select on notify_test.ids to authenticated;
insert into auth.users(id, email) select id, 'notify-member@example.invalid' from notify_test.ids;
-- The portal_access insert trigger creates the member's 'portal' preference row.
insert into public.portal_access(project_id, user_id, email, role, access_scope)
select '22222222-2222-4222-8222-222222222222', id, 'notify-member@example.invalid', 'researcher', 'project'
from notify_test.ids;

select set_config('request.jwt.claims', json_build_object('sub', (select id from notify_test.ids), 'role', 'authenticated')::text, true);
select set_config('request.jwt.claim.sub', (select id::text from notify_test.ids), true);
set local role authenticated;
do $$
begin
  -- Direct table writes are refused; the validated RPC is the only write path.
  begin
    update public.notification_preferences
    set channel = 'email', destination = 'not-an-address', event_types = array['anything']
    where user_id = (select id from notify_test.ids);
    raise exception 'Direct preference update bypassed RPC validation';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.set_notification_preference('22222222-2222-4222-8222-222222222222', 'email', true, 'not-an-address');
    raise exception 'RPC accepted an invalid destination';
  exception when raise_exception then
    if sqlerrm not ilike '%valid email destination%' then raise; end if;
  end;
  perform public.set_notification_preference('22222222-2222-4222-8222-222222222222', 'email', true, 'Notify-Member@Example.invalid');
  if (select destination from public.notification_preferences
      where user_id = (select id from notify_test.ids) and channel = 'email') <> 'notify-member@example.invalid' then
    raise exception 'RPC no longer stores the normalized destination';
  end if;
end;
$$;
reset role;
rollback;
