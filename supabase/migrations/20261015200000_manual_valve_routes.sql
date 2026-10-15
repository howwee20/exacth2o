-- Physical valve routes for pots 1-100, used only by manual hold-to-water. A route records which
-- valve output waters a physical pot, with its evidence. Sensor pairings are research records and
-- do not define physical pot identity: some pairing names differ from the pot their valve waters.
-- Nothing here changes a pairing, a moisture target, a schedule or any other controller setting.
create table public.manual_valve_routes (
  project_id uuid not null,
  device_id text not null,
  pot_number integer not null check (pot_number between 1 and 100),
  status text not null check (status in ('confirmed', 'needs_confirmation', 'no_water_line')),
  relay_address integer check (relay_address between 3 and 127),
  channel integer check (channel between 1 and 48),
  source text not null check (char_length(source) between 1 and 80),
  evidence text not null default '' check (char_length(evidence) <= 600),
  confirmed_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (project_id, device_id, pot_number),
  check ((relay_address is null) = (channel is null)),
  check (status <> 'confirmed' or relay_address is not null),
  check (status <> 'no_water_line' or relay_address is null)
);
-- One confirmed pot per valve output.
create unique index manual_valve_routes_confirmed_valve
  on public.manual_valve_routes(project_id, device_id, relay_address, channel) where status = 'confirmed';
alter table public.manual_valve_routes enable row level security;
revoke all on table public.manual_valve_routes from public, anon, authenticated;
grant select on table public.manual_valve_routes to service_role;
comment on table public.manual_valve_routes is
  'Physical pot to valve routes for manual watering, with evidence. Written by migrations and confirm_/remove_manual_valve_route only.';

create function public.confirm_manual_valve_route(
  route_project_id uuid, route_device_id text, actor uuid,
  route_pot_number integer, route_relay_address integer, route_channel integer, route_note text default ''
) returns public.manual_valve_routes
language plpgsql security definer set search_path=public as $$
declare
  config public.device_config_state%rowtype;
  claimant integer;
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
    raise exception 'Relay board 0x% is not configured on this controller', to_hex(route_relay_address) using errcode='22023';
  end if;
  select pot_number into claimant from public.manual_valve_routes
    where project_id=route_project_id and device_id=route_device_id and status='confirmed'
      and relay_address=route_relay_address and channel=route_channel and pot_number<>route_pot_number;
  if claimant is not null then
    raise exception 'That valve is already confirmed for pot %', claimant using errcode='23505';
  end if;
  insert into public.manual_valve_routes(project_id,device_id,pot_number,status,relay_address,channel,source,evidence,confirmed_by,updated_at)
    values (route_project_id,route_device_id,route_pot_number,'confirmed',route_relay_address,route_channel,'admin',
            coalesce(left(route_note,600),''),actor,now())
    on conflict (project_id,device_id,pot_number) do update set status='confirmed', relay_address=excluded.relay_address,
      channel=excluded.channel, source='admin', evidence=excluded.evidence, confirmed_by=excluded.confirmed_by, updated_at=now()
    returning * into saved;
  insert into public.project_control_audit(project_id,device_id,action,actor_id,status,details)
    values (route_project_id,route_device_id,'manual_route_confirm',actor,'confirmed',
            jsonb_build_object('pot_number',route_pot_number,'relay_address',route_relay_address,'channel',route_channel,'note',saved.evidence));
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
            jsonb_build_object('pot_number',route_pot_number,'status',removed.status,'relay_address',removed.relay_address,
                               'channel',removed.channel,'source',removed.source));
  return true;
end; $$;
revoke all on function public.remove_manual_valve_route(uuid,text,uuid,integer) from public, anon, authenticated;
grant execute on function public.remove_manual_valve_route(uuid,text,uuid,integer) to service_role;
