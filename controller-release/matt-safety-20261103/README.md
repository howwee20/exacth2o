# Controller safety and publisher identity release

This package layers the tested scheduler and publisher changes onto the exact
images from live release **4436531**, commit `6f5800e9e194bb34f9dc98cd8fccf4a6`.
Its composition is copied from that release. Database volumes, environment,
watchdog, executor, API, UI, Redis and health images are preserved.

Only `cron_svc` and `supabase_publisher` gain layers. The scheduler payload
contains both TypeScript source and the corresponding compiled JavaScript.
The publisher keeps the existing durable cursor and legacy epoch on upgrade;
new or reset source databases receive a persistent identity epoch.

The canonical 95-route map and five unknown routes are unchanged. This package
does not change thresholds, pairing destinations, calibration or experiment
settings. The baseline image digests are recorded in `baseline-images.json`.

Validation: 122 controller tests passed (2 skipped), the TypeScript build passed,
and all 6 publisher tests passed. Regression cases cover final valve admission,
close-timer installation before persistence, manual-hold preemption during a
pending write, and preservation of a new publisher epoch across restart.

The maintained inputs are in `controller/cron/` and `controller/supabase-publisher/`.
Generate the payload and its compiled JavaScript from those inputs.

```sh
npm ci --prefix controller/cron
node scripts/build-controller-release.mjs matt-safety-20261103 /tmp/exacth2o-safety-release
balena push basyalbi/matt --source /tmp/exacth2o-safety-release --draft
```

Build as a draft, compare all image digests and the normalized composition,
then pin only the intended device. Read back installed payload hashes, controller
status, unchanged pairing settings, publisher cursor progress and backend
ingestion. Do not send a watering command as a deployment smoke test.

Rollback: pin device `3100e37ee3205651fe3dd86dafd4dc0c` to
`6f5800e9e194bb34f9dc98cd8fccf4a6`. Preserve all volumes. That restores the earlier
software, including its known safety and identity limitations; prefer a forward
repair where possible. A successful software readback is not physical valve
closure or delivery verification.
