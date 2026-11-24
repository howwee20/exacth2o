-- Cloud-only moisture alerts. Sensor ingestion and controller services are independent.
create table public.moisture_alert_rules (
  experiment_id uuid primary key references public.experiments on delete cascade,
  device_id text not null references public.devices(id),
  minimum numeric not null check (minimum >= 0),
  maximum numeric not null check (maximum <= 100 and maximum > minimum),
  enabled boolean not null,
  updated_at timestamptz not null default now()
);
create table public.moisture_alert_followers (
  experiment_id uuid references public.experiments on delete cascade,
  user_id uuid references auth.users on delete cascade,
  since timestamptz not null default now(),
  primary key (experiment_id, user_id)
);
-- A single destination per account makes the daily cap apply across devices and experiments.
create table public.moisture_alert_phones (
  user_id uuid primary key references auth.users on delete cascade,
  endpoint text not null unique, keys jsonb not null,
  registered_at timestamptz not null default now(), tested_at timestamptz
);
create table public.moisture_alert_state (
  experiment_id uuid references public.experiments on delete cascade,
  pairing_name text, revision_id uuid not null, rule_at timestamptz not null,
  observed_at timestamptz not null, side smallint not null,
  primary key (experiment_id, pairing_name)
);
create table public.moisture_alert_queue (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users on delete cascade,
  experiment_id uuid references public.experiments on delete cascade, title text not null, body text not null,
  link text not null, created_at timestamptz not null default now(), reserved_at timestamptz,
  due_at timestamptz not null default now(), attempts integer not null default 0,
  status text not null default 'pending' check (status in ('pending','sending','sent','capped','failed','canceled'))
);
create index moisture_alert_queue_due on public.moisture_alert_queue(due_at) where status in ('pending','sending');
create index moisture_alert_queue_budget on public.moisture_alert_queue(user_id,reserved_at) where reserved_at is not null;
alter table public.moisture_alert_rules enable row level security;
alter table public.moisture_alert_followers enable row level security;
alter table public.moisture_alert_phones enable row level security;
alter table public.moisture_alert_state enable row level security;
alter table public.moisture_alert_queue enable row level security;
revoke all on public.moisture_alert_rules, public.moisture_alert_followers, public.moisture_alert_phones,
  public.moisture_alert_state, public.moisture_alert_queue from public, anon, authenticated;
grant select,insert,update,delete on public.moisture_alert_rules, public.moisture_alert_followers, public.moisture_alert_phones,
  public.moisture_alert_state, public.moisture_alert_queue to service_role;

create function public.can_receive_moisture_alert(eid uuid, uid uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists(select 1 from public.experiments e join public.portal_access p on p.project_id=e.project_id
    where e.id=eid and p.user_id=uid and p.access_scope='project'
      and (p.role='admin' or p.role=any(e.visible_to_roles)))
$$;
revoke all on function public.can_receive_moisture_alert(uuid,uuid) from public, anon, authenticated;

create function public.experiment_moisture_alerts(eid uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not public.can_receive_moisture_alert(eid, auth.uid()) then raise exception 'Experiment access required'; end if;
  return jsonb_build_object(
    'rule',(select jsonb_build_object('min',minimum,'max',maximum,'enabled',enabled,'version',updated_at)
      from public.moisture_alert_rules where experiment_id=eid),
    'following',exists(select 1 from public.moisture_alert_followers where experiment_id=eid and user_id=auth.uid()));
end $$;

create function public.save_experiment_moisture_alerts(eid uuid, device text, write_rule boolean, active boolean,
  low numeric, high numeric, expected_version timestamptz, follow boolean) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare ex public.experiments%rowtype; existing public.moisture_alert_rules%rowtype;
begin
  if not public.can_receive_moisture_alert(eid,auth.uid()) then raise exception 'Experiment access required'; end if;
  select * into ex from public.experiments where id=eid for update;
  if ex.status in ('archived','completed') then raise exception 'Experiment has ended'; end if;
  select * into existing from public.moisture_alert_rules where experiment_id=eid;
  if write_rule then
    if not exists(select 1 from public.portal_access p where p.user_id=auth.uid() and p.project_id=ex.project_id
      and p.access_scope='project' and p.role in ('researcher','admin')) then raise exception 'Researcher access required'; end if;
    if not exists(select 1 from public.devices d where d.id=device and d.project_id=ex.project_id) then raise exception 'Unknown device'; end if;
    if low is null or high is null or not (0 <= low and low < high and high <= 100) then raise exception 'Enter a valid VWC range'; end if;
    if existing.updated_at is distinct from expected_version
       and (existing.minimum,existing.maximum,existing.enabled,existing.device_id) is distinct from (low,high,active,device)
       then raise exception 'Alert settings changed. Reopen the experiment to reload.'; end if;
    insert into public.moisture_alert_rules as r(experiment_id,device_id,minimum,maximum,enabled)
      values(eid,device,low,high,active)
      on conflict(experiment_id) do update set device_id=excluded.device_id,minimum=excluded.minimum,maximum=excluded.maximum,
        enabled=excluded.enabled, updated_at=now()
      where (r.minimum,r.maximum,r.enabled,r.device_id) is distinct from (low,high,active,device);
  end if;
  if follow then
    if not exists(select 1 from public.moisture_alert_phones where user_id=auth.uid()) then raise exception 'Connect your phone first'; end if;
    insert into public.moisture_alert_followers(experiment_id,user_id) values(eid,auth.uid()) on conflict do nothing;
  elsif follow is false then
    delete from public.moisture_alert_followers where experiment_id=eid and user_id=auth.uid();
  end if;
  return public.experiment_moisture_alerts(eid);
end $$;
revoke all on function public.experiment_moisture_alerts(uuid),public.save_experiment_moisture_alerts(uuid,text,boolean,boolean,numeric,numeric,timestamptz,boolean) from public,anon;
grant execute on function public.experiment_moisture_alerts(uuid),public.save_experiment_moisture_alerts(uuid,text,boolean,boolean,numeric,numeric,timestamptz,boolean) to authenticated;

create function public.evaluate_moisture_alerts() returns void
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
      for recipient in select f.user_id from public.moisture_alert_followers f where f.experiment_id=rule.experiment_id
        and f.since<=newest and public.can_receive_moisture_alert(rule.experiment_id,f.user_id)
      loop
        insert into public.notification_outbox(project_id,user_id,event_type,channel,subject,body,status,metadata)
          values(rule.project_id,recipient.user_id,'pot_moisture','portal',title,left(details,8000),'delivered',jsonb_build_object('experiment_id',rule.experiment_id,'url',link));
        if item.is_alarm then
          insert into public.moisture_alert_queue(user_id,experiment_id,title,body,link)
            values(recipient.user_id,rule.experiment_id,title,left(details,650),link);
        end if;
      end loop;
    end loop;
  end loop;
end $$;
revoke all on function public.evaluate_moisture_alerts() from public,anon,authenticated;

-- Reserve one of ten pushes per account per rolling 24 hours, including test sends.
-- Leases allow a failed delivery worker to resume without consuming another slot.
create function public.claim_moisture_push(only_id uuid default null) returns setof public.moisture_alert_queue
language plpgsql security definer set search_path = public, pg_temp as $$
declare job public.moisture_alert_queue%rowtype;
begin
  for job in select * from public.moisture_alert_queue q where q.status in ('pending','sending') and q.due_at<=now()
    and (only_id is null or q.id=only_id) order by q.created_at,q.id limit 20 for update skip locked loop
    perform pg_advisory_xact_lock(hashtext('moisture-push'),hashtext(job.user_id::text));
    if job.attempts>=4 or job.created_at<now()-interval '20 minutes'
      or not exists(select 1 from public.moisture_alert_phones where user_id=job.user_id)
      or (job.experiment_id is not null and not exists(select 1 from public.moisture_alert_followers f
        join public.moisture_alert_rules r using(experiment_id) join public.experiments e on e.id=r.experiment_id
        where f.experiment_id=job.experiment_id and f.user_id=job.user_id and f.since<=job.created_at and r.enabled
        and r.updated_at<=job.created_at and e.status in ('active','published_sensing') and public.can_receive_moisture_alert(e.id,f.user_id))) then
      update public.moisture_alert_queue set status='canceled' where id=job.id;
    elsif job.reserved_at is null and (select count(*) from public.moisture_alert_queue where user_id=job.user_id
      and reserved_at>now()-interval '24 hours')>=10 then
      update public.moisture_alert_queue set status='capped' where id=job.id;
    else
      update public.moisture_alert_queue set status='sending',attempts=attempts+1,
        reserved_at=coalesce(reserved_at,now()),due_at=now()+interval '3 minutes' where id=job.id returning * into job;
      return next job;
    end if;
  end loop;
end $$;
create function public.test_moisture_push(uid uuid) returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare job_id uuid;
begin
  update public.moisture_alert_phones set tested_at=now() where user_id=uid and (tested_at is null or tested_at<now()-interval '1 minute');
  if not found then raise exception 'Connect your phone or wait a minute before testing again'; end if;
  insert into public.moisture_alert_queue(user_id,title,body,link)
    values(uid,'ExactH2O test alert','This phone is ready for experiment moisture alerts.','/portal') returning id into job_id;
  return job_id;
end $$;
revoke all on function public.claim_moisture_push(uuid),public.test_moisture_push(uuid) from public,anon,authenticated;
grant execute on function public.claim_moisture_push(uuid),public.test_moisture_push(uuid) to service_role;

create function public.run_moisture_alerts() returns void language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare secret text;
begin
  perform public.evaluate_moisture_alerts();
  if exists(select 1 from public.moisture_alert_queue where status in ('pending','sending') and due_at<=now()) then
    select decrypted_secret into secret from vault.decrypted_secrets where name='exacth2o_owner_health_cron_secret' limit 1;
    if length(secret)>=32 then
      perform net.http_post(url:='https://zmhdclcjrkntrpynozvo.supabase.co/functions/v1/phone-alerts',
        headers:=jsonb_build_object('Content-Type','application/json','x-phone-alert-cron',secret),
        body:='{"action":"dispatch"}'::jsonb, timeout_milliseconds:=25000);
    end if;
  end if;
  delete from public.moisture_alert_queue where created_at<now()-interval '7 days';
end $$;
revoke all on function public.run_moisture_alerts() from public,anon,authenticated;
select cron.schedule('experiment-moisture-alerts','*/2 * * * *','select public.run_moisture_alerts()');
