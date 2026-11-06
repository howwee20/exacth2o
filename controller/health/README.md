# Controller health service

Run `python server.py` to start the existing HTTP service and background sampler.
Configuration still comes from the same environment variables and local files.

| File | Responsibility |
| --- | --- |
| `server.py` | HTTP routes, response shapes, collection orchestration and sampler startup |
| `health_config.py` | Environment configuration and defaults |
| `health_auth.py` | Login, session cookies and health-check credentials |
| `health_transport.py` | HTTP, SSH, local commands, sockets and response caching |
| `health_host.py` | Host, network, container and hardware observations |
| `health_controller.py` | Controller API observations and configuration snapshots |
| `health_measurements.py` | Pairings, readings, watering history and recorded legacy assignments |
| `health_scheduler.py` | Scheduler and Redis observations |
| `health_status.py` | Status calculation from collected observations |
| `health_history.py` | History storage, retention and restart summaries |
| `health_alerts.py` | Owner notification delivery and cooldown |
| `health_parsing.py` | Shared parsing and time formatting |

Start with the route in `server.py`, then follow its collector into the relevant
module. A status calculation should consume observations, not acquire them.
Keep network and subprocess calls in collectors or transports. Add regression
cases alongside `test_reporting.py` when changing interpretation of readings.
The legacy `RESEARCHER_MAP` is historical software evidence, not a substitute
for the authoritative physical map or current controller configuration.

Run `python3 -m unittest discover -s controller/health -p 'test_*.py'` from the
repository root. Tests use fixtures and local HTTP only. Build release packages
with `node scripts/build-controller-release.mjs`; both the full image and the
health overlay must include every `health_*.py` module.
