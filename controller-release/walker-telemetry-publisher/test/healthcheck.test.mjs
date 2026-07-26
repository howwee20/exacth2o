import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const healthcheck = new URL("../src/healthcheck.mjs", import.meta.url);

async function withHealthFile(value, operation) {
  const directory = await mkdtemp(join(tmpdir(), "walker-health-"));
  const path = join(directory, "health.json");
  await writeFile(path, JSON.stringify(value));
  try {
    return operation(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("healthcheck accepts a current fixed-identity heartbeat", async () => {
  await withHealthFile({
    publisher_instance: "walker-pi5-a1c4ace2",
    cursor: 1518645,
    last_success_at: new Date().toISOString(),
  }, (path) => {
    const result = spawnSync(process.execPath, [healthcheck.pathname], {
      encoding: "utf8",
      env: {
        ...process.env,
        WALKER_TELEMETRY_HEALTH_PATH: path,
        WALKER_TELEMETRY_HEALTH_MAX_AGE_MS: "90000",
      },
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), "healthy");
  });
});

test("healthcheck rejects stale health", async () => {
  await withHealthFile({
    publisher_instance: "walker-pi5-a1c4ace2",
    cursor: 1518645,
    last_success_at: new Date(Date.now() - 120_000).toISOString(),
  }, (path) => {
    const result = spawnSync(process.execPath, [healthcheck.pathname], {
      encoding: "utf8",
      env: {
        ...process.env,
        WALKER_TELEMETRY_HEALTH_PATH: path,
        WALKER_TELEMETRY_HEALTH_MAX_AGE_MS: "90000",
      },
    });
    assert.notEqual(result.status, 0);
  });
});
