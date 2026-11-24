-- Recent contains pot-level data. Apply the experiment's current visibility,
-- including when the recipient's project access is narrowed after delivery.
create policy "pot notifications follow experiment visibility" on public.notification_outbox
as restrictive for select to authenticated using (
  event_type <> 'pot_moisture' or exists (
    select 1 from public.experiments e where e.project_id = notification_outbox.project_id
      and e.id = (notification_outbox.metadata->>'experiment_id')::uuid
  )
);

-- Collect each crossing once. Filter by the time that each recipient enrolled
-- before grouping the eligible crossings into one message per channel.
create or replace function public.evaluate_moisture_alerts() returns void
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  rule record;
  pot record;
  sample record;
  prior public.moisture_alert_state%rowtype;
  side_now smallint;
  fresh_after timestamptz;
  lines text[];
  times timestamptz[];
  alarms boolean[];
  pairs text[];
  audience record;
  event record;
  line text;
  title text;
  range_text text;
  base_link text;
  link text;
begin
  if not pg_try_advisory_xact_lock(hashtext('evaluate_moisture_alerts')) then return; end if;

  for rule in
    select r.*, e.project_id, e.slug, e.name, e.current_revision_id
    from public.moisture_alert_rules r join public.experiments e on e.id = r.experiment_id
    where r.enabled and e.status in ('active', 'published_sensing')
  loop
    lines := '{}'; times := '{}'; alarms := '{}'; pairs := '{}';
    for pot in
      select * from public.experiment_assignments where revision_id = rule.current_revision_id
      order by pot_number, pairing_name
    loop
      select * into prior from public.moisture_alert_state
      where experiment_id = rule.experiment_id and pairing_name = pot.pairing_name;
      if prior.revision_id is distinct from rule.current_revision_id or prior.rule_at is distinct from rule.updated_at then
        prior.observed_at := greatest(rule.updated_at, pot.created_at);
        prior.side := 0;
      end if;
      fresh_after := now() - greatest(interval '10 minutes', interval '3 minutes' *
        coalesce(pot.measurement_interval_minutes, pot.source_measurement_interval_ms / 60000.0, 5));
      for sample in
        select distinct on (s.device_recorded_at) s.device_recorded_at as at, s.calibrated_value as v
        from public.sensor_readings s
        where s.project_id = rule.project_id and s.device_id = rule.device_id
          and s.pairing_name = pot.pairing_name and s.sensor_key = pot.sensor_key_snapshot
          and s.device_recorded_at > greatest(prior.observed_at, fresh_after) and s.device_recorded_at <= now()
          and s.unit = 'vwc_pct' and s.calibrated_value between 0 and 100
        order by s.device_recorded_at, s.id desc
      loop
        side_now := case when sample.v < rule.minimum then -1 when sample.v > rule.maximum then 1 else 0 end;
        if side_now <> prior.side then
          line := case when side_now = 0 then format('Pot %s returned to range at %s%% VWC', pot.pot_number, round(sample.v::numeric, 1))
            else format('Pot %s %s%% VWC (%s)', pot.pot_number, round(sample.v::numeric, 1), case when side_now < 0 then 'low' else 'high' end)
          end;
          lines := array_append(lines, line);
          times := array_append(times, sample.at);
          alarms := array_append(alarms, side_now <> 0);
          pairs := array_append(pairs, pot.pairing_name);
        end if;
        prior.side := side_now;
        prior.observed_at := sample.at;
      end loop;
      if found then
        insert into public.moisture_alert_state(experiment_id, pairing_name, revision_id, rule_at, observed_at, side)
        values(rule.experiment_id, pot.pairing_name, rule.current_revision_id, rule.updated_at, prior.observed_at, prior.side)
        on conflict(experiment_id, pairing_name) do update set revision_id = excluded.revision_id,
          rule_at = excluded.rule_at, observed_at = excluded.observed_at, side = excluded.side;
      end if;
    end loop;
    if cardinality(lines) = 0 then continue; end if;

    range_text := format('. Range %s–%s%% VWC.', rule.minimum, rule.maximum);
    base_link := '/portal?project=' || rule.project_id || '&experiment=' || rule.slug;
    for audience in
      with subscriptions as (
        select f.user_id, f.since as phone_since, null::timestamptz as email_since, null::text as email
        from public.moisture_alert_followers f where f.experiment_id = rule.experiment_id
        union all
        select p.user_id, null, p.updated_at, u.email::text
        from public.notification_preferences p join auth.users u on u.id = p.user_id
        where p.project_id = rule.project_id and p.channel = 'email' and p.enabled
          and 'pot_moisture' = any(p.event_types) and u.email_confirmed_at is not null
          and lower(p.destination) = lower(u.email)
      )
      select user_id, max(phone_since) as phone_since, max(email_since) as email_since, max(email) as email
      from subscriptions where public.can_receive_moisture_alert(rule.experiment_id, user_id)
      group by user_id
    loop
      for event in
        select alarm, string_agg(message, ', ' order by i) as portal_lines,
          string_agg(message, ', ' order by i) filter (where at >= audience.phone_since) as phone_lines,
          bool_or(alarm and at >= audience.email_since) as send_email,
          case when count(*) = 1 then min(pair) end as only_pair
        from unnest(lines, times, alarms, pairs) with ordinality as c(message, at, alarm, pair, i)
        where at >= audience.phone_since or (alarm and at >= audience.email_since)
        group by alarm
      loop
        title := left(rule.name || case when event.alarm then ' · Moisture alert' else ' · Back in range' end, 200);
        link := base_link;
        if event.only_pair ~ '^[A-Za-z0-9._~-]+$' then link := link || '&pot=' || event.only_pair; end if;
        insert into public.notification_outbox(project_id, user_id, event_type, channel, subject, body, status, metadata)
        values(rule.project_id, audience.user_id, 'pot_moisture', 'portal', title, left(event.portal_lines || range_text, 8000),
               'delivered', jsonb_build_object('experiment_id', rule.experiment_id, 'url', link));
        if event.send_email then
          insert into public.notification_outbox(project_id, user_id, event_type, channel, destination, subject, body, metadata)
          values(rule.project_id, audience.user_id, 'pot_moisture', 'email', audience.email, 'ExactH2O pot moisture alert',
            E'A pot in a monitored experiment went outside its moisture range. Sign in and select your project to see pot numbers and readings under Account & access → Recent.\n\nhttps://exacth2o.com/portal?view=account',
            jsonb_build_object('experiment_id', rule.experiment_id));
        end if;
        if event.alarm and event.phone_lines is not null then
          insert into public.moisture_alert_queue(user_id, experiment_id, title, body, link)
          values(audience.user_id, rule.experiment_id, title, left(event.phone_lines || range_text, 650), link);
        end if;
      end loop;
    end loop;
  end loop;
end $$;

-- Re-enrollment applies to future crossings, including when a previous message is still queued.
create or replace function public.email_notification_allowed(notification_id uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.notification_outbox n
    join public.portal_access a on a.project_id = n.project_id and a.user_id = n.user_id
    where n.id = notification_id and n.channel = 'email'
      and (n.event_type = 'test_email' or exists (
        select 1 from public.notification_preferences p where p.project_id = n.project_id
          and p.user_id = n.user_id and p.channel = 'email' and p.enabled
          and (n.event_type <> 'pot_moisture' or p.updated_at <= n.created_at)
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
