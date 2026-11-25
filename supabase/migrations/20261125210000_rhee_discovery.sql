-- The run owns its evidence and progress. Only the authenticated Edge worker writes it.
create table public.rhee_discovery_runs (
 id uuid primary key, project_id uuid not null references public.projects(id), device_id text not null,
 owner_id uuid not null, status text not null check(status in ('running','review','applying','ready','closed','failed')),
 setup jsonb not null, progress jsonb not null, revision integer not null default 0,
 lease_until timestamptz, updated_at timestamptz not null default now(), created_at timestamptz not null default now()
);
create unique index rhee_one_discovery on public.rhee_discovery_runs(project_id,device_id) where status in ('running','review','applying','ready');
alter table public.rhee_discovery_runs enable row level security;
revoke all on public.rhee_discovery_runs from public,anon,authenticated;
grant all on public.rhee_discovery_runs to service_role;
-- A researcher can install the already-selected controller curve only in the verified discovery batch.
create or replace function public.assert_portal_command_access(project uuid, actor uuid, action text)
returns void language plpgsql security definer set search_path=public as $$
declare actor_portal_role text;
begin
 if not coalesce((select enabled from public.control_command_intake_settings where singleton),false) then
  raise exception 'Controller command intake is paused' using errcode='42501'; end if;
 select role into actor_portal_role from public.portal_access where project_id=project and user_id=actor and access_scope='project';
 if actor_portal_role is null or actor_portal_role not in ('admin','researcher') then
  raise exception 'Current project control access is required' using errcode='42501'; end if;
 if action in ('update_pairing','bulk_update_pairings','create_pairing','create_group','remove_group','remap_pairing_valves','restore_pairing_settings','manual_water','update_system_state','export_data') then return; end if;
 if action='apply_calibration' and auth.role()='service_role' and current_setting('exacth2o.discovery_actor',true)=actor::text then return; end if;
 if actor_portal_role='admin' and action in ('delete_pairing','create_calibration','delete_calibration','apply_calibration','update_board_config') then return; end if;
 raise exception 'This controller command is not permitted for the current role' using errcode='42501';
end $$;

create function public.apply_rhee_discovery_batch(run_id uuid, expected_revision integer, expected_hash text, restore_state text,
 batch_id uuid, commands jsonb) returns void language plpgsql security definer set search_path=public as $$
declare r public.rhee_discovery_runs; cmd jsonb; names text[]; matched jsonb; i integer; n text;
begin
 if auth.role() is distinct from 'service_role' then raise exception 'Service role required'; end if;
 select * into strict r from public.rhee_discovery_runs where id=run_id for update;
 if r.status<>'review' or r.revision<>expected_revision or r.lease_until is null or r.lease_until<now() then raise exception 'Review expired'; end if;
 if jsonb_array_length(commands)<4 or jsonb_array_length(commands)>22 then raise exception 'Invalid discovery batch'; end if;
 names:=array[]::text[];
 for i in 1..jsonb_array_length(commands)-3 loop
  cmd:=commands->i; n:=cmd#>>'{payload,name}';
  select value into strict matched from jsonb_array_elements(r.progress->'matches') where value->>'name'=n;
  if cmd->>'command_type' is distinct from 'create_pairing' or cmd#>>'{payload,sensor_key}' is distinct from matched->>'sensorKey'
   or cmd#>>'{payload,valve_key}' is distinct from matched->>'valveKey' or (cmd#>>'{payload,disable_watering}') is distinct from 'true'
   or n=any(names) then raise exception 'Pairing differs from discovery result'; end if;
  names:=array_append(names,n);
 end loop;
 cmd:=commands->(jsonb_array_length(commands)-2);
 if cmd->>'command_type' is distinct from 'apply_calibration' or cmd#>>'{payload,calibration_name}' is distinct from r.setup->>'curve'
  or cmd#>'{payload,pairing_names}' is distinct from to_jsonb(names) then raise exception 'Calibration differs from reviewed setup'; end if;
 perform set_config('exacth2o.discovery_actor',r.owner_id::text,true);
 perform public.enqueue_portal_control_command_batch(r.project_id,r.device_id,r.owner_id,batch_id,now()+interval '15 minutes',expected_hash,restore_state,commands);
 update public.rhee_discovery_runs set status='applying', progress=progress||jsonb_build_object('batch',batch_id,'message','Installing matched sensors and the soil curve.'),revision=revision+1,lease_until=null,updated_at=now() where id=run_id;
end $$;
revoke all on function public.apply_rhee_discovery_batch(uuid,integer,text,text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.apply_rhee_discovery_batch(uuid,integer,text,text,uuid,jsonb) to service_role;
