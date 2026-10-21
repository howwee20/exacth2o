# Permanent health reporting release

This release packages the October 20 health reporting fix in an immutable image.
The Pot93/Pot95 reference follows the saved experiment revisions, and scheduler
diagnostics compare pending jobs with the live configured pairing count. It does
not change sensor assignments, valve outputs, thresholds, calibration or watering.

## Deployment

- Fleet: `basyalbi/matt`; device: `plain-feather` (`3100e37ee3205651fe3dd86dafd4dc0c`).
- Baseline release: `4412046`, commit `0c3d6fe77dcf5619fe0b57a11c4ae51c`.
- New release: `4427639`, commit `94f7fea4cddc79cedc04c59d6339b464`.
- The release is finalized and the device is pinned to it. Its health container started at
  `2026-10-21T01:15:15Z`.

The cloud builder reused the exact baseline content digests for seven services;
only `health_svc` gained a layer. The release composition is identical to the
baseline composition. On-device verification confirmed all seven other container
IDs, images and start times were unchanged.

At `2026-10-21T01:15:55Z`, the controller remained `RUNNING`, health was `OK`,
there were no active alerts, and scheduler diagnostics reported 45/45 jobs.
The full configuration hash before and after was
`3a68b215a5a1ca3866a9a7dc09884e7519cd4b2a551df015ea461fc8b8654f2c`.
All three installed health payload files matched this source by SHA-256.

## Maintaining the fix

The maintained health source is `../matt-balena-release-4174753/health`.
Refresh `health_svc/server.py`, `health_svc/static/app.js` and
`health_svc/static/index.html` from that source when changing diagnostics.
CI tests both the reporting behavior and equality of the packaged payload with
the maintained source. Do not rebuild a replacement health service using the
old base image alone; its diagnostic reference predates this correction.

Build a draft with `balena push basyalbi/matt --source <this-directory> --draft`.
Compare its composition and image digests with the intended live baseline before
pinning a device. Verify controller state/configuration, health payload hashes,
and unchanged container start times before finalizing. Never use a fleet rebuild
to apply unrelated irrigation changes without reviewing their effect.

## Rollback

`balena device pin 3100e37ee3205651fe3dd86dafd4dc0c 0c3d6fe77dcf5619fe0b57a11c4ae51c`
restores the prior image release. Its old diagnostics may report the obsolete
mapping/scheduler warnings again. A rollback does not restore the earlier
container-only hotfix. No database or controller configuration rollback is needed
for this reporting-only release.
