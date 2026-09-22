# Demo portal (`/demo`)

The shared demo account for prospective customers. Same production App and CSS as the portal, built separately with sample data and no network access; the page's CSP allows no connections.

- Sign-in: `demo@exacth2o.com` / `exacth2o-demo`. The real sign-in page at `/portal` hands this one email over to `/demo` without contacting Supabase (see `signIn` in `research-portal/src/App.tsx`). Any other email on `/demo` fails like a wrong password.
- Tiles: Experiment 1 (drought study, 20 pots), Experiment 2 (recovery study, 24 pots), Experiment 3 (crop comparison, 24 pots) and System Health. Every experiment opens the production VWC, watering, and overlay views. Fictional 72-hour moisture histories and irrigation events come from the same model; all three tiles connect to their shared System Health tile.
- Live feel: the live-readings subscription is kept and `offline.ts` feeds it a new reading per pot every 30 seconds; levels drift and managed pots receive irrigation pulses at their target. Every write action answers "The demo account can monitor only."

Build from the repository root (CI does the same, fails if `demo.html` is not stamped for the committed build, and publishes `demo-app/` plus `demo.html`):

```sh
node demo-preview/build.mjs
```

The script builds `demo-app/` and stamps the asset URLs in `demo.html` with the bundle hash, so a deploy is never served stale from browser or CDN caches. Commit both.

Verify locally with `python3 -m http.server` from the repository root and open `/demo.html`.

The three studies use distinct dry-down, recovery, and crop-dependent irrigation regimes. Each pot has independent uptake, substrate response, lag, and sensor noise. The live feed continues the historical model. All command RPCs, function invocations, and table writes are denied by the offline adapter; `connect-src 'none'` is a second network barrier.
