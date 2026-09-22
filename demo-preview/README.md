# Demo portal (`/demo`)

The shared demo account for prospective customers. Same production App and CSS as the portal, built separately with sample data and no network access; the page's CSP allows no connections.

- Sign-in: `demo@exacth2o.com` / `exacth2o-demo`. The real sign-in page at `/portal` hands this one email over to `/demo` without contacting Supabase (see `signIn` in `research-portal/src/App.tsx`). Any other email on `/demo` fails like a wrong password.
- Tiles: Experiment 1 (running, controller-managed watering), Experiment 2 (completed), Experiment 3 (sensing-only observation) and System Health. Every tile opens the production detail view.
- Live feel: the live-readings subscription is kept and `offline.ts` feeds it a new reading per pot every 30 seconds; levels drift and managed pots receive irrigation pulses at their target. Every write action answers "The demo account can monitor only."

Build from the repository root (CI does the same and publishes `demo-app/` plus `demo.html`):

```sh
node research-portal/node_modules/vite/bin/vite.js build --config demo-preview/vite.config.mjs
```

Verify locally with `python3 -m http.server` from the repository root and open `/demo.html`.
