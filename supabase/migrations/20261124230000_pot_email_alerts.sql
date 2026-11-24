create or replace function public.set_notification_preference(
  selected_project_id uuid,
  selected_channel text,
  selected_enabled boolean,
  selected_destination text default null,
  selected_event_types text[] default array['monitor_triggered', 'operation_failed']::text[]
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  selected_user_id uuid := auth.uid();
  preference_id uuid;
  normalized_destination text := nullif(lower(trim(selected_destination)), '');
begin
  if selected_user_id is null or not public.has_portal_access(selected_project_id) then
    raise exception 'Portal access is required';
  end if;
  if selected_channel not in ('portal', 'email') then
    raise exception 'Unsupported notification channel';
  end if;
  if selected_channel = 'email' and (
    normalized_destination is null
    or normalized_destination !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
  ) then
    raise exception 'A valid email destination is required';
  end if;
  if selected_event_types <@ array['monitor_triggered', 'operation_failed', 'pot_moisture']::text[] is not true then
    raise exception 'Unsupported notification event type';
  end if;

  insert into public.notification_preferences (
    project_id, user_id, channel, destination, enabled, event_types
  ) values (
    selected_project_id,
    selected_user_id,
    selected_channel,
    case when selected_channel = 'email' then normalized_destination else null end,
    selected_enabled,
    selected_event_types
  )
  on conflict (project_id, user_id, channel) do update
  set
    destination = excluded.destination,
    enabled = excluded.enabled,
    event_types = excluded.event_types,
    updated_at = now()
  returning id into preference_id;

  return preference_id;
end;
$$;

create or replace function public.evaluate_moisture_alerts() returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare rule record; pot record; reading record; prior public.moisture_alert_state%rowtype;
  current_side smallint; changes text[]; recoveries text[]; first_pair text; newest timestamptz;
  item record; recipient record; link text; details text; title text; cadence interval;
begin
  if not pg_try_advisory_xact_lock(hashtext('evaluate_moisture_alerts')) then return; end if;
  for rule in select r.*, e.project_id,e.slug,e.name,e.current_revision_id from public.moisture_alert_rules r
    join public.experiments e on e.id=r.experiment_id where r.enabled and e.status in ('active','published_sensing')
  loop
    changes:='{}'; recoveries:='{}'; first_pair:=null; newest:=null;
    for pot in select * from public.experiment_assignments where revision_id=rule.current_revision_id loop
      select * into prior from public.moisture_alert_state where experiment_id=rule.experiment_id and pairing_name=pot.pairing_name;
      if prior.revision_id is distinct from rule.current_revision_id or prior.rule_at is distinct from rule.updated_at then
        prior.observed_at:=greatest(rule.updated_at,pot.created_at); prior.side:=0;
      end if;
      cadence:=greatest(interval '10 minutes',interval '1 minute' * (3*coalesce(pot.measurement_interval_minutes,pot.source_measurement_interval_ms/60000.0,5)));
      for reading in select distinct on (s.device_recorded_at) s.device_recorded_at as at,s.calibrated_value as v
        from public.sensor_readings s where s.project_id=rule.project_id and s.device_id=rule.device_id
        and s.pairing_name=pot.pairing_name and s.sensor_key=pot.sensor_key_snapshot
        and s.device_recorded_at > greatest(prior.observed_at,now()-cadence)
        and s.device_recorded_at <= now() and s.unit='vwc_pct' and s.calibrated_value between 0 and 100
        order by s.device_recorded_at,s.id desc
      loop
        current_side:=case when reading.v < rule.minimum then -1 when reading.v > rule.maximum then 1 else 0 end;
        if current_side <> prior.side then
          if current_side=0 then
            recoveries:=array_append(recoveries,format('Pot %s returned to range at %s%% VWC',pot.pot_number,round(reading.v::numeric,1)));
          else
            changes:=array_append(changes,format('Pot %s %s%% VWC (%s)',pot.pot_number,round(reading.v::numeric,1),case when current_side<0 then 'low' else 'high' end));
            first_pair:=coalesce(first_pair,pot.pairing_name);
          end if;
          newest:=greatest(newest,reading.at);
        end if;
        prior.side:=current_side; prior.observed_at:=reading.at;
      end loop;
      if found then
        insert into public.moisture_alert_state values(rule.experiment_id,pot.pairing_name,rule.current_revision_id,rule.updated_at,prior.observed_at,prior.side)
        on conflict(experiment_id,pairing_name) do update set revision_id=excluded.revision_id,rule_at=excluded.rule_at,observed_at=excluded.observed_at,side=excluded.side;
      end if;
    end loop;
    if cardinality(changes)+cardinality(recoveries)=0 then continue; end if;
    link:='/portal?project='||rule.project_id||'&experiment='||rule.slug;
    if cardinality(changes)=1 and first_pair ~ '^[A-Za-z0-9._~-]+$' then link:=link||'&pot='||first_pair; end if;
    for item in select * from (values (true,changes),(false,recoveries)) x(is_alarm,lines) where cardinality(lines)>0 loop
      title:=left(rule.name||case when item.is_alarm then ' · Moisture alert' else ' · Back in range' end,200);
      details:=array_to_string(item.lines,', ')||format('. Range %s–%s%% VWC.', rule.minimum,rule.maximum);
      -- Phone followers and email subscribers can overlap. Keep one detailed portal entry per recipient.
      for recipient in
        with recipients as (
          select f.user_id, true as push, null::text as email
          from public.moisture_alert_followers f
          where f.experiment_id = rule.experiment_id and f.since <= newest
          union all
          select p.user_id, false, u.email::text
          from public.notification_preferences p
          join auth.users u on u.id = p.user_id and u.email_confirmed_at is not null
          where item.is_alarm and p.project_id = rule.project_id and p.channel = 'email'
            and p.enabled and 'pot_moisture' = any(p.event_types) and p.updated_at <= newest
            and lower(p.destination) = lower(u.email)
        )
        select user_id, bool_or(push) as push, max(email) as email
        from recipients where public.can_receive_moisture_alert(rule.experiment_id, user_id)
        group by user_id
      loop
        insert into public.notification_outbox(project_id,user_id,event_type,channel,subject,body,status,metadata)
          values(rule.project_id,recipient.user_id,'pot_moisture','portal',title,left(details,8000),'delivered',jsonb_build_object('experiment_id',rule.experiment_id,'url',link));
        if recipient.email is not null then
          insert into public.notification_outbox(project_id,user_id,event_type,channel,destination,subject,body,metadata)
          values (rule.project_id,recipient.user_id,'pot_moisture','email',recipient.email,
            'ExactH2O pot moisture alert',
            E'A pot in a monitored experiment went outside its moisture range. Sign in and select your project to see pot numbers and readings under Account & access → Recent.\n\nhttps://exacth2o.com/portal?view=account',
            jsonb_build_object('experiment_id',rule.experiment_id));
        end if;
        if item.is_alarm and recipient.push then
          insert into public.moisture_alert_queue(user_id,experiment_id,title,body,link)
            values(recipient.user_id,rule.experiment_id,title,left(details,650),link);
        end if;
      end loop;
    end loop;
  end loop;
end $$;
revoke all on function public.evaluate_moisture_alerts() from public,anon,authenticated;

-- Check current membership and preferences again after a delayed delivery or retry.
create function public.email_notification_allowed(notification_id uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.notification_outbox n
    join public.portal_access a on a.project_id = n.project_id and a.user_id = n.user_id
    where n.id = notification_id and n.channel = 'email'
      and (n.event_type = 'test_email' or exists (
        select 1 from public.notification_preferences p where p.project_id = n.project_id
          and p.user_id = n.user_id and p.channel = 'email' and p.enabled
          and lower(n.destination) = lower(p.destination) and n.event_type = any(p.event_types)
      ))
      and (n.event_type <> 'pot_moisture' or exists (
        select 1 from public.moisture_alert_rules r join public.experiments e on e.id = r.experiment_id
        where r.experiment_id = (n.metadata->>'experiment_id')::uuid
          and e.project_id = n.project_id and e.status in ('active','published_sensing')
          and r.enabled and r.updated_at <= n.created_at
          and public.can_receive_moisture_alert(e.id,n.user_id)
      ))
  );
$$;
revoke all on function public.email_notification_allowed(uuid) from public, anon, authenticated;
grant execute on function public.email_notification_allowed(uuid) to service_role;

create index notification_email_due on public.notification_outbox(next_attempt_at)
  where channel = 'email' and status in ('pending','sending');
create index notification_email_test_by_user on public.notification_outbox(user_id,created_at desc)
  where event_type = 'test_email';

create function public.dispatch_due_email_alerts() returns void
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare secret text;
begin
  update public.notification_outbox set status='failed', lease_until=null, last_error='Delivery attempts exhausted.'
    where channel='email' and status='sending' and attempt_count>=20 and lease_until<=now();
  if not exists (select 1 from public.notification_outbox where channel='email' and next_attempt_at<=now()
    and (status='pending' or (status='sending' and lease_until<=now()))) then return; end if;
  select decrypted_secret into secret from vault.decrypted_secrets where name='exacth2o_notification_dispatcher_secret';
  if secret is null then return; end if;
  perform net.http_post(url:='https://zmhdclcjrkntrpynozvo.supabase.co/functions/v1/notification-dispatcher',
    headers:=jsonb_build_object('Content-Type','application/json','x-exacth2o-notification-secret',secret),
    body:='{}'::jsonb, timeout_milliseconds:=30000);
end $$;
revoke all on function public.dispatch_due_email_alerts() from public, anon, authenticated, service_role;
select cron.schedule('dispatch-exacth2o-email','* * * * *','select public.dispatch_due_email_alerts()');

create function public.request_alert_test_email(selected_project_id uuid) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); address text; job uuid;
begin
  if uid is null or not exists (select 1 from public.portal_access where project_id=selected_project_id and user_id=uid)
    then raise exception 'Sign in to this project to send a test.'; end if;
  select u.email into address from auth.users u where u.id=uid and u.email_confirmed_at is not null;
  if address is null then raise exception 'Confirm your sign-in email first.'; end if;
  perform pg_advisory_xact_lock(hashtext('exacth2o-test-email'),hashtext(uid::text));
  select id into job from public.notification_outbox where user_id=uid and event_type='test_email'
    and created_at>now()-interval '1 minute' order by created_at desc limit 1;
  if job is not null then raise exception 'A test was requested in the last minute. Check your inbox or try again shortly.'; end if;
  insert into public.notification_outbox(project_id,user_id,event_type,channel,destination,subject,body)
    values(selected_project_id,uid,'test_email','email',address,'ExactH2O test email',
      'Your ExactH2O email test worked. To receive pot alerts, enable Email in Account & access and set the moisture range on your experiment.')
    returning id into job;
  perform public.dispatch_due_email_alerts();
  return job;
end $$;
revoke all on function public.request_alert_test_email(uuid) from public, anon;
grant execute on function public.request_alert_test_email(uuid) to authenticated;
