-- Valve routes for physical pots 1-100 that have no sensor pairing, confirmed by a project
-- admin. Paired pots keep using their live controller pairing. Nothing here changes a pairing,
-- a moisture target, a schedule or any other controller setting.
create table public.manual_valve_routes (
  project_id uuid not null,
  device_id text not null,
  pot_number integer not null check (pot_number between 1 and 100),
  relay_address integer not null check (relay_address between 3 and 127),
  channel integer not null check (channel between 1 and 48),
  note text not null default '' check (char_length(note) <= 280),
  confirmed_by uuid references auth.users(id) on delete set null,
  confirmed_at timestamptz not null default now(),
  primary key (project_id, device_id, pot_number),
  unique (project_id, device_id, relay_address, channel)
);
alter table public.manual_valve_routes enable row level security;
revoke all on table public.manual_valve_routes from public, anon, authenticated;
grant select on table public.manual_valve_routes to service_role;
comment on table public.manual_valve_routes is
  'Admin-confirmed valve routes for unpaired physical pots. Written only through confirm_/remove_manual_valve_route.';

-- Pot number of a controller pairing named like Zone3-Pot18; null for any other name.
create function public.pairing_pot_number(pairing_name text)
returns integer language sql immutable set search_path=public as $$
  select (regexp_match(pairing_name, '^Zone[0-9]+-Pot([0-9]{1,3})$', 'i'))[1]::integer
$$;
revoke all on function public.pairing_pot_number(text) from public, anon, authenticated;
grant execute on function public.pairing_pot_number(text) to service_role;

create function public.confirm_manual_valve_route(
  route_project_id uuid, route_device_id text, actor uuid,
  route_pot_number integer, route_relay_address integer, route_channel integer, route_note text default ''
) returns public.manual_valve_routes
language plpgsql security definer set search_path=public as $$
declare
  config public.device_config_state%rowtype;
  claimant text;
  saved public.manual_valve_routes%rowtype;
begin
  if not exists (select 1 from public.portal_access where project_id=route_project_id and user_id=actor
                 and access_scope='project' and role='admin') then
    raise exception 'Project admin access is required to confirm valve routes' using errcode='42501';
  end if;
  if route_pot_number is null or route_pot_number not between 1 and 100 then
    raise exception 'Pot number must be between 1 and 100' using errcode='22023';
  end if;
  if route_channel is null or route_channel not between 1 and 48 then
    raise exception 'Valve channel must be between 1 and 48' using errcode='22023';
  end if;
  select * into config from public.device_config_state where project_id=route_project_id and device_id=route_device_id;
  if not found then raise exception 'Controller configuration is unavailable' using errcode='P0002'; end if;
  if not exists (select 1 from jsonb_array_elements(coalesce(config.board_config,'[]'::jsonb)) board
                 where (board->>'address')::integer=route_relay_address) then
    raise exception 'Relay board % is not configured on this controller', route_relay_address using errcode='22023';
  end if;
  -- A paired pot is watered through its pairing; a pairing's valve belongs to that pairing.
  select pairing->>'name' into claimant from jsonb_array_elements(coalesce(config.pairings,'[]'::jsonb)) pairing
    where public.pairing_pot_number(pairing->>'name')=route_pot_number limit 1;
  if claimant is not null then
    raise exception 'Pot % is paired as %; it uses that pairing''s valve', route_pot_number, claimant using errcode='23505';
  end if;
  select pairing->>'name' into claimant from jsonb_array_elements(coalesce(config.pairings,'[]'::jsonb)) pairing
    where lower(pairing->'Valve'->>'relayAddress') in (lower(format('0x%s',to_hex(route_relay_address))), route_relay_address::text)
      and (pairing->'Valve'->>'address')::integer=route_channel limit 1;
  if claimant is not null then
    raise exception 'That valve is already used by %', claimant using errcode='23505';
  end if;
  select format('pot %s', pot_number) into claimant from public.manual_valve_routes
    where project_id=route_project_id and device_id=route_device_id and relay_address=route_relay_address
      and channel=route_channel and pot_number<>route_pot_number;
  if claimant is not null then
    raise exception 'That valve is already confirmed for %', claimant using errcode='23505';
  end if;
  insert into public.manual_valve_routes(project_id,device_id,pot_number,relay_address,channel,note,confirmed_by,confirmed_at)
    values (route_project_id,route_device_id,route_pot_number,route_relay_address,route_channel,coalesce(left(route_note,280),''),actor,now())
    on conflict (project_id,device_id,pot_number) do update set relay_address=excluded.relay_address, channel=excluded.channel,
      note=excluded.note, confirmed_by=excluded.confirmed_by, confirmed_at=excluded.confirmed_at
    returning * into saved;
  insert into public.project_control_audit(project_id,device_id,action,actor_id,status,details)
    values (route_project_id,route_device_id,'manual_route_confirm',actor,'confirmed',
            jsonb_build_object('pot_number',route_pot_number,'relay_address',route_relay_address,'channel',route_channel,'note',saved.note));
  return saved;
end; $$;
revoke all on function public.confirm_manual_valve_route(uuid,text,uuid,integer,integer,integer,text) from public, anon, authenticated;
grant execute on function public.confirm_manual_valve_route(uuid,text,uuid,integer,integer,integer,text) to service_role;

create function public.remove_manual_valve_route(route_project_id uuid, route_device_id text, actor uuid, route_pot_number integer)
returns boolean language plpgsql security definer set search_path=public as $$
declare removed public.manual_valve_routes%rowtype;
begin
  if not exists (select 1 from public.portal_access where project_id=route_project_id and user_id=actor
                 and access_scope='project' and role='admin') then
    raise exception 'Project admin access is required to remove valve routes' using errcode='42501';
  end if;
  delete from public.manual_valve_routes where project_id=route_project_id and device_id=route_device_id and pot_number=route_pot_number
    returning * into removed;
  if not found then return false; end if;
  insert into public.project_control_audit(project_id,device_id,action,actor_id,status,details)
    values (route_project_id,route_device_id,'manual_route_remove',actor,'removed',
            jsonb_build_object('pot_number',route_pot_number,'relay_address',removed.relay_address,'channel',removed.channel));
  return true;
end; $$;
revoke all on function public.remove_manual_valve_route(uuid,text,uuid,integer) from public, anon, authenticated;
grant execute on function public.remove_manual_valve_route(uuid,text,uuid,integer) to service_role;
