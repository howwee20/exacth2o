#!/usr/bin/env bash
# Run the installed lighting bridge (LightingAgentV2 2.1.0, unmodified) in a
# JDK 8 container against a LOCAL metering proxy. Usage:
#   run_lighting_bridge.sh <properties-file> <seconds> <work-dir>
# The properties file must point endpoint= at http://host.docker.internal:<proxy-port>/...
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../../.." && pwd)"
properties="$1"; seconds="$2"; work="$3"
if ! grep -Eq '^endpoint=http://(host\.docker\.internal|127\.0\.0\.1|localhost):' "$properties"; then
  echo "harness lighting bridge only talks to a local stack" >&2
  exit 2
fi
mkdir -p "$work/classes"
docker run --rm \
  -v "$root/controller-release/lighting-bridge/src:/src:ro" \
  -v "$here/java:/harness:ro" \
  -v "$work:/work" \
  -v "$properties:/work/lighting.properties:ro" \
  eclipse-temurin:8-jdk sh -c "
    javac -nowarn -source 1.7 -target 1.7 -d /work/classes \
      /src/com/exacth2o/lighting/LightingAgentV2.java \
      /harness/PhenoSystemControl/control/io/Control.java \
      /harness/harness/LightingHarness.java 2>/dev/null &&
    exec java -Djava.awt.headless=true -cp /work/classes harness.LightingHarness /work/lighting.properties $seconds"
