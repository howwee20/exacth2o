# ExactH2O database baseline

`20260724210000_public_schema.sql` is a schema-only snapshot of the linked
production `public` schema. It contains no users, secrets, telemetry, commands,
or experiment rows.

The baseline is intentionally separate from `supabase/migrations`. Existing
installations must never replay a historical baseline. New or restored
environments load this snapshot first and then apply migrations newer than the
snapshot timestamp.

Run the restore proof with:

```bash
./scripts/verify-database-baseline.sh
```

The proof verifies the snapshot checksum, applies every later migration in a
clean local Supabase environment, and asserts the foundation tables, views,
RLS, access policies, and notification preference RPC. CI runs the same proof
for every portal release.

Refresh the snapshot only after a production migration has been deployed and
verified:

```bash
supabase db dump --linked --schema public \
  --file supabase/baseline/YYYYMMDDHHMMSS_public_schema.sql
```

Record the new SHA-256 digest, advance the cutoff in the verification script,
and prove a clean restore before committing it.
