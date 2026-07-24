# Supabase operations

The migrations in this directory are source-controlled infrastructure. Do not apply a new migration directly to the greenhouse production project.

For the July 2026 hardening migrations:

1. Capture and verify a restorable roles/schema/data backup.
2. Restore that backup into an isolated staging Supabase project.
3. Disable portal command intake, stop every control executor, and verify there are zero `queued`, `accepted`, or `running` commands. The control migration takes an exclusive command-table lock and refuses to start otherwise; the migration runner must execute the file as one transaction.
4. Apply `20260709190000_optimize_control_and_portal_data.sql` and `20260709191500_add_public_submission_guards.sql` only.
5. Deploy the matching Edge Functions and their secrets, then re-check that the command queue is still empty.
6. Apply `20260709193000_schedule_owner_health_ingestion.sql`. Verify both successful Cron job runs and the corresponding `pg_net` HTTP responses before any portal deployment; a successful Cron run alone only proves that the HTTP request was queued.
7. Verify Auth, portal access/RLS, Realtime, three consecutive scheduled health-ingestion cycles, CSV export, command claim/lease/completion, command quarantine/reconciliation, and public form submission. Include concurrent executor and retry tests.
8. Confirm no pairing, calibration, board, sensor, valve, group, target, or live watering configuration changed.
9. Implement and bench-test the controller-owned `/valves/pulse` watchdog before enabling manual watering. The endpoint is not part of this repository, so live manual watering remains blocked until that external controller contract is proven.
10. Deploy the matching executor in dry-run mode only in a separate controller release after the backend and controller watchdog contract pass bench verification.
11. Re-enable command intake only after the matching database functions, Edge Function, and dry-run executor have passed the checklist. Use a maintenance window and a written rollback checklist before production cutover. Keep the managed project read-only and available for rollback until the new path is verified.

Required function secrets include:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `CONTROL_COMMAND_INTAKE_ENABLED` (strict `1` only after the coordinated controller release passes verification; any other value fails closed)
- `SYNC_OWNER_HEALTH_SECRET`
- `SYNC_OWNER_HEALTH_CRON_SECRET` (a separate random secret shared only by the Edge Function and the encrypted Vault entry named `exacth2o_owner_health_cron_secret`)
- `MATT_OWNER_HEALTH_USER`
- `MATT_OWNER_HEALTH_PASSWORD`
- `PUBLIC_FORM_RATE_LIMIT_SALT` (random, at least 32 characters)
- Resend and notification secrets used by the quote/support functions
- `PUBLIC_INTAKE_PROJECT_ID`
- `HEALTH_SYNC_PROJECT_ID`
- `HEALTH_SYNC_ORGANIZATION_ID`
- `HEALTH_SYNC_DEVICE_ID`
- `HEALTH_SYNC_DEVICE_NAME`
- `OWNER_HEALTH_BASE_URL` (optional)
- `NOTIFICATION_DISPATCHER_SECRET`
- `NOTIFICATION_FROM_EMAIL`

The production installation identifiers above are deployment configuration,
not application behavior. `sync-owner-health` fails closed when the health-sync
identity is incomplete, and the public intake functions fail closed when their
project is not configured. The legacy `MATT_OWNER_HEALTH_USER` and
`MATT_OWNER_HEALTH_PASSWORD` secret names remain accepted during credential
migration; new installations should use `OWNER_HEALTH_USER` and
`OWNER_HEALTH_PASSWORD`.

The notification dispatcher requires an authenticated server-side invocation.
Do not expose `NOTIFICATION_DISPATCHER_SECRET` to a browser. Configure the
provider and a scheduler only after the sending domain and recipient behavior
have been verified in staging. `QUOTE_EMAIL_FROM` is used as the fallback
sender when `NOTIFICATION_FROM_EMAIL` is not set.

`sync-owner-health` accepts only server ingestion secrets. Supabase Cron is the five-minute server authority until the matching controller executor is safely released; the executor can then become the primary publisher while Cron and GitHub Actions remain freshness-checked watchdogs. Browser tabs are readers, not ingestion authorities. Provision the same strong random value in the Edge secret `SYNC_OWNER_HEALTH_CRON_SECRET` and Vault name `exacth2o_owner_health_cron_secret`; the scheduled database function fails closed without it.

The migration and matching executor are one coordinated release. Never apply the lease/quarantine schema while an older executor can claim work: fail-close command intake, verify the queue is empty, and disable its control token or stop the executor first. Run the full sequence first against a restored staging database; this repository does not contain a complete original base schema and these migrations are not a substitute for a verified full backup.

The health retention job deletes observations older than 30 days at most once every 23 hours. Deletion stops future growth but does not automatically return existing PostgreSQL file space to the operating system. Evaluate `VACUUM`, `pg_repack`, or an equivalent managed maintenance procedure in staging before reclaiming existing bloat.

Any controller mutation timeout is an unknown physical outcome. The database quarantines that device's command tokens. Re-enable only through `reconcile_device_control_quarantine` after a fresh independent state observation and explicit confirmation that every valve is closed.

Public quote/support submissions use transactional persistence, a 15-minute retry fingerprint, and independent salted network/normalized-email rate limits. Verify in staging that the Edge platform overwrites forwarded client-address headers. Treat CAPTCHA/Turnstile (or another platform-attested challenge) as a remaining production gate for distributed abuse; CORS and honeypots are not abuse controls.

The portal supplies explicit project/device predicates and indexed receive-time and device-time cursors for sensor reads. The migration preserves the restored `project_members` authorization boundary through cached project/organization ID helpers instead of evaluating `is_project_member` for every protected row. Re-run the admin, researcher, member-only, and no-access matrix plus authenticated `EXPLAIN (ANALYZE, BUFFERS)` whenever these policies or indexes change.
