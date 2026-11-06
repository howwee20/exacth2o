# Restore and recovery

Never start a restored production database with outbound network access. A clone may inherit cron jobs, vault values and production URLs. Replacing a literal URL with a vault lookup does not make that clone safe.

1. Create an isolated restore with outbound access denied. Keep device publishers and agents pointed at production.
2. Disable restored cron jobs before allowing outbound networking. Export their names/schedules for review, excluding secrets.
3. Remove or replace copied production credentials, vault values and function endpoints. Confirm the clone project reference in every outbound target.
4. Run `scripts/verify-database-baseline.sh` against its disposable local stack. This starts from the recorded baseline, then replays later migrations; `supabase db reset` against the historical migrations folder alone is not the supported restore procedure.
5. Validate tenant permissions, row counts, experiment boundaries, canonical physical map and idempotent ingestion using fixture data. Never run a destructive test against the live project.
6. Enable only individually reviewed jobs against the clone's own endpoints. Keep actuation disabled. Record the restore time and results.

## Event identity migration

Prepare the composite indexes using `maintenance/20261103_ingest_indexes.sql`, one statement at a time outside a transaction. Verify they are ready and valid. Deploy the matching `sync-owner-health` implementation before applying `20261103042000_scope_ingest_event_identity.sql`; it can use the new composite index while the old unique constraint still exists. Then apply the migration in a short transaction. Verify function definitions, constraints and new ingestion.

Once two devices legitimately have the same event ID, restoring global uniqueness is not a safe rollback. Prefer forward repair. Preserve scientific rows. The previous publisher can continue writing after the composite migration; reset-safe publisher code is a separate device release and must preserve its durable state.

## Release records

Record source commit, migration versions, function versions and controller release separately. Website publication does not deploy Edge Functions or controller images. Controller acknowledgement does not prove physical delivery.
