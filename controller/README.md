# Maintained controller source

| Service | Entry point | Responsibility |
| --- | --- | --- |
| Scheduler | `cron/src/index.ts` | Sensor sampling, watering rules, valve arbitration and watchdog |
| Local API | `api/src/index.ts` | Controller inventory, configuration and local commands |
| Local dashboard | `ui/src/` | On-controller user interface |
| Health | `health/server.py` | Diagnostics and owner health reporting |
| Command executor | `control-executor/src/control-executor.mjs` | Cloud command claims, local execution and completion reports |
| Telemetry publisher | `supabase-publisher/src/publisher.mjs` | Durable sensor upload and identity |

`docker-compose.yml` describes the complete service bundle. Keep edits in these
source directories and generate deployable packages with
[`scripts/build-controller-release.mjs`](../scripts/build-controller-release.mjs).
Pinned-image overlay recipes and their historical notes live in
[`controller-release/`](../controller-release/).

`RELEASE.md` records the original source lineage. Its historical release and
configuration identifiers are retained as evidence of that rollout.

## Local checks

```sh
npm ci --prefix controller/api
npm test --prefix controller/api
npm run build --prefix controller/api
npm ci --ignore-scripts --prefix controller/cron
npm test --prefix controller/cron
npm run build --prefix controller/cron
npm test --prefix controller/control-executor
npm test --prefix controller/supabase-publisher
python3 -m unittest discover -s controller/health -p 'test_*.py'
```

The unit tests use mocked controller interfaces. Device deployment requires the
reviewed target release, configuration and operating state.
