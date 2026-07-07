# ExactH2O controller release add-ons

This folder is for controller-side Balena services that are not part of the public GitHub Pages site.

Current add-on:

- `control-executor/` - a dry-run-first command bridge that claims Supabase `project_control_commands` rows with a device token, calls the local controller API, then writes truthful command completion status.

Do not deploy this to a live greenhouse until all of the following are true:

1. The exact current Balena source/release has been identified.
2. The Supabase RPC migration has been applied in the target project.
3. A device token has been created with `create_device_control_token(...)` and stored as a Balena env var.
4. The executor has run in dry-run mode against the target controller.
5. Manual water has been bench-tested with physical valve-close verification.
6. Rollback is ready: disable/remove `control_executor` from the Balena release and revoke the device token.
7. The user has explicitly approved a concrete live deploy step.

