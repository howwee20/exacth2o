# Matt controller release 4174753

- Balena fleet: `basyalbi/matt`
- Device: `plain-feather` (`3100e37ee3205651fe3dd86dafd4dc0c`)
- Release: `4174753`
- Commit: `64247b84ec92e193f806e5718c206ec4`
- Created: `2026-07-10T03:01:51Z`
- Rollback: release `4173986` (`c06746e0d24f8f00c1d5a08f9a18fd01`)

Safety state at release:

- Command intake remained off during deployment and readback verification.
- The executor was verified in dry-run before live configuration mode.
- Manual watering remained independently disabled in both Supabase and Balena.
- Sensor initialization remained disabled.
- Board configuration remained administrator-only.
- The controller configuration matched the protected pre-release 20-pairing snapshot exactly after deployment.
- Authoritative config hash after deployment: `8cbff570aa3307d723ece2998b6a373d6801176168b7413104a140ffa7876538`.

Validation:

- Cron/controller tests: 31 passed.
- Control executor tests: 22 passed.
- API and cron TypeScript builds passed.
- Health sidecar Python compilation passed.
- Authenticated controller readback returned 20 pairings, 2 calibrations, 3 boards, 100 sensors, 144 valves, and 2 groups.
