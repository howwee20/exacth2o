# Responsive acceptance

The production Pages workflow runs only the build consistency check and seven focused data/control checks. Three selected Chromium smoke checks remain available locally via `npm run test:release:browser`; browser installation and execution are not on the deployment path. This full suite runs separately through the manual `responsive.yml` workflow. Six viewport sizes cover 320 to 3440 pixels, including a short laptop and phone viewport. Each engine checks 14 routes at each size, dialog fit, text enlargement, the homepage opening and simulator order, deferred measurement loading, saved comparison restoration, the compact export header, provenance and the mobile Applications embed.

Twenty-seven versioned screenshots cover Home, Traces and Sign in at phone, laptop and ultrawide sizes in all three engines. Time, locale and motion are fixed for reproducibility. View failed image differences and interaction traces in the `responsive-review` Actions artifact.

Updating images is a review step: generate candidates with `npx playwright test --update-snapshots` in the same Ubuntu/browser environment, inspect them, then commit approved PNGs. The implementation branch captures candidate images; production always compares against committed baselines. Browser engines and viewport emulation complement physical-device testing, not replace it.
