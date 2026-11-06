# Controller release recipes

Maintained Pi source lives in [`controller/`](../controller/). The complete
controller, health service, scheduler, API, UI, publisher and command executor
are edited there. Gas-mixer, lighting and Walker observation clients retain
their separate directories in this folder.

The dated health and safety directories contain pinned baseline images,
Dockerfiles, release notes and source maps. Their payloads are generated from
`controller/` so each maintained source file has one copy.

## Build a package

Use Node 24. Output directories must be empty.

```sh
node scripts/build-controller-release.mjs full /tmp/exacth2o-controller
node scripts/build-controller-release.mjs control-executor /tmp/exacth2o-executor
node scripts/build-controller-release.mjs matt-health-reporting-20261020 /tmp/exacth2o-health
npm ci --prefix controller/cron
node scripts/build-controller-release.mjs matt-safety-20261103 /tmp/exacth2o-safety
```

Each package includes `source-manifest.json` with the source revision and file
hashes. The safety recipe compiles its three scheduler files from TypeScript.
The full package builds its services through the existing Dockerfiles.

Review the recipe's release notes and the current device's image composition
before a device rollout. These recipes preserve historical deployment evidence.
Their dates and baseline releases describe the recorded rollout, so verify the
current device release before choosing a baseline.

The separate [`walker-telemetry-publisher/`](walker-telemetry-publisher/) and
[`staged-agents/`](staged-agents/) packages retain their own deployment status
and instructions.
