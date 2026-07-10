alter table public.quote_requests
  add column if not exists submission_fingerprint text;

alter table public.support_threads
  add column if not exists submission_fingerprint text;

create index if not exists quote_requests_submission_fingerprint_idx
  on public.quote_requests (submission_fingerprint, created_at desc)
  where submission_fingerprint is not null;

create index if not exists support_threads_submission_fingerprint_idx
  on public.support_threads (submission_fingerprint, created_at desc)
  where submission_fingerprint is not null;

create table if not exists public.public_submission_rate_limits (
  scope text not null,
  client_hash text not null,
  window_started_at timestamptz not null,
  request_count integer not null default 1,
  updated_at timestamptz not null default now(),
  primary key (scope, client_hash, window_started_at)
);

create index if not exists public_submission_rate_limits_window_idx
  on public.public_submission_rate_limits (window_started_at);

alter table public.public_submission_rate_limits enable row level security;

revoke all on table public.public_submission_rate_limits from public, anon, authenticated;
grant select, insert, update, delete on table public.public_submission_rate_limits to service_role;

create or replace function public.check_public_submission(
  submission_scope text,
  submission_client_hash text,
  max_requests integer default 5,
  window_seconds integer default 600
)
returns table (
  allowed boolean,
  duplicate boolean,
  retry_after_seconds integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  safe_scope text := left(trim(coalesce(submission_scope, '')), 80);
  safe_max integer := least(greatest(max_requests, 1), 100);
  safe_window integer := least(greatest(window_seconds, 60), 86400);
  bucket_start timestamptz;
  current_count integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only service_role may check public submissions';
  end if;

  if safe_scope = '' or length(submission_client_hash) < 32 then
    raise exception 'Invalid public submission guard input';
  end if;

  bucket_start := to_timestamp(
    floor(extract(epoch from clock_timestamp()) / safe_window) * safe_window
  );

  insert into public.public_submission_rate_limits (
    scope,
    client_hash,
    window_started_at,
    request_count,
    updated_at
  ) values (
    safe_scope,
    submission_client_hash,
    bucket_start,
    1,
    now()
  )
  on conflict (scope, client_hash, window_started_at) do update
  set request_count = public.public_submission_rate_limits.request_count + 1,
      updated_at = now()
  returning request_count into current_count;

  if current_count > safe_max then
    return query select false, false, greatest(1, safe_window - floor(extract(epoch from (clock_timestamp() - bucket_start)))::integer);
    return;
  end if;

  delete from public.public_submission_rate_limits
  where window_started_at <= now() - interval '2 days';

  return query select true, false, 0;
end;
$$;

revoke all on function public.check_public_submission(text, text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.check_public_submission(text, text, integer, integer)
  to service_role;

create or replace function public.save_public_quote_submission(
  submission_data jsonb,
  submission_fingerprint_value text,
  notification_recipient text
)
returns table (request_id uuid, duplicate boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  created_quote_id uuid;
  created_thread_id uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only service_role may save public quote submissions';
  end if;

  if jsonb_typeof(coalesce(submission_data, '{}'::jsonb)) <> 'object'
     or length(coalesce(submission_fingerprint_value, '')) < 32 then
    raise exception 'Invalid quote submission input';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('public-quote:' || submission_fingerprint_value, 0));

  select quote.id
  into created_quote_id
  from public.quote_requests quote
  where quote.submission_fingerprint = submission_fingerprint_value
    and quote.created_at > now() - interval '15 minutes'
  order by quote.created_at desc
  limit 1;

  if created_quote_id is not null then
    return query select created_quote_id, true;
    return;
  end if;

  insert into public.quote_requests (
    project_id,
    name,
    email,
    phone,
    organization,
    application,
    timeline,
    message,
    source_url,
    referrer,
    origin,
    user_agent,
    notification_email,
    notification_status,
    status,
    priority,
    submission_fingerprint
  ) values (
    (submission_data->>'project_id')::uuid,
    submission_data->>'name',
    submission_data->>'email',
    nullif(submission_data->>'phone', ''),
    nullif(submission_data->>'organization', ''),
    submission_data->>'application',
    nullif(submission_data->>'timeline', ''),
    submission_data->>'message',
    nullif(submission_data->>'source_url', ''),
    nullif(submission_data->>'referrer', ''),
    nullif(submission_data->>'origin', ''),
    nullif(submission_data->>'user_agent', ''),
    notification_recipient,
    'pending',
    'new',
    'normal',
    submission_fingerprint_value
  )
  returning id into created_quote_id;

  insert into public.support_threads (
    project_id,
    source,
    status,
    priority,
    request_type,
    submission_fingerprint,
    subject,
    customer_name,
    customer_email,
    customer_phone,
    customer_organization,
    quote_request_id,
    metadata
  ) values (
    (submission_data->>'project_id')::uuid,
    'quote',
    'new',
    'normal',
    'quote',
    submission_fingerprint_value,
    'Quote request: ' || (submission_data->>'application'),
    submission_data->>'name',
    submission_data->>'email',
    nullif(submission_data->>'phone', ''),
    nullif(submission_data->>'organization', ''),
    created_quote_id,
    jsonb_build_object(
      'timeline', nullif(submission_data->>'timeline', ''),
      'source_url', nullif(submission_data->>'source_url', '')
    )
  )
  returning id into created_thread_id;

  insert into public.support_messages (
    thread_id,
    project_id,
    direction,
    channel,
    from_email,
    from_name,
    to_emails,
    subject,
    body_text,
    metadata
  ) values (
    created_thread_id,
    (submission_data->>'project_id')::uuid,
    'inbound',
    'form',
    submission_data->>'email',
    submission_data->>'name',
    array['support@exacth2o.com']::text[],
    'Quote request: ' || (submission_data->>'application'),
    submission_data->>'message',
    jsonb_build_object(
      'quote_request_id', created_quote_id,
      'application', submission_data->>'application',
      'timeline', nullif(submission_data->>'timeline', '')
    )
  );

  return query select created_quote_id, false;
end;
$$;

create or replace function public.save_public_support_submission(
  submission_data jsonb,
  submission_fingerprint_value text
)
returns table (request_id uuid, duplicate boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  created_thread_id uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only service_role may save public support submissions';
  end if;

  if jsonb_typeof(coalesce(submission_data, '{}'::jsonb)) <> 'object'
     or length(coalesce(submission_fingerprint_value, '')) < 32 then
    raise exception 'Invalid support submission input';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('public-support:' || submission_fingerprint_value, 0));

  select thread.id
  into created_thread_id
  from public.support_threads thread
  where thread.submission_fingerprint = submission_fingerprint_value
    and thread.created_at > now() - interval '15 minutes'
  order by thread.created_at desc
  limit 1;

  if created_thread_id is not null then
    return query select created_thread_id, true;
    return;
  end if;

  insert into public.support_threads (
    project_id,
    source,
    status,
    priority,
    request_type,
    submission_fingerprint,
    subject,
    customer_name,
    customer_email,
    customer_phone,
    customer_organization,
    metadata
  ) values (
    (submission_data->>'project_id')::uuid,
    'form',
    'new',
    'normal',
    submission_data->>'request_type',
    submission_fingerprint_value,
    submission_data->>'subject',
    submission_data->>'name',
    submission_data->>'email',
    nullif(submission_data->>'phone', ''),
    nullif(submission_data->>'organization', ''),
    jsonb_build_object(
      'source_url', nullif(submission_data->>'source_url', ''),
      'referrer', nullif(submission_data->>'referrer', ''),
      'origin', nullif(submission_data->>'origin', ''),
      'user_agent', nullif(submission_data->>'user_agent', '')
    )
  )
  returning id into created_thread_id;

  insert into public.support_messages (
    thread_id,
    project_id,
    direction,
    channel,
    from_email,
    from_name,
    to_emails,
    subject,
    body_text,
    metadata
  ) values (
    created_thread_id,
    (submission_data->>'project_id')::uuid,
    'inbound',
    'form',
    submission_data->>'email',
    submission_data->>'name',
    array['support@exacth2o.com']::text[],
    submission_data->>'subject',
    submission_data->>'message',
    jsonb_build_object(
      'request_type', submission_data->>'request_type',
      'source_url', nullif(submission_data->>'source_url', '')
    )
  );

  return query select created_thread_id, false;
end;
$$;

revoke all on function public.save_public_quote_submission(jsonb, text, text)
  from public, anon, authenticated;
revoke all on function public.save_public_support_submission(jsonb, text)
  from public, anon, authenticated;
grant execute on function public.save_public_quote_submission(jsonb, text, text)
  to service_role;
grant execute on function public.save_public_support_submission(jsonb, text)
  to service_role;

comment on function public.check_public_submission(text, text, integer, integer)
  is 'Atomic service-role rate limit. Public form persistence uses expiring fingerprint deduplication inside transactional save RPCs.';
