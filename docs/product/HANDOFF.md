# Exact H2O coherent portal — release handoff

For Codex (independent verification, production migrations, merge and deployment). Written by
the implementation owner. Nothing in this branch has been merged, deployed, applied to a remote
database or used to change production data.

| | |
|---|---|
| Checkout | `/Users/ejhowe/Documents/Codex/2026-10-07/so-2/work/exacth2o-product` (git worktree) |
| Branch | `product/coherent-portal-20261008` |
| Base | `ej-supabase-research-portal` at `abef47fec1798e931efb0200556033840317a110` (unchanged on the remote when this was written) |
| Commits | `9c652c1` slice 1 · `cd6d7ea` journey suite · `ee1bf95` slice 2 · slice 3 is the commit that adds this file |
| Design reference | The six local design-lab prototypes (visual reference only; no fixture, sample clock or review chrome was imported) |

`docs/product/IMPLEMENTATION.md` records the decisions (routing, identity, data access, notes,
bench layout, statistics). This file is the release record.

## 1. What a person can now do

**Navigation and links.** Experiments, Bench and Workbench in one header; Find pot (`/`) everywhere;
"At the bench" is a remembered mode. Every experiment opens into Overview, Pots and Record. Every
view is a query-string URL under `/portal` (`?experiment=…&tab=…`, `?pot=…`, `?view=bench|pocket|workbench`,
`?view=workbench&comparison=<id>`), so Back, Forward, reload, copied links and QR codes work;
`?project=`, invites, recovery links and the old `/portal` entry keep working. Deep links survive sign-in.

1. **Quiet Spine home.** Animated dashed connector (still under reduced motion). Compact cards: name,
   configured pot count, an optional mode line, an options menu (Overview, Pots, Record, Copy link,
   Edit). One specific exception line per experiment, distinct for: a failed refresh (judged as of the
   last successful check), controller offline (said once, cards stay quiet), pots without readings
   (named by sensor board), and a target that differs from the plan. Silence never stands for a failed check.
2. **Waterline overview.** Groups derived from the plan's factors; median line, min–max band (called a
   range, never a confidence interval), target hairline, gaps left empty, coverage shown, every pot one
   click away, units and calibration named. Observation-only experiments and other measures (raw, temperature,
   EC) work. Installation Trends view across experiments.
3. **Bench.** Real `hardware_bindings`, `research_pots` and `physical_positions`. A recorded layout is an
   append-only version (admins only); without one the bench says it is schematic. Shape plus colour for
   experiment/treatment, sensor-board groupings, silent boards called out, lookup by number; selecting a pot
   opens the same pot record.
4. **Pocket (At the bench).** Number pad, recent pots, neighbours, reading, target, 6 h trace, accessible
   summary; label links by research-pot id; offline readings marked as the last successful load. Notes go
   through a durable IndexedDB outbox scoped to account and project: stable client ids, idempotent retries,
   pending / sending / failed / needs-sign-in states, the writer's time kept separate from the received time;
   shared between tabs; survives reloads, flapping networks, sign-out (with a warning), account switches and
   expired sessions. Corrections supersede; nothing is edited.
5. **Workbench.** Comparisons titled by their question, saved on the server, private or shared with the
   project. Group by factors or by pot; calendar time or days since a recorded event (experiment start, a plan
   version, a confirmed calibration); 72 h to 120 days through a bounded, paged aggregate. Reversible
   exclusions with scope (pot or all pots, time range or open-ended), reason, author and time; revoking keeps
   the record. Hiding a line changes the figure only. Statistics, figure (SVG), data (CSV) and methods
   (JSON sidecar) are computed from the same buckets after the same exclusions. Weighting is stated; no
   significance test is computed; incomplete data (failed requests, clipped windows, pots without data,
   coverage) is shown.
6. **Record.** One filterable lane (plan, calibration, controller settings, gaps, valve openings, notes) with
   a time strip. Each item keeps when it happened apart from when it was recorded or requested, and says
   whether it is a recorded row or derived from readings. Calibration changes can be explained from raw output
   (conversion change vs raw change, with the controller's valve openings marked). Valve openings are
   described as controller events, not measured water. "Since you last looked" uses a per-person mark and
   counts only other people's recorded rows.
7. **Public website.** A prominent "one pot" section: a synthetic, isolated simulation (labelled, no
   predictive claims) in the Waterline visual language, plus a short record example. Quote and analytics
   behaviour unchanged. See §7 for the hero claims EJ must approve.

## 2. Database changes (additive; apply in this order)

| Migration | What it does | Rollback |
|---|---|---|
| `20261008115500_restore_experiment_completion_audit_events.sql` | Re-creates `experiment_audit_events_event_type_check` with `completed` and `restored`. `20260728010000` dropped them while `complete_assistant_experiment` / `restore_assistant_experiment` still write them, so completing or restoring an experiment currently fails the check. Widens only; changes no row. | Re-create the `20260728010000` constraint, only if no `completed`/`restored` rows were written since. |
| `20261008120000_create_portal_pot_notes_and_bench_layouts.sql` | `has_portal_project_role(uuid, text[])` (project-scope roles only). `portal_pot_notes`: append-only, client UUID key, server-set author, author label and received time, device must belong to the project, writer time within −45 days…+10 min, corrections must be about the same pot. RLS: members read; admins and researchers insert as themselves; no update/delete grant. `portal_bench_layout_versions`: append-only, database-validated layout JSON (bench ids, bounds, no shared cells or duplicate pots), version assigned under an advisory lock; admins insert, members read. Realtime publication for notes (guarded). | Drop both tables and the three functions (statements in the file header). Back up both tables first if they hold rows. |
| `20261008130000_create_portal_comparisons_and_record_views.sql` | `portal_comparisons` (owner + `private`/`project` sharing; readable only while the reader can see the experiment; owners update question/definition/sharing/archive only; no delete). `portal_comparison_exclusions` (append-only; revoke once, with reason and revoker, by the comparison owner; nothing else editable). `portal_experiment_views` (per-person "last looked", own rows only, never in the future, never moves back). Read-only `SECURITY INVOKER` functions — callers' existing RLS on `sensor_readings` / `valve_events` applies: `portal_reading_buckets` (per pot per bucket means and counts with exclusions removed; ≤120 days, ≤200 pots, ≤60 000 pot-buckets), `portal_reading_gaps` (only the gaps), `portal_valve_open_buckets`. | Drop the three functions, three tables and four trigger functions (file header lists them). Back up the three tables first if they hold rows. |

No Edge Function was added or changed. No existing table, policy, function or controller path was
altered except the widened audit check above. Nothing writes readings, valve events, commands,
targets, pairings, calibration, schedules, firmware or identity tables. No service-role key is used
by the browser; all new writes go through the anon key under RLS with `auth.uid()` enforced by
policies and `BEFORE` triggers.

Proven on a disposable database: `scripts/verify-database-baseline.sh` (the CI proof) restores the
production schema baseline, applies every migration including these, and runs
`supabase/tests/portal_product_access.sql` — exit 0. That RLS matrix (one rolled-back transaction,
as `authenticated` with impersonated JWTs) covers: notes insert / idempotent retry / server author /
viewer read-only / other-project and gas-mixer-only and no-access denial / wrong controller / future
time / mismatched correction / no update or delete; layout admin-only, overlap and bounds refusal,
version sequencing, no edits, other-project invisibility; comparison author from the server, no
comparison about an experiment the writer cannot see, no wrong controller, no controller move,
private vs shared visibility, no edits by another member, viewers see none and cannot save, other
project sees none; exclusions applied exactly by the aggregate (105 kept / 15 excluded), unbounded
history refused, no edit, no delete, revoke once with revoker kept, only the owner adds; gap and
valve functions return nothing for another project; view marks own-only, clamped, monotonic, private.

## 3. Release order (Codex)

1. Review the draft PR; let CI run (portal check, demo freshness, database baseline proof, scope routing).
2. **Backup** before any migration: confirm point-in-time recovery is enabled for the production project and
   take a logical dump of `public` (at least `experiment_audit_events`, `experiments`, `experiment_revisions`).
3. Read-only pre-checks on production:
   ```sql
   select event_type, count(*) from public.experiment_audit_events group by 1;  -- all values must be in the new list
   select to_regclass('public.portal_pot_notes'), to_regclass('public.portal_comparisons');  -- both null
   select proname from pg_proc where proname = 'has_portal_project_role';  -- none, or identical definition
   ```
4. Apply the three migrations in timestamp order (`supabase db push` against the linked project, or the
   project's usual migration path). They are additive; the currently deployed portal does not use the new
   objects, so applying them before the merge changes nothing users see.
5. Post-checks (read-only): RLS enabled and policies present on the five new tables; functions are
   `security invoker` (`select proname, prosecdef from pg_proc where proname like 'portal_%'` → `prosecdef = false`
   for the three aggregates); grants as listed in the files; `notify pgrst` reloaded the schema cache
   (a REST `select` on `portal_pot_notes` with a member's token returns `[]`, not 404).
6. Merge the PR into `ej-supabase-research-portal`. The Pages workflow publishes the committed `portal-app/`,
   `portal.html`, `demo*.html`, `applications-demo-app/` and website files (including `one-pot-explainer.js`).
   No function deploy is needed.
7. Live verification with an authorized account (see §5) before announcing.

**Recovery.** Front end: revert the merge commit; Pages redeploys the previous bundle; the new tables
stay unused and harmless. Database: the new objects can stay; if they must go, back up their rows and
run the rollback statements in each file header (reverse order). Notes waiting in browsers' outboxes
are kept on those devices and are sent when a portal with notes is deployed again.

## 4. Validation results (this branch, local)

| Check | Result |
|---|---|
| `npm run check --prefix research-portal` (lint, 300 unit tests, typecheck + build, portal surface audit, `npm audit`) | pass; 0 vulnerabilities |
| Both demo builds + freshness diff (CI step) | rebuilt and committed; no diff after rebuild |
| `scripts/verify-database-baseline.sh` (with `EXACTH2O_BASELINE_PORT_BASE=56300` to avoid another local stack) | exit 0 |
| `supabase/tests/portal_product_access.sql` on the local product database | pass |
| End-to-end journeys `scripts/product-local/journeys.mjs` | 19 / 19 pass (list below) |

Journeys (real portal, local Supabase, real sign-in, RLS on): home quiet; home → experiment → pot with
Back/Forward/reload; deep links through sign-in; board outage vs failed refresh vs controller offline vs
target discrepancy; account isolation (other project, viewer); phone, tablet, keyboard (`/` Find pot), reduced
motion; bench schematic + silent board + lookup + same pot record + phone; bench layout versioning (admin
only, earlier version unchanged, API refusal for researchers, invisible to other projects); pocket number pad,
neighbours, recent pots, label link by UUID, unknown/other-project/`javascript:`/markup links refused safely;
note written offline survives reload and a dropped response and is recorded exactly once with written-offline
flag, writer time and server author; waiting notes stay with their account through sign-out (warned) and an
account switch and are sent only under the writer's account; expired session waits for sign-in; refused note
kept, retried or discarded; two tabs send each note once; viewers read but cannot write, other projects
cannot read, notes cannot be edited or deleted, spoofed authors are overwritten; workbench comparison saved,
shared, reopened by link (Back/Forward/reload), read-only for another member, refused to another project and
to viewers; exclusion applied identically to statistics, CSV, methods JSON and SVG and checked against a direct
database count, hiding a line leaves statistics and CSV byte-identical, revoking restores the CSV byte-for-byte
and keeps the record; 30-day history paged (every call ≤1000 rows) and >120-day request refused; Record lane
contents and filters, calibration explained from raw output, phone width; "since you last looked" per person,
own actions not counted, mark moves once seen, other project cannot read marks.

**Performance** (`scripts/product-local/perf.mjs`, production builds of both versions against the same local
data; decoded JSON in decimal kB/MB, before transport compression; times are to the first usable view on a local machine):

| Route | Supabase requests | Payload | Time to view |
|---|---|---|---|
| Home, before (abef47f) | 26 | 5.43 MB | 122 ms |
| Home, after | 26 | 5.43 MB | 120 ms |
| Experiment overview | 26 (+0) | +0 | 144 ms |
| Pot page | +5 | +19 kB | 121 ms |
| Bench | +4 | +14 kB | 104 ms |
| Pocket pot | +5 | +19 kB | 115 ms |
| Workbench, 7 days, 24 pots | +9 (5 aggregate pages) | +741 kB | 121 ms |
| Workbench, 30 days | 3 aggregate pages, 2 040 rows | 378 kB | ~0.8 s (dev server) |
| Record, 14 days | +10 | +56 kB | 258 ms |

The shell's existing load (72 h of readings in 16 pages) is unchanged; the product views add bounded
requests on top. The aggregate replaces downloading raw readings (21 days × 24 pots ≈ 72 000 rows) with
per-pot buckets (≈4 000 rows for 7 days; ≈0.3 s server time for 21 days on the local database).
Portal entry bundle: 62.4 → 74.1 kB gzip; Bench, Pocket, Workbench, Record, Waterline, pot page and Trends are
lazy chunks (4–8 kB gzip each).

Screenshots (same local data): `docs/product/screenshots/` — `before-after-home.png`,
`before-after-experiment.png`, `before-after-phone-home.png`, `home-board-outage.png`,
`bench-schematic-outage.png`, `pocket-states-phone.png`, `pot-page-notes.png`, `workbench-aligned.png`,
`workbench-exclusion.png`, `record-calibration.png`, `record-phone.png`.

## 5. Reproducing the checks

```bash
scripts/product-local/start.sh                       # isolated stack on ports 554xx; never touches 54321/54322
(cd research-portal && npx vite --mode productlocal --host 127.0.0.1 --port 4740 --strictPort)
PLAYWRIGHT_CORE=/path/to/playwright-core node scripts/product-local/journeys.mjs --out /tmp/journeys
PLAYWRIGHT_CORE=/path/to/playwright-core node scripts/product-local/perf.mjs --out /tmp/perf.json
psql "$(grep DB_URL "$TMPDIR/exacth2o-product-local/accounts.env" | cut -d= -f2-)" -v ON_ERROR_STOP=1 -f supabase/tests/portal_product_access.sql
EXACTH2O_BASELINE_PORT_BASE=56300 scripts/verify-database-baseline.sh
scripts/product-local/stop.sh
```

Test accounts get random passwords written to `$TMPDIR/exacth2o-product-local/accounts.env` (mode 600,
outside the repository). Scenarios: `start.sh --scenario normal|board-outage|controller-offline|discrepancy`.

**Account isolation** is checked three ways: the SQL matrix (§2), the browser journeys (other-project and
viewer accounts on every new surface), and direct REST calls with each account's token inside the journeys.

**Scientific consistency** is checked by unit tests (`src/productModel.test.ts`, `src/workbenchRecord.test.ts`:
pot-equal weighting, gap rule, CSV values recomputed from their own pot rows, hidden-group invariance,
sidecar exclusion/revocation listing, calibration-step classification) and by the exclusion journey, which
compares on-screen statistics, CSV, methods JSON and SVG against a direct count in the database.

**Live verification for Codex** (authorized real account, after release): home shows the real experiments
with their configured counts and no exception line unless one is real; one experiment's Overview, Pots and
Record; a pot page from a copied link in a fresh tab; Bench says "Schematic" (no layout is recorded yet);
Pocket on a phone, write one note, see it on the pot page and in the Record; Workbench: save a private
comparison, add and revoke an exclusion, download the three exports; a viewer account sees no experiments
(existing policy) and cannot write; a gas-mixer-only account sees none of this; Walker admin view unchanged.

## 6. What is real, derived, simulated and verified

- **Recorded (real rows):** readings, valve events, plan revisions and assignments, audit events, controller
  commands, calibration requests, notes, layout versions, comparisons, exclusions, view marks.
- **Derived from recorded rows (labelled as derived):** gaps (from hourly reading presence), valve-opening
  density (controller events, never water), group statistics, home exceptions (judged as of the last
  successful check), the calibration-step explanation (computed from raw and calibrated values).
- **Simulated (never in the real portal):** the website's one-pot explainer (synthetic, labelled); `demo.html`
  and the Applications preview (sample data; aggregates computed in the browser from sample readings by
  `demo-preview/demoAggregates.ts`; saving is refused); the local product environment (`seed.sql`,
  `seed-commands.sql`, scenarios).
- **Verified:** a pot is "physically confirmed" only from `hardware_bindings.physical_status`; a recorded bench
  layout is "recorded", never "verified"; a command is "applied" only when the controller confirmed it.
- **What this handoff verified:** everything in §4 on the isolated local stack and the CI baseline. It did
  **not** verify against production data: there was no authorized production session in this work. That is
  Codex's live verification step.

## 7. Decisions for EJ

- **Hero claims.** The website hero's unsupported performance figures ("VWC Accuracy +4 / −2%", "Live
  Monitoring 24/7", "100 Individually Controlled Pots") were replaced with claims the site already supports:
  "Each pot — Its own target", "Every valve opening — Recorded", "Journal of Experimental Botany — Published"
  (the existing citation: Basyal et al., 2026, doi:10.1093/jxb/eraf533). EJ should approve or restore wording
  before release.

## 8. Not done / limitations

- **Offline cold start.** There is no service worker: Pocket must be loaded once while online. After that,
  notes written offline are kept in IndexedDB and survive reloads; the page itself cannot load from a cold
  start without a connection.
- **Production data not exercised** (see §6).
- Exclusions belong to a saved comparison (by design: one researcher's exclusion never silently changes
  another's analysis); there are no experiment-wide exclusions.
- Event alignment uses one event time for every pot in the comparison.
- The Record shows up to 300 controller commands and 1000 notes per window without saying when it hits
  those limits; windows are 14–120 days.
- Bench layout versions do not appear in the Record lane.
- Viewers cannot see experiments under the existing `experiments` policy, so Workbench and Record are not
  available to them; nothing here changes that.
- In the demos the Record is empty (sample experiments have no saved history), and saving comparisons is refused.
- Realtime is published for notes, but the portal refreshes notes on actions and polling rather than subscribing.
