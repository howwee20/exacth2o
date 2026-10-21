# Release verification — 2026-10-21

Release in progress. Production base: `49755782b3812da4c020c69050da49fe255d1a75`.

Independent checks completed: controller and API test suites and TypeScript builds; both executor packages; command, topology and hold policy tests; Deno checks of both changed functions; assembled product build and portal surface audit.

Browser configuration now accepts `EXACTH2O_PREVIEW_PORT` and `EXACTH2O_HARNESS_PORT`, allowing isolated checks against this checkout without reusing another checkout’s server. Full responsive, autocalibration and hold browser checks are in progress.

Production database dry-run lists only `20261021160000_full_scale_autocalibration_and_manual_hold.sql`. Controller baseline release is 4427639. Physical water delivery, real-phone behavior and RESET wiring remain unverified.
