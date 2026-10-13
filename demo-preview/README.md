# Demo portal (`/demo`)

The public demo uses the production App and CSS with an offline, read-only dataset. The page CSP prevents controller connections.

- Drought response: ten recorded channels from Binod’s July–August 2023 CSV, with exact moisture and temperature values and a uniform date shift for replay. No invented raw readings, calibration or valve events.
- Recovery after drought: 24 pots over seven days, with control, early, delayed and gradual recovery groups derived from the source patterns.
- Crop comparison: 24 pots over ten days, with distinct assumed maize, soybean and sorghum water use at a shared target. These are derived scenarios, not measured species results.
- Recorded readings replay at their original cadence and stop at the source endpoint. Derived scenarios continue their deterministic state models. All write actions are denied.

See [data/README.md](data/README.md) for source provenance, channel selection and transformation details. The Applications embed uses this same dataset. Source details are available in the existing Record notes; headings focus on experiment names.

Build all public surfaces from the repository root with `node scripts/build-product-release.mjs`, then commit the generated assets and wrappers. Run `npm run check --prefix research-portal` before publishing.
