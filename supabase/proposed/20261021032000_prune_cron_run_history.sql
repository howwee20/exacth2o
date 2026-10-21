-- PROPOSED, NOT APPLIED: needs explicit approval because it deletes rows.
--
-- pg_cron never deletes cron.job_run_details. On 2026-10-21 it held 753,417
-- rows (124 MB) back to 2026-07-10, growing ~17,800 rows (~2.9 MB) a day,
-- mostly from the 5-second chamber_schedule_tick. Its only reader,
-- chamber_schedule_overview, uses the newest successful run (30 s window).
-- Postgres logs on this plan keep 7 days, so 7 days of run history matches
-- what operators can already correlate. These are pg_cron operational logs:
-- no research reading, command, audit or experiment row is touched.
--
-- Deletes run hourly in bounded batches (<= 20,000 rows, ~0.2 s), so the
-- backlog clears in about a day without a long lock, then ~17,800/day.
-- Space is reused by later inserts; no VACUUM FULL is needed or used.
-- Rollback: `select cron.unschedule('exacth2o-prune-cron-history');`
-- (deleted run logs cannot be restored; they are not research data).
set lock_timeout = '2s';
set statement_timeout = '30s';

create or replace function public.prune_cron_run_history(
  keep interval default interval '7 days',
  batch_limit integer default 20000
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, cron
as $$
declare
  removed integer;
begin
  delete from cron.job_run_details details
  where details.runid in (
    select old_run.runid
    from cron.job_run_details old_run
    where old_run.end_time < now() - keep
    order by old_run.runid
    limit greatest(1, least(batch_limit, 50000))
  );
  get diagnostics removed = row_count;
  return removed;
end;
$$;

revoke all on function public.prune_cron_run_history(interval, integer) from public, anon, authenticated;

select cron.schedule(
  'exacth2o-prune-cron-history',
  '23 * * * *',
  $$select public.prune_cron_run_history()$$
);
