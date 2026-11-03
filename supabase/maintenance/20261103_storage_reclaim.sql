-- Executed manually through the authenticated management API, one statement at a time.
-- NOT an automatic migration. REINDEX CONCURRENTLY must run outside a transaction.
-- Before repeating: inspect free space, long transactions, index sizes and validity.
-- Preserve index definitions and constraints; monitor pg_stat_progress_create_index.
-- A failed concurrent rebuild may leave a transient invalid index. Inspect before retrying.
-- Measurements and operational verification: docs/performance/2026-11-02-maintenance.json.

ANALYZE public.sensor_readings;
ANALYZE public.walker_live_telemetry_readings;
ANALYZE public.rd_model_updates_v5;
ANALYZE public.rd_curve_predictions;
ANALYZE public.device_health_snapshots;

REINDEX INDEX CONCURRENTLY public.sensor_readings_device_time_idx;
REINDEX INDEX CONCURRENTLY public.sensor_readings_project_device_recorded_idx;
REINDEX INDEX CONCURRENTLY public.sensor_readings_project_device_received_idx;
REINDEX INDEX CONCURRENTLY public.sensor_readings_project_pairing_recorded_idx;
REINDEX INDEX CONCURRENTLY public.sensor_readings_event_id_key;
REINDEX INDEX CONCURRENTLY public.sensor_readings_project_time_idx;
REINDEX INDEX CONCURRENTLY public.sensor_readings_walker_finalize_idx;

-- Performed after a private, checksum-verified archive and bounded pruning of old cron history.
-- Ordinary VACUUM, not VACUUM FULL: makes pages reusable without rewriting/locking the table.
VACUUM (ANALYZE) cron.job_run_details;
