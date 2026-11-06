import { readFile } from "node:fs/promises";

const healthPath =
  process.env.EXACTH2O_PUBLISHER_HEALTH || "/data/publisher-health.json";
const staleMs = Number(process.env.EXACTH2O_PUBLISHER_HEALTH_STALE_MS || 180000);

try {
  const health = JSON.parse(await readFile(healthPath, "utf8"));
  const lastSuccessAt = Date.parse(health.lastSuccessAt || "");
  const ageMs = Date.now() - lastSuccessAt;

  if (
    health.ok !== true ||
    !Number.isFinite(lastSuccessAt) ||
    ageMs < 0 ||
    ageMs > staleMs
  ) {
    throw new Error(
      `publisher unhealthy: ok=${health.ok} lastSuccessAgeMs=${ageMs}`,
    );
  }

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      cursorId: health.cursorId,
      latestKnownId: health.latestKnownId,
      pending: health.pending,
      lastSuccessAgeMs: ageMs,
    })}\n`,
  );
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
}
