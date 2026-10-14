# ExactH2O releases

Production source: `ej-supabase-research-portal`. The older `main` branch is not the website source.
Production: https://exacth2o.com · Portal: https://exacth2o.com/portal · Demo: https://exacth2o.com/demo

## Publish

1. Install portal dependencies with `npm ci --prefix research-portal`.
2. Build the assembled release with `node scripts/build-product-release.mjs`.
3. Review and commit source plus generated `portal-app`, `demo-app`, `applications-demo-app`, `portal.html`, `demo.html`, and `site-metrics.js`.
4. Push to `ej-supabase-research-portal`. The Publish workflow packages the committed files and deploys directly to GitHub Pages. Publishing waits for the portal/build checks, database regression checks, and responsive/visual browser checks.
5. Verify the deployed commit, demo navigation and refresh, and the affected real portal screens.

## Checks when changing software

Run `npm run check --prefix research-portal` locally. The production Publish workflow also verifies the committed release build, controller authentication, database policies and browser acceptance before publishing. Browser checks run in Chromium, Firefox and WebKit; approved visual baselines are committed under `research-portal/browser-tests`. Database schema migrations are deployed separately with Supabase after inspecting `supabase db push --dry-run`.

## Browser acceptance

Use the actual public wrapper, not only the Vite entry. Check desktop and a 390px viewport. A complete product pass covers Home → Demo → Experiment → Pot → Record → Export; copied demo links, refresh and Back; Account from Home and Bench; experiment-scoped settings; installation-scoped settings; completed experiment records/exports; and a stale machine's last recorded window. The demo must stay under `/demo`, including on the production hostname. Verify viewer and admin permissions using isolated accounts. Never submit a hardware operation as a cosmetic smoke test.

The demo workspace and Applications embed use offline fixtures and cannot operate a controller. Local preview servers are task-specific; do not stop or modify a server owned by another chat.
