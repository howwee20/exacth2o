begin;
do $$
declare
  eid uuid:=gen_random_uuid(); rev uuid:=gen_random_uuid(); uid uuid:=gen_random_uuid();
  d public.devices%rowtype; qty integer; ev record;
begin
  insert into public.devices(id,organization_id,project_id,name) select 'phone-alert-fixture',organization_id,id,'Phone alert test' from public.projects where id='22222222-2222-4222-8222-222222222222' returning * into strict d;
  insert into auth.users(id,email) values(uid,'phone-alert-test@example.invalid');
  insert into public.portal_access(project_id,user_id,email,role,access_scope) values(d.project_id,uid,'phone-alert-test@example.invalid','researcher','project');
  insert into public.experiments(id,project_id,slug,name,mode,status,created_by,current_revision_id) values(eid,d.project_id,'phone-alert-test','Alert test','observation','published_sensing',uid,rev);
  insert into public.experiment_revisions(id,experiment_id,project_id,version,source,spec) values(rev,eid,d.project_id,1,'manual','{}');
  insert into public.experiment_assignments(revision_id,experiment_id,project_id,pairing_name,zone,pot_number,sensor_key_snapshot,valve_key_snapshot,created_at)
    select rev,eid,d.project_id,'alert-pot-'||n,1,n,'probe-'||n,'v-'||n,now()-interval '30 minutes' from generate_series(1,3)n;
  if has_function_privilege('authenticated','public.claim_moisture_push(uuid)','execute') then raise exception 'User can dispatch'; end if;
  perform set_config('request.jwt.claim.sub',uid::text,true);
  insert into public.moisture_alert_phones (user_id,endpoint,keys) values(uid,'https://example.invalid/never-send','{}');
  perform public.save_experiment_moisture_alerts(eid,d.id,true,true,20,40,null,true);
  update public.moisture_alert_rules set updated_at=now()-interval '12 minutes' where experiment_id=eid;
  update public.moisture_alert_followers set since=now()-interval '12 minutes' where experiment_id=eid;
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
    perform public.experiment_moisture_alerts(eid);
    raise exception 'Outsider read a rule';
  exception when raise_exception then if sqlerrm<>'Experiment access required' then raise; end if; end;
  begin
    perform public.save_experiment_moisture_alerts(eid,d.id,true,true,10,50,null,null);
    raise exception 'Outsider changed a rule';
  exception when raise_exception then if sqlerrm<>'Experiment access required' then raise; end if; end;
end $$;
rollback;
