-- Operational history only: keep the latest 30 days and all unfinished runs.
-- Do not change chamber scheduling, command queues, or research retention.
select cron.schedule(
  'exacth2o-prune-cron-history',
  '17 4 * * *',
  $job$set lock_timeout = '2s';
set statement_timeout = '30s';
delete from cron.job_run_details
where end_time < now() - interval '30 days';$job$
);
