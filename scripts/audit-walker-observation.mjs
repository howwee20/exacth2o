#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const files = [
  "research-portal/src/WalkerObservationView.tsx",
  "research-portal/src/walkerObservation.ts",
  "research-portal/src/walkerObservationClient.ts",
];
const forbidden = [
  ["Walker public IP", /35\.10\.15\.132/],
  ["Balena device URL", /balena-devices\.com/i],
  ["Walker API route", /\/v1\//],
  ["browser HTTP request", /fetch\s*\(\s*["'`]https?:/],
  ["control command table", /project_control_commands/],
  ["control enqueue RPC", /enqueue_portal_control_command/],
  ["manual water command", /manual_water/],
  ["sensor initialization command", /initialize_sensors/],
  ["valve operation", /valves?\/operate|operate[_ -]?valve/i],
];

const failures = [];
for (const relativePath of files) {
  const contents = readFileSync(resolve(relativePath), "utf8");
  for (const [label, pattern] of forbidden) {
    if (pattern.test(contents)) failures.push(`${relativePath}: ${label}`);
  }
}

if (failures.length) {
  process.stderr.write(`Walker observation control-surface audit failed:\n${failures.join("\n")}\n`);
  process.exit(1);
}

process.stdout.write(
  "Walker observation source contains no device URL, controller endpoint, or command path.\n",
);
