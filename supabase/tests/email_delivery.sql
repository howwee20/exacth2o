begin;
do $$
declare
  uid uuid := gen_random_uuid();
  job uuid;
  project uuid := '22222222-2222-4222-8222-222222222222';
  claimed public.notification_outbox%rowtype;
  attempts integer;
begin
  if has_function_privilege('authenticated','public.finish_notification_delivery(uuid,integer,text,text,text)','execute')
    or has_function_privilege('anon','public.finish_notification_delivery(uuid,integer,text,text,text)','execute')
    or not has_function_privilege('service_role','public.finish_notification_delivery(uuid,integer,text,text,text)','execute')
  then raise exception 'Unexpected email worker permissions'; end if;
  insert into auth.users(id,email) values(uid,'worker@example.invalid');
  insert into public.notification_outbox(project_id,user_id,channel,event_type,subject,body,created_at)
    values(project,uid,'email','test_email','Worker test','Synthetic mail',now()-interval '1 week') returning id into job;
  perform set_config('request.jwt.claim.role','service_role',true);
  select * into strict claimed from public.claim_notification_outbox() where id=job;
  if claimed.attempt_count <> 1 or claimed.first_attempt_at is distinct from now() then
    raise exception 'Untouched backlog lost its retry window'; end if;
  if public.finish_notification_delivery(job,1,'retry',null,'Timeout') is distinct from 'pending' then raise exception 'Retry failed'; end if;
  if not exists(select 1 from public.notification_outbox where id=job and next_attempt_at=now()+interval '1 minute')
  then raise exception 'First retry was not scheduled'; end if;
  update public.notification_outbox set next_attempt_at=now() where id=job;
  perform public.claim_notification_outbox();
  update public.notification_outbox set lease_until=now()-interval '1 second' where id=job;
  perform public.claim_notification_outbox();
  if public.finish_notification_delivery(job,2,'retry',null,'Old lease') is not null then raise exception 'Stale lease won'; end if;
  begin
    perform public.finish_notification_delivery(job,3,'accepted',' ');
    raise exception 'Missing provider receipt accepted';
  exception when raise_exception then if sqlerrm <> 'Invalid email delivery outcome' then raise; end if; end;
  if public.finish_notification_delivery(job,3,'accepted','receipt') is distinct from 'delivered' then raise exception 'Missing acceptance'; end if;
  if public.finish_notification_delivery(job,3,'accepted','receipt') is not null
  then raise exception 'Duplicate acceptance'; end if;
  select count(*) into attempts from public.notification_delivery_attempts where notification_id=job;
  if attempts<>2 or not exists(select 1 from public.notification_outbox where id=job and provider_id='receipt'
    and delivered_at is not null and lease_until is null) then raise exception 'Inconsistent delivery audit'; end if;

  update public.notification_outbox set status='sending', first_attempt_at=now()-interval '22 hours 59 minutes' where id=job;
  if public.finish_notification_delivery(job,3,'retry',null,'Ambiguous outcome') is distinct from 'failed'
  then raise exception 'Retry would exceed provider deduplication window'; end if;
  update public.notification_outbox set status='sending', first_attempt_at=now()-interval '2 days', lease_until=now()-interval '1 minute' where id=job;
  if exists(select 1 from public.claim_notification_outbox() where id=job) then raise exception 'Expired lease was reclaimed'; end if;
  if not exists(select 1 from public.notification_outbox where id=job and status='failed')
  then raise exception 'Abandoned delivery remained pending outside provider window'; end if;

  update public.notification_outbox set status='sending', attempt_count=20, first_attempt_at=now() where id=job;
  if public.finish_notification_delivery(job,20,'retry',null,'Temporary failure') is distinct from 'failed'
  then raise exception 'Last attempt should be terminal'; end if;
  update public.notification_outbox set status='sending', attempt_count=1, first_attempt_at=now() where id=job;
  if public.finish_notification_delivery(job,1,'canceled',null,'Subscription ended') is distinct from 'canceled'
  then raise exception 'Canceled subscription was retried'; end if;
end $$;
rollback;
