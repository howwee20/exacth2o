# ExactH2O controller release add-ons

This folder is for controller-side Balena services that are not part of the public GitHub Pages site.

Current production sources:

- `control-executor/` - a dry-run-first command bridge that claims Supabase `project_control_commands` rows with a device token, calls the local controller API, then writes truthful command completion status.
- `matt-balena-release-4174753/` - the complete secret-free Balena source lineage for Matt's controller. Despite the historical folder name, this source was most recently verified against deployed release `4213007` (`a2f056cbc2c99bc2013d8200a277c32f`) on 2026-07-28. It includes the authenticated controller config publisher, atomic STOPPED-state mutation gate, persisted controller-owned manual-pulse timer, restart recovery, and the hardened executor.
- `walker-telemetry-publisher/` - a separate Gate B staging package for one-way, readings-only Walker VWC publication. It is not part of a live Walker release and must not be deployed until its exact source/release reconciliation and explicit approval gate are complete.

Rollback target for the next controller rollout: release `4213007` (`a2f056cbc2c99bc2013d8200a277c32f`). Reverify this immediately before deployment; release and source claims are time-sensitive. The pre-release greenhouse config is preserved outside this repository in the protected release evidence directory.

Do not deploy this to a live greenhouse until all of the following are true:

1. The exact current Balena source/release has been identified.
2. The Supabase RPC migration has been applied in the target project.
3. The shared owner-health readback secret and the dedicated controller command secret are present in the executor without exposing either value.
4. The executor has run in dry-run mode against the target controller and its readiness heartbeat reports the expected version, dry-run state, readback readiness, and local API reachability.
5. Any active command quarantine is reconciled only while the controller is confirmed `STOPPED`, both pulse ledgers have no active pulse, every valve is independently confirmed closed, and no command is running.
6. A non-mutating `export_data` command succeeds before live controller mutations are enabled.
7. Manual water remains independently disabled. Do not enable `MANUAL_WATER_INTAKE_ENABLED` or `EXACTH2O_MANUAL_WATER_ENABLED` as part of experiment self-service.
8. Rollback is ready: set the executor back to dry-run, disable command intake or the device token, inspect any in-flight command, and pin the previous verified Balena release if necessary.
9. The user has explicitly approved the concrete stop, reconciliation, live-executor enablement, and automatic-watering resume steps.
