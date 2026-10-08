# Exact H2O coherent portal — implementation record

Implementation owner: Opus (this branch). Release owner: Codex (review, migrations, merge,
deployment, live verification). Visual reference: the six local design-lab prototypes
(`exacth2o-design-lab/design-lab`). Source of truth: the live application, its tables and its
scientific records. Nothing in this branch imports a prototype fixture, sample clock, review
toolbar, local-only state or the copied website baseline.

## Decisions that shape everything

| Topic | Decision | Why |
|---|---|---|
| Routing | Query-string routes under `/portal` (`?experiment=…&tab=…`, `?pot=…`, `?view=bench`, …), History API, `popstate`. | `portal.html` canonicalises every path to `/portal` and GitHub Pages has no SPA fallback; query routes survive refresh, copied links and QR codes without server configuration. Existing `/portal`, `?project=`, `?invite=`, recovery links keep working. |
| Identity | Project = `portal_access.project_id` (+ `?project=`), controller = the project's device (`device_config_state`), experiment = catalog slug (unique per project), pot = pairing name on that device (`Zone<z>-Pot<p>`), with the physical anchor `research_pots.id` resolved through the active `hardware_bindings` row when one exists. `?pot=<uuid>` resolves to the bound pairing. | These are the identities the database already enforces (`UNIQUE(device_id,name)`, `UNIQUE(project_id,slug)`), so every view resolves to the same records. |
| Data access | Browser uses the anon key and the signed-in user's RLS. New user-authored rows (notes, comparisons, exclusions, last-seen) are written under RLS with `created_by = auth.uid()` enforced in policies; shared layout versions are admin-only under RLS. No service-role key in the browser; no new controller-affecting path. | Matches the existing portal pattern; nothing here is a privileged controller write. |
| Notes | New additive table `portal_pot_notes` (no notes table existed). Client-generated UUID primary key; idempotent insert (`on conflict do nothing`); append-only with corrections as superseding notes. | Stable IDs make offline retries idempotent; append-only keeps the scientific record auditable. |
| Bench layout | Read `research_pots` / `physical_positions` / `hardware_bindings`. Recorded layouts are appended to `portal_bench_layout_versions` (versioned, never edited in place). Without a recorded layout the bench is an explicitly schematic numbered layout. | `physical_positions` has no confirmation or version fields and is a one-time snapshot; inventing positions is not allowed. |
| Statistics | Pot is the experimental unit. Each pot contributes one value per time bucket (its mean in the bucket); the group value is the median across pots; the band is min–max across pots (never called a confidence interval). Exclusions remove readings before every statistic, figure, CSV and sidecar. Hidden lines change presentation only. | Prevents uneven sampling from silently re-weighting pots; one exclusion model feeds every output. |

## Slices

1. Shared routing and design system, Quiet Spine home, Waterline overview, experiment Pots tab and pot page, installation Trends, public one-pot explainer.
2. Bench (layout, lookup, board groupings, versioned recorded layouts) and At the bench / Pocket (number pad, recent pots, notes with a durable offline outbox).
3. Workbench (server-saved comparisons, sharing, alignment, paginated history, exclusions, exports) and Record (event lane, calibration explanation, since-you-last-looked).

Progress, validation results and the release handoff are recorded in `docs/product/HANDOFF.md`.
