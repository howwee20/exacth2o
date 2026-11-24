-- Resend retains an idempotency key for 24 hours. Start the clock when the
-- worker first claims the row, so waiting in an untouched backlog is safe.
alter table public.notification_outbox add column first_attempt_at timestamptz;
update public.notification_outbox set first_attempt_at = created_at
where channel = 'email' and status in ('pending', 'sending') and attempt_count > 0;

create or replace function public.claim_notification_outbox(
  claim_limit integer default 25, claim_seconds integer default 120
) returns setof public.notification_outbox
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only service_role may claim notifications';
  end if;

  -- Includes jobs abandoned by a worker after the provider accepted its request.
  update public.notification_outbox
  set status = 'failed', lease_until = null, updated_at = now(),
      last_error = 'Retry window ended. Check the provider for the final outcome.'
  where channel = 'email' and first_attempt_at <= now() - interval '23 hours'
    and (status = 'pending' or (status = 'sending' and lease_until <= now()));

  return query
  with due as (
    select id from public.notification_outbox
    where channel = 'email' and attempt_count < 20 and next_attempt_at <= now()
      and (status = 'pending' or (status = 'sending' and lease_until <= now()))
      and (first_attempt_at is null or first_attempt_at > now() - interval '23 hours')
    order by next_attempt_at, created_at, id
    limit least(greatest(claim_limit, 1), 100)
    for update skip locked
  )
  update public.notification_outbox n
  set status = 'sending', first_attempt_at = coalesce(n.first_attempt_at, now()),
      lease_until = now() + make_interval(secs => least(greatest(claim_seconds, 30), 600)),
      attempt_count = n.attempt_count + 1, updated_at = now()
  from due where n.id = due.id returning n.*;
end $$;

-- The outbox transition and its audit entry must commit together. A newer
-- claim owns the row as soon as it increments attempt_count.
create function public.finish_notification_delivery(
  notification_id uuid, claimed_attempt integer, outcome text,
  receipt text default null, failure_reason text default null
) returns text
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  job public.notification_outbox%rowtype;
  next_status text;
  retry_at timestamptz;
begin
  select * into job from public.notification_outbox
  where id = notification_id and channel = 'email' and status = 'sending'
    and attempt_count = claimed_attempt
  for update;
  if not found then return null; end if;

  if outcome = 'accepted' and nullif(trim(receipt), '') is not null and failure_reason is null then
    next_status := 'delivered';
  elsif outcome in ('retry', 'canceled') and receipt is null and nullif(trim(failure_reason), '') is not null then
    retry_at := now() + make_interval(secs => 60 * (2 ^ (claimed_attempt - 1)));
    next_status := case
      when outcome = 'canceled' then 'canceled'
      when claimed_attempt >= 20 or retry_at >= job.first_attempt_at + interval '23 hours' then 'failed'
      else 'pending'
    end;
  else
    raise exception 'Invalid email delivery outcome';
  end if;

  update public.notification_outbox
  set status = next_status, provider_id = receipt, lease_until = null,
      delivered_at = case when next_status = 'delivered' then now() end,
      next_attempt_at = case when next_status = 'pending' then retry_at else next_attempt_at end,
      last_error = failure_reason, updated_at = now()
  where id = job.id;
  insert into public.notification_delivery_attempts(notification_id, status, provider_id, error, response_metadata)
  values (job.id, case when next_status = 'delivered' then 'delivered' else 'failed' end,
          receipt, failure_reason, jsonb_build_object('provider', 'resend', 'attempt', claimed_attempt));
  return next_status;
end $$;
revoke all on function public.finish_notification_delivery(uuid,integer,text,text,text) from public, anon, authenticated;
grant execute on function public.finish_notification_delivery(uuid,integer,text,text,text) to service_role;
