# ExactH2O releases

Production source: `ej-supabase-research-portal`. The older `main` branch is not the website source.
Production: https://exacth2o.com · Portal: https://exacth2o.com/portal · Demo: https://exacth2o.com/demo

## Publish

1. Install portal dependencies with `npm ci --prefix research-portal`.
2. Build the assembled release with `node scripts/build-product-release.mjs`.
3. Review and commit source plus generated `portal-app`, `demo-app`, `applications-demo-app`, `portal.html`, `demo.html`, and `site-metrics.js`.
4. Push to `ej-supabase-research-portal`. The Publish workflow runs portal lint, seven focused data/control checks, a reproducible build of the committed release, and three Chromium browser smoke checks. Pull requests run the same gate without deploying. A manual publish deploys only from `ej-supabase-research-portal`.
5. Verify the deployed commit, demo navigation and refresh, and the affected real portal screens.

## Fast UI deployment gate

For a normal portal/layout/copy change, run:

1. `npm run lint --prefix research-portal`
2. `npm run test:release --prefix research-portal`
3. `node scripts/build-product-release.mjs`
4. `npm run audit:portal-surface --prefix research-portal`
5. `npm run test:release:browser --prefix research-portal`

The test gate contains exactly ten cases, selected explicitly in `research-portal/scripts/release-checks.mjs`. The runners fail if a selected case is missing or skipped.

- Seven data/control checks: experiment boundaries and renamed sensors; complete paged history; invalid readings and chart gaps; target changes limited to the selected pots; stopping a manual hold; honest command completion; and refusing controller commands from viewers or unknown roles.
- Three browser checks: Control confirmation; Drought confirmation; and the built portal's navigation, shared time range, export, and desktop/mobile layout. Chromium is the fast gate. The full three-browser suite stays separate.

Do not put the full `npm test` / `npm run check`, 100-pot simulations, randomized calibration sweeps, chamber/native-agent suites, or dependency audits back into the routine UI publish job. They remain available through the manual workflows below. The polling-budget workflow runs for polling/transport/backend changes, not every portal source edit.

## Broader checks, run separately

- `npm test --prefix research-portal -- --maxWorkers=2`: all portal tests, including the 100-pot simulations. Run when the affected control/calibration logic warrants them, or launch `verify-artifacts.yml` manually for full portal/artifact validation.
- `verify.yml` (manual): database, Edge Function, controller, and native-agent verification. Run the relevant checks for backend/device changes. Before database migrations or agent Edge Function deploys, run this workflow and inspect `supabase db push --dry-run`.
- `responsive.yml` (manual): the full Chromium, Firefox, and WebKit acceptance and screenshot suite.
- `npm audit --prefix research-portal`: dependency audit, also included in the manual full-verification workflows.

Building the portal republishes the committed gas-mixer agent and native-bridge files at their website URLs. Stage unverified device clients elsewhere (`controller-release/staged-agents/`). The UI release gate is not device-firmware validation.

## Browser acceptance

Use the actual public wrapper, not only the Vite entry. Check desktop and a 390px viewport. A complete product pass covers Home → Demo → Experiment → Pot → Record → Export; copied demo links, refresh and Back; Account from Home and Bench; experiment-scoped settings; installation-scoped settings; completed experiment records/exports; and a stale machine's last recorded window. The demo must stay under `/demo`, including on the production hostname. Verify viewer and admin permissions using isolated accounts. Never submit a hardware operation as a cosmetic smoke test.

The demo workspace and Applications embed use offline fixtures and cannot operate a controller. Local preview servers are task-specific; do not stop or modify a server owned by another chat.
