import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { agentRates, cycleForecast, installedClients, pricing, project } from "./edge-budget-model.mjs";

const repository = fileURLToPath(new URL("../../", import.meta.url));

test("installed client cadences are read from the shipped clients", () => {
  const clients = installedClients();
  assert.equal(clients.native.version, "exacth2o-gas-mixer-native-bridge/2.1.2");
  assert.equal(clients.screen.version, "exacth2o-gas-mixer-agent/1.0.1");
  assert.equal(clients.lighting.version, "exacth2o-lighting-bridge-2.1.0");
  assert.ok(clients.native.timeoutS === 20 && clients.screen.timeoutS === 20 && clients.lighting.readTimeoutS === 12);
});

test("the supported workload keeps 40% headroom under the 2M included invocations", () => {
  const normal = project("normal", "held");
  assert.ok(normal.total <= pricing.targetInvocations, `normal profile ${normal.total} exceeds ${pricing.targetInvocations}`);
  // Heavier use, or a production LISTEN failure, must still stay under quota.
  assert.ok(project("busy", "held").total < pricing.includedInvocations * 0.8);
  assert.ok(project("normal", "held-no-listener").total < pricing.includedInvocations * 0.8);
  // And the change must actually be a large saving over the 2026-10-20 server.
  assert.ok(normal.total < 0.6 * project("normal", "deployed-2026-10-20").total);
});

test("each installed agent stays inside its idle budget", () => {
  const held = agentRates(installedClients(), "held");
  assert.ok(held.native.unattendedPerDay <= 6_000, `native ${held.native.unattendedPerDay}/day`);
  assert.ok(held.screen.unattendedPerDay <= 6_000, `screen ${held.screen.unattendedPerDay}/day`);
  assert.ok(held.lighting.unattendedPerDay <= 9_000, `lighting ${held.lighting.unattendedPerDay}/day`);
  // Lighting must still re-sync inside its 15 s portal readiness window.
  assert.ok(held.lighting.unattendedCycleS < 12.5);
  // The native bridge's 45 s readiness window holds across a fully held cycle.
  assert.ok(held.native.unattendedCycleS < 45 + 16);
});

test("the model agrees with the committed benchmark of the real clients", () => {
  const benchmark = join(repository, "docs/performance/agent-benchmark-2026-10-21.json");
  if (!existsSync(benchmark)) return;
  const measured = JSON.parse(readFileSync(benchmark, "utf8")).after?.invocation_rates?.idle;
  if (!measured) return;
  const perDay = (prefix) => 24 * Object.entries(measured)
    .filter(([key]) => key.startsWith(prefix)).reduce((sum, [, value]) => sum + value.calls_per_hour, 0);
  const held = agentRates(installedClients(), "held");
  for (const [prefix, modeled] of [
    ["gas-mixer-native-agent:", held.native.unattendedPerDay],
    ["gas-mixer-agent:", held.screen.unattendedPerDay],
    ["lighting-native-agent:", held.lighting.unattendedPerDay],
  ]) {
    const observed = perDay(prefix);
    assert.ok(Math.abs(observed - modeled) <= 0.3 * modeled, `${prefix} measured ${observed}/day vs modeled ${Math.round(modeled)}/day`);
  }
});

test("cycle forecasts use real billing dates", () => {
  const forecast = cycleForecast(0, "2026-10-21T00:00:00Z", "2026-11-09T00:00:00Z", "2026-10-21T00:00:00Z", 26_800);
  assert.equal(forecast.remaining_days, 19);
  assert.equal(forecast.projected_cycle_total, 509_200);
  assert.equal(forecast.daily_rate_that_exhausts_quota, Math.round(2_000_000 / 19));
});

test("every portal polling loop is registered with its cadence", () => {
  const registry = JSON.parse(readFileSync(join(repository, "scripts/budget/polling-registry.json"), "utf8")).portal;
  const source = join(repository, "research-portal/src");
  const found = {};
  const walk = (directory) => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) { walk(path); continue; }
      if (!/\.tsx?$/.test(name) || name.includes(".test.") || name === "visiblePolling.ts") continue;
      const text = readFileSync(path, "utf8");
      const counts = {
        scheduleVisiblePolling: (text.match(/scheduleVisiblePolling\(/g) ?? []).length,
        setInterval: (text.match(/\bsetInterval\(/g) ?? []).length,
      };
      if (counts.scheduleVisiblePolling || counts.setInterval) found[relative(repository, path)] = counts;
    }
  };
  walk(source);
  for (const [file, counts] of Object.entries(found)) {
    const registered = registry[file];
    assert.ok(registered, `${file} polls but is not in scripts/budget/polling-registry.json`);
    for (const kind of ["scheduleVisiblePolling", "setInterval"]) {
      assert.ok(counts[kind] <= registered[kind],
        `${file} has ${counts[kind]} ${kind} loops; ${registered[kind]} registered. Register the new loop's cadence and Edge cost.`);
    }
  }
});
