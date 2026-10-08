-- Bring the synthetic installation back to "everything reporting": restore hidden readings,
-- shift every synthetic timestamp so the newest reading is now, mark the controller present,
-- and put the controller targets back to the plan. Local test database only.
create schema if not exists product_local;
create table if not exists product_local.hidden_readings (like public.sensor_readings);

insert into public.sensor_readings select * from product_local.hidden_readings on conflict (event_id) do nothing;
delete from product_local.hidden_readings;

do $$
declare
  shift interval;
begin
  select date_trunc('minute', now()) - max(device_recorded_at) into shift
  from public.sensor_readings where project_id = '22222222-2222-4222-8222-222222222222';
  if shift is null or shift < interval '1 minute' then return; end if;
  update public.sensor_readings set device_recorded_at = device_recorded_at + shift, server_received_at = server_received_at + shift
    where project_id = '22222222-2222-4222-8222-222222222222';
  update public.valve_events set device_recorded_at = device_recorded_at + shift, server_received_at = server_received_at + shift
    where project_id = '22222222-2222-4222-8222-222222222222';
  update public.experiments set started_at = started_at + shift, ended_at = ended_at + shift, created_at = created_at + shift
    where project_id = '22222222-2222-4222-8222-222222222222';
  update public.experiment_revisions set created_at = created_at + shift where project_id = '22222222-2222-4222-8222-222222222222';
  update public.experiment_audit_events set created_at = created_at + shift where project_id = '22222222-2222-4222-8222-222222222222';
  update public.project_control_commands
    set requested_at = requested_at + shift, expires_at = expires_at + shift, confirmed_at = confirmed_at + shift,
        started_at = started_at + shift, completed_at = completed_at + shift
    where project_id = '22222222-2222-4222-8222-222222222222' and id::text like 'c0000000-0000-4000-8000-%';
end;
$$;

update public.device_config_state
set pairings = (
  select jsonb_agg(case
    when (pairing ->> 'name') ~ '^Zone[1-4]-Pot' then jsonb_set(pairing, '{WTCPercentLimit}',
      to_jsonb(case when (regexp_replace(pairing ->> 'name', '^.*Pot', ''))::int % 2 = 1 then 34 else 22 end))
    else pairing end order by (pairing ->> 'sensorId')::int)
  from jsonb_array_elements(pairings) as pairing
), updated_at = now()
where project_id = '22222222-2222-4222-8222-222222222222';

update public.device_runtime_state
set controller_state = 'RUNNING', state_observed_at = now(), state_fresh_until = now() + interval '10 minutes', updated_at = now()
where project_id = '22222222-2222-4222-8222-222222222222';
update public.latest_device_state set last_seen_at = now(), updated_at = now() where project_id = '22222222-2222-4222-8222-222222222222';
