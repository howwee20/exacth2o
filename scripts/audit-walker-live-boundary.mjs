#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const oneWaySources = [
  "controller-release/walker-telemetry-publisher/src/index.mjs",
  "controller-release/walker-telemetry-publisher/src/publisher-core.mjs",
  "controller-release/walker-telemetry-publisher/src/state-store.mjs",
  "supabase/functions/receive-walker-telemetry/index.ts",
  "supabase/functions/receive-walker-telemetry/receiver-policy.mjs",
  "research-portal/src/WalkerObservationView.tsx",
  "research-portal/src/walkerObservation.ts",
  "research-portal/src/walkerObservationClient.ts",
];
const forbidden = [
  ["plain-feather identity", /plain-feather/i],
  ["Matt identity", /\bmatt\b/i],
  ["Walker public IP", /35\.10\.15\.132/],
  ["command table", /project_control_commands/],
  ["device control token", /device_control_tokens/],
  ["manual-water capability", /manual[_ -]?water/i],
  ["sensor initialization capability", /initialize[_ -]?sensors/i],
  ["valve capability", /\bvalves?\b|operate[_ -]?valve/i],
  ["target mutation", /update[_ -]?target/i],
  ["schedule mutation", /create[_ -]?schedule|assistant_schedules/i],
  ["controller mutation route", /\/v1\/system|\/v1\/boardConfigs|\/v1\/pairings/i],
];

const failures = [];
for (const relativePath of oneWaySources) {
  const contents = readFileSync(resolve(relativePath), "utf8");
  for (const [label, pattern] of forbidden) {
    if (pattern.test(contents)) failures.push(`${relativePath}: ${label}`);
  }
}

const publisher = readFileSync(
  resolve("controller-release/walker-telemetry-publisher/src/index.mjs"),
  "utf8",
);
if (/mysql|mariadb|\bSELECT\b|\bINSERT\b|\bUPDATE\b|\bDELETE\b/i.test(publisher)) {
  failures.push("publisher source contains a local database capability");
}
if (
  !/sensorReadUrl\.hostname !== "cron_svc"/.test(publisher) ||
  !/sensorReadUrl\.pathname !== "\/v1\/sensors"/.test(publisher) ||
  !/new URL\("\/v1\/state", sensorReadUrl\.origin\)/.test(publisher)
) {
  failures.push("publisher source is missing the fixed internal sensing route");
}
if (!/currentControllerState !== "STOPPED"/.test(publisher)) {
  failures.push("publisher source is missing the STOPPED-state sensing guard");
}
if (!/method: "GET"/.test(publisher)) {
  failures.push("publisher source is missing explicit read-only sensor requests");
}

const migration = readFileSync(
  resolve("supabase/migrations/20260726232000_create_walker_live_observation_v1.sql"),
  "utf8",
);
if (/from public\.sensor_readings/i.test(migration)) {
  failures.push("live read model queries the historical sensor_readings archive");
}
if (!/before update or delete on public\.walker_live_telemetry_readings/i.test(migration)) {
  failures.push("live telemetry append-only trigger is missing");
}
if (!/has_system_admin_installation_access/i.test(migration)) {
  failures.push("live observation RPCs are missing installation-level authorization");
}

if (failures.length) {
  process.stderr.write(
    `Walker live boundary audit failed:\n${failures.join("\n")}\n`,
  );
  process.exit(1);
}

process.stdout.write(
  "Walker live path is fixed-identity, STOPPED-state sensing-only, append-only, and contains no irrigation command surface.\n",
);
