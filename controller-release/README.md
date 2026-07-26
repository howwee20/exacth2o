# ExactH2O controller release add-ons

This folder is for controller-side Balena services that are not part of the public GitHub Pages site.

Current production sources:

- `control-executor/` - a dry-run-first command bridge that claims Supabase `project_control_commands` rows with a device token, calls the local controller API, then writes truthful command completion status.
- `matt-balena-release-4174753/` - the complete secret-free Balena source used to build Matt release `4174753` (`64247b84ec92e193f806e5718c206ec4`). It includes the authenticated controller config publisher, atomic STOPPED-state mutation gate, persisted controller-owned manual-pulse timer, restart recovery, and the hardened executor.
- `walker-telemetry-publisher/` - a separate Gate B staging package for one-way, readings-only Walker VWC publication. It is not part of a live Walker release and must not be deployed until its exact source/release reconciliation and explicit approval gate are complete.

Rollback target: release `4173986` (`c06746e0d24f8f00c1d5a08f9a18fd01`). The pre-release greenhouse config is preserved outside this repository in the protected release evidence directory.

Do not deploy this to a live greenhouse until all of the following are true:

1. The exact current Balena source/release has been identified.
2. The Supabase RPC migration has been applied in the target project.
3. A device token has been created with `create_device_control_token(...)` and stored as a Balena env var.
4. The executor has run in dry-run mode against the target controller.
5. Manual water has been bench-tested with physical valve-close verification. Release `4174753` keeps both `MANUAL_WATER_INTAKE_ENABLED=0` and `EXACTH2O_MANUAL_WATER_ENABLED=0` until that check is recorded.
6. Rollback is ready: disable/remove `control_executor` from the Balena release and revoke the device token.
7. The user has explicitly approved a concrete live deploy step.
