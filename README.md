# ExactH2O

ExactH2O is a multi-tenant research portal, experiment service, telemetry
system, and approval-gated irrigation controller.

The maintained website branch is `ej-supabase-research-portal`.
Researchers use the portal to configure experiments, inspect sensor and watering
history, add notes, and export data. Experiment changes are reviewed before
controller commands are submitted.

## Find the code for a feature

| Area | Start here |
| --- | --- |
| Public website | [index.html](index.html), [homepage.css](homepage.css), and the other root HTML/CSS/JavaScript files |
| Login, invites and recovery | [usePortalAuth.ts](research-portal/src/usePortalAuth.ts) and [auth/AuthScreen.tsx](research-portal/src/auth/AuthScreen.tsx) |
| Portal startup and page coordination | [research-portal/src/main.tsx](research-portal/src/main.tsx) and [App.tsx](research-portal/src/App.tsx) |
| Experiment screens | [research-portal/src/product/](research-portal/src/product/) |
| Experiment catalog and API requests | [experimentRegistry.ts](research-portal/src/experimentRegistry.ts) and [experimentClient.ts](research-portal/src/experimentClient.ts) |
| Sensor history | [useExperimentReadings.ts](research-portal/src/useExperimentReadings.ts) and [portalReadings.ts](research-portal/src/portalReadings.ts) |
| Charts and settings | [charts/](research-portal/src/charts/) and [settings/](research-portal/src/settings/) |
| Cloud functions and database | [supabase/functions/](supabase/functions/) and [supabase/migrations/](supabase/migrations/) |
| Pi scheduler startup | [cron/src/index.ts](controller/cron/src/index.ts) |
| Pi scheduler services | [cron/src/services/](controller/cron/src/services/) |

`controller/` contains the maintained Pi services. `controller-release/` keeps
pinned release recipes. Build their payloads from the maintained source with
[scripts/build-controller-release.mjs](scripts/build-controller-release.mjs).

`portal-app/`, `demo-app/`, and `applications-demo-app/` contain generated browser
builds. Edit the source and rebuild with `node scripts/build-product-release.mjs`.
The build retains older hashed assets for browser tabs opened before an update.

## Run and verify the portal

Use Node 24. From the repository root, install dependencies with
`npm ci --prefix research-portal` and start the local portal with
`npm run dev --prefix research-portal`.

Run `npm run lint --prefix research-portal`,
`npm run typecheck --prefix research-portal`, and
`npm test --prefix research-portal -- --maxWorkers=2` for source checks.
Follow [RELEASING.md](RELEASING.md) for the assembled website, offline demos,
browser acceptance checks, and publishing procedure.

## Architecture and operations

- [Platform contracts and architecture](platform/README.md)
- [Production operations](platform/OPERATIONS.md)
- [Controller simulator](platform/controller-simulator/README.md)
- [Database baseline and restoration](supabase/baseline/README.md)
- [Supabase deployment requirements](supabase/README.md)
- [Research portal](research-portal/README.md)

The operation ledger distinguishes a command from a verified physical outcome.
A successful valve command does not prove water delivery; flow, pressure,
weight, or equivalent evidence is required for that claim.
