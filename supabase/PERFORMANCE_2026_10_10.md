The October 10 performance pass keeps all raw readings and valve events. It retains the unique event ID constraint and all existing authorization scopes and function privileges.

Applied to production through the Supabase Management migration endpoint as versions `20261010213538` and `20261010213539`:

- Walker live status now uses indexed latest timestamps and a bounded 15 minute sensor count, replacing a sort over the full archive. The output and access guard are unchanged.
- Four RLS policies cache `auth.uid()` once per statement.
- Removed the 207 MB nonunique event ID index covered by the retained unique constraint, plus the duplicate champion-model index. Catalog guards verify matching keys, predicates, operator classes, collations and uniqueness before removal; lock waits are limited to two seconds.

Verification used an isolated local PostgreSQL database with schema fixtures and the production function definitions. The status tests exercise empty, stale, delayed, live and out-of-order readings, distinct sensor counts, installation scope and admin/researcher/no-access roles. The ingest test proves invalid-token rejection, raw payload fidelity and idempotent reading/valve retries after index removal. Existing portal access and product read access matrices also passed. No hardware commands are issued by these migrations or tests.

A 400,000-row local benchmark produced identical status JSON, reduced execution from about 70 ms to 0.17 ms and eliminated temporary writes. One authenticated production warm-cache comparison improved from 331 ms to 7 ms, with temporary writes falling from 1,618 blocks to zero. These are measured samples, not a peak-load capacity guarantee.

Production checks retained 1,675,080 general sensor readings and 437,581 Walker readings with the same oldest timestamps; valve history continued growing. A sample of 29 native readings across all 12 Pan probes matched stored values and timestamps exactly. The greenhouse publisher was caught up without failures. Walker's publisher is reachable and caught up, but its source reading timestamp is September 16; that separate stale source is not evidence of a Supabase write failure.

Run `supabase/tests/status_read_performance.sql` and `supabase/tests/telemetry_index_integrity.sql` only against an isolated staging schema after these migrations, using `psql -v ON_ERROR_STOP=1`. Both fixture transactions roll back. Production daily backups reported completed; no raw-reading retention was reduced. Exact pre-change function/policy definitions and index rebuilds are in `supabase/rollbacks/20261010_status_reads_and_indexes.sql`.
