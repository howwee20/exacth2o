-- Only aggregate website statistics live here. No visitor identities or IPs.
create table public.website_analytics_cache (
  cache_key text primary key,
  payload jsonb,
  fetched_at timestamptz,
  refresh_after timestamptz not null default '-infinity',
  constraint website_analytics_payload_object check (payload is null or jsonb_typeof(payload) = 'object')
);
alter table public.website_analytics_cache enable row level security;
revoke all on public.website_analytics_cache from public, anon, authenticated;
grant select, insert, update, delete on public.website_analytics_cache to service_role;

-- A database lease prevents recycled/concurrent edge instances from hammering PostHog.
create function public.claim_website_analytics_refresh(requested_key text)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  insert into public.website_analytics_cache(cache_key) values (requested_key)
    on conflict (cache_key) do nothing;
  update public.website_analytics_cache
    set refresh_after = now() + interval '1 minute'
    where cache_key = requested_key and refresh_after <= now()
      and (fetched_at is null or fetched_at < now() - interval '5 minutes');
  return found;
end;
$$;
revoke all on function public.claim_website_analytics_refresh(text) from public, anon, authenticated;
grant execute on function public.claim_website_analytics_refresh(text) to service_role;
