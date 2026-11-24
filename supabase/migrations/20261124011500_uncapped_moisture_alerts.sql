-- The worker claims small batches, with no per-account delivery quota or test cooldown.
create or replace function public.claim_moisture_push(only_id uuid default null) returns setof public.moisture_alert_queue
language plpgsql security definer set search_path = public, pg_temp as $$
declare job public.moisture_alert_queue%rowtype;
begin
  for job in select * from public.moisture_alert_queue q where q.status in ('pending','sending') and q.due_at<=now()
    and (only_id is null or q.id=only_id) order by q.created_at,q.id limit 20 for update skip locked loop
    if not exists(select 1 from public.moisture_alert_phones where user_id=job.user_id)
      or (job.experiment_id is not null and not exists(select 1 from public.moisture_alert_followers f
        join public.moisture_alert_rules r using(experiment_id) join public.experiments e on e.id=r.experiment_id
        where f.experiment_id=job.experiment_id and f.user_id=job.user_id and f.since<=job.created_at and r.enabled
        and r.updated_at<=job.created_at and e.status in ('active','published_sensing') and public.can_receive_moisture_alert(e.id,f.user_id))) then
      update public.moisture_alert_queue set status='canceled' where id=job.id;
    elsif job.attempts>=4 then
      update public.moisture_alert_queue set status='failed' where id=job.id;
    else
      update public.moisture_alert_queue set status='sending',attempts=attempts+1,
        reserved_at=coalesce(reserved_at,now()),due_at=now()+interval '3 minutes' where id=job.id returning * into job;
      return next job;
    end if;
  end loop;
end $$;
create or replace function public.test_moisture_push(uid uuid) returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare job_id uuid;
begin
  update public.moisture_alert_phones set tested_at=now() where user_id=uid;
  if not found then raise exception 'Connect your phone first'; end if;
  insert into public.moisture_alert_queue(user_id,title,body,link)
    values(uid,'ExactH2O test alert','This phone is ready for experiment moisture alerts.','/portal') returning id into job_id;
  return job_id;
end $$;

drop index if exists public.moisture_alert_queue_budget;
update public.moisture_alert_queue set status='pending',due_at=now() where status='capped';
alter table public.moisture_alert_queue drop constraint moisture_alert_queue_status_check;
alter table public.moisture_alert_queue add constraint moisture_alert_queue_status_check
  check (status in ('pending','sending','sent','failed','canceled'));
