import { readFile } from "node:fs/promises";

const healthPath =
  process.env.WALKER_TELEMETRY_HEALTH_PATH ??
  "/var/lib/walker-telemetry/health.json";
const maximumAgeMs = Number(
  process.env.WALKER_TELEMETRY_HEALTH_MAX_AGE_MS ?? 90_000,
);

if (
  !Number.isSafeInteger(maximumAgeMs) ||
  maximumAgeMs < 30_000 ||
  maximumAgeMs > 600_000
) {
  throw new Error("Invalid Walker telemetry health maximum age");
}

const health = JSON.parse(await readFile(healthPath, "utf8"));
const lastSuccessAt = Date.parse(health.last_success_at);
if (
  health.publisher_instance !== "walker-pi5-a1c4ace2" ||
  !Number.isSafeInteger(health.cursor) ||
  health.cursor < 0 ||
  !Number.isFinite(lastSuccessAt) ||
  Date.now() - lastSuccessAt > maximumAgeMs ||
  lastSuccessAt - Date.now() > 300_000
) {
  throw new Error("Walker telemetry publisher health is stale or invalid");
}

process.stdout.write("healthy\n");
