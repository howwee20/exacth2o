begin;
do $$
declare
  eid uuid:=gen_random_uuid(); rev uuid:=gen_random_uuid(); uid uuid:=gen_random_uuid();
  email_uid uuid:=gen_random_uuid(); email_job uuid; test_job uuid;
  d public.devices%rowtype; qty integer; ev record;
begin
  insert into public.devices(id,organization_id,project_id,name) select 'phone-alert-fixture',organization_id,id,'Phone alert test' from public.projects where id='22222222-2222-4222-8222-222222222222' returning * into strict d;
  insert into auth.users(id,email) values(uid,'phone-alert-test@example.invalid');
  insert into public.portal_access(project_id,user_id,email,role,access_scope) values(d.project_id,uid,'phone-alert-test@example.invalid','researcher','project');
  insert into public.experiments(id,project_id,slug,name,mode,status,created_by,current_revision_id) values(eid,d.project_id,'phone-alert-test','Alert test','observation','published_sensing',uid,rev);
  insert into public.experiment_revisions(id,experiment_id,project_id,version,source,spec) values(rev,eid,d.project_id,1,'manual','{}');
  insert into public.experiment_assignments(revision_id,experiment_id,project_id,pairing_name,zone,pot_number,sensor_key_snapshot,valve_key_snapshot,created_at)
    select rev,eid,d.project_id,'alert-pot-'||n,1,n,'probe-'||n,'v-'||n,now()-interval '30 minutes' from generate_series(1,3)n;
  if not has_column_privilege('service_role','public.notification_outbox','id','select')
    or not has_column_privilege('service_role','public.notification_outbox','status','select')
    or not has_column_privilege('service_role','public.notification_outbox','attempt_count','select') then
    raise exception 'Email worker cannot filter its status updates'; end if;
  if has_function_privilege('authenticated','public.claim_moisture_push(uuid)','execute') then raise exception 'User can dispatch'; end if;
  perform set_config('request.jwt.claim.sub',uid::text,true);
  insert into public.moisture_alert_phones (user_id,endpoint,keys) values(uid,'https://example.invalid/never-send','{}');
  perform public.save_experiment_moisture_alerts(eid,d.id,true,true,20,40,null,true);
  update public.moisture_alert_rules set updated_at=now()-interval '12 minutes' where experiment_id=eid;
  update public.moisture_alert_followers set since=now()-interval '12 minutes' where experiment_id=eid;
  -- A confirmed email-only researcher gets the same crossings without registering a phone.
  insert into auth.users(id,email,email_confirmed_at) values(email_uid,'email-alert-test@example.invalid',now());
  insert into public.portal_access(project_id,user_id,email,role,access_scope)
    values(d.project_id,email_uid,'email-alert-test@example.invalid','researcher','project');
  perform set_config('request.jwt.claim.sub',email_uid::text,true);
  perform public.set_notification_preference(d.project_id,'email',true,'email-alert-test@example.invalid',array['pot_moisture']);
  update public.notification_preferences set updated_at=now()-interval '12 minutes' where user_id=email_uid;
  test_job:=public.request_alert_test_email(d.project_id);
  if not exists(select 1 from public.notification_outbox where id=test_job and event_type='test_email'
    and user_id=email_uid and destination='email-alert-test@example.invalid' and public.email_notification_allowed(id))
    then raise exception 'Confirmed-account test email missing'; end if;
  begin
    perform public.request_alert_test_email(d.project_id);
    raise exception 'Repeated test unexpectedly queued';
  exception when raise_exception then if sqlerrm not like 'A test was requested%' then raise; end if; end;
  -- Edges are inclusive; stale samples and mismatched probe identities are ignored.
  for ev in select * from (values(1,20,4,'probe-1'),(1,40,3,'probe-1'),(2,11,20,'probe-2'),(3,10,2,'wrong'))s(pot,v,age,probe)
  loop
    insert into public.sensor_readings(event_id,organization_id,project_id,device_id,pairing_name,sensor_key,device_recorded_at,calibrated_value)
      values(gen_random_uuid()::text,d.organization_id,d.project_id,d.id,'alert-pot-'||ev.pot,ev.probe,now()-ev.age*interval '1 minute',ev.v);
  end loop;
  perform public.evaluate_moisture_alerts();
  if exists(select 1 from public.moisture_alert_queue where user_id=uid) then raise exception 'False alarm'; end if;
  for ev in select * from (values(1,19,2),(1,18,1),(2,42,1))s(pot,v,age) loop
    insert into public.sensor_readings(event_id,organization_id,project_id,device_id,pairing_name,sensor_key,device_recorded_at,calibrated_value)
      values(gen_random_uuid()::text,d.organization_id,d.project_id,d.id,'alert-pot-'||ev.pot,'probe-'||ev.pot,now()-ev.age*interval '1 minute',ev.v);
  end loop;
  perform public.evaluate_moisture_alerts(); perform public.evaluate_moisture_alerts();
  select count(*) into qty from public.moisture_alert_queue where user_id=uid;
  if qty<>1 or not exists(select 1 from public.moisture_alert_queue where user_id=uid and body like '%Pot 1%' and body like '%Pot 2%') then raise exception 'Grouped crossings/duplicate prevention failed'; end if;
  select id into strict email_job from public.notification_outbox where user_id=email_uid and event_type='pot_moisture' and channel='email';
  if not public.email_notification_allowed(email_job)
    or exists(select 1 from public.notification_outbox where id=email_job and (body like '%probe-%' or body like '%Pot 1%' or body like '%VWC%' or body like '%Alert test%'))
    or exists(select 1 from public.moisture_alert_queue where user_id=email_uid)
    or not exists(select 1 from public.notification_outbox where user_id=email_uid and channel='portal' and body like '%Pot 1%' and body like '%Pot 2%')
    then raise exception 'Email-only alert privacy or delivery failed'; end if;
  if exists(select 1 from public.notification_outbox where user_id=uid and channel='email') then raise exception 'Unsubscribed phone user emailed'; end if;
  update public.notification_preferences set enabled=false where user_id=email_uid;
  if public.email_notification_allowed(email_job) then raise exception 'Unsubscribe did not cancel delivery'; end if;
  update public.notification_preferences set enabled=true where user_id=email_uid;
  delete from public.portal_access where user_id=email_uid and project_id=d.project_id;
  if public.email_notification_allowed(email_job) or public.email_notification_allowed(test_job) then raise exception 'Lost access still allowed email'; end if;
  insert into public.sensor_readings(event_id,organization_id,project_id,device_id,pairing_name,sensor_key,device_recorded_at,calibrated_value)
    values(gen_random_uuid()::text,d.organization_id,d.project_id,d.id,'alert-pot-1','probe-1',now(),22);
  perform public.evaluate_moisture_alerts();
  if not exists(select 1 from public.notification_outbox where user_id=uid and subject like '%Back in range%') then raise exception 'Recovery missing'; end if;
  insert into public.moisture_alert_queue(user_id,title,body,link)
    select uid,'Test','Test','/portal' from generate_series(1,10);
  select count(*) into qty from public.claim_moisture_push();
  if qty<>11 then raise exception 'Every notification should be claimed, got %',qty; end if;
  perform public.test_moisture_push(uid); perform public.test_moisture_push(uid);
  select count(*) into qty from public.claim_moisture_push();
  if qty<>2 then raise exception 'Test notifications were unexpectedly throttled'; end if;
  perform set_config('request.jwt.claim.sub',gen_random_uuid()::text,true);
  begin
    perform public.request_alert_test_email(d.project_id);
    raise exception 'Outsider requested email';
  exception when raise_exception then if sqlerrm not like 'Sign in to this project%' then raise; end if; end;
  begin
    perform public.experiment_moisture_alerts(eid);
    raise exception 'Outsider read a rule';
  exception when raise_exception then if sqlerrm<>'Experiment access required' then raise; end if; end;
  begin
    perform public.save_experiment_moisture_alerts(eid,d.id,true,true,10,50,null,null);
    raise exception 'Outsider changed a rule';
  exception when raise_exception then if sqlerrm<>'Experiment access required' then raise; end if; end;
end $$;
rollback;
