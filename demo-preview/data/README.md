# Demo data provenance

`ExactH2O_dummy_interface.csv` is the unchanged attachment supplied by Binod Basyal in “soil moisture data for dummy interface”, 12 October 2026, 4:07 PM, to EJ's ExactH2O mailbox. The user authorized using it in the public demo on 13 October 2026.

The file has 12,753 rows, 16 sensor channels A–P, and VWC/temperature columns. The original clock runs from 2023-07-06 11:46 through 2023-08-03 13:16 at 3–4 minute intervals. Timezone and temperature units were not specified. Measurement_ID is retained as an identifier; it is not substituted for the Date clock (they differ by approximately nine hours). No target, crop, raw sensor signal, EC, calibration or valve-event data was supplied.

## Drought response: recorded values

| Demo pot | Source channel | Inferred treatment |
| --- | --- | --- |
| 61 | A | Watered |
| 62 | B | Drought |
| 63 | C | Drought |
| 64 | E | Watered |
| 65 | G | Drought |
| 66 | H | Watered |
| 67 | L | Watered |
| 68 | M | Drought |
| 69 | N | Watered |
| 70 | O | Watered |

Treatment assignments are inferred from trajectories, not a supplied treatment key. K's VWC duplicates E in every row. D, F, I, J and P are omitted to focus the demo on a stable watered subset alongside all four drying channels. This is a display selection, not a conclusion that omitted measurements are invalid or proof of a ±4% precision specification. No selected measurements are smoothed, rounded, scaled or filled. Original values remain in the CSV and generated JSON.

`node scripts/prepare-demo-source.mjs` regenerates `binod-source.json` losslessly; it includes the source SHA-256, original clocks and IDs. At page load, the last source day is reserved for replay. Earlier rows populate history; subsequent exact source rows appear when their original relative time arrives. A single offset maps the source clock into the current demo dates. The current offset and source replay position are recorded in the existing Pot 61 provenance note. Reload restarts the same replay position. Playback stops at the end of the file, with no fabricated continuation. Missing source fields stay null, and no real-study valve events or calibration changes are invented.

## Recovery after drought: simulation

24 pots, seven days, shared 25% target. Pots 1–6 remain watered, 7–12 begin early recovery around hour 108, 13–18 begin delayed recovery around hour 144, and 19–24 begin gradual recovery around hour 126 over 24 hours. Starts are staggered by replicate. Dry-downs are informed by the shapes of B/C/G/M, with time compression, normalization and individual uptake. Recovery uses simulated pulses with absorption lag and ongoing water loss. The timings deliberately make the three recoveries visible in the recent window. Valve records and temperatures are simulated, not source observations.

## Crop comparison: simulation

24 pots, ten days, shared 25% target. Illustrative maize (101–108), soybean (109–116) and sorghum (117–124) differ in assumed water use and therefore irrigation frequency. These are fictional species scenarios, not species-specific findings or predictions from the source. Per-pot uptake and irrigation gains use deterministic seeds. Short-timescale differences from stable source channels supply bounded texture; complete traces are not duplicated. Valve events originate from the same state model as moisture responses. Temperature is derived/perturbed and labeled simulated; raw signal and EC remain null.

Both the standalone demo and the Applications preview consume the same datasets and full-history aggregates. The UI, production portal, live database and controller interfaces are unchanged. Notes in the existing Record distinguish recorded and simulated content.
