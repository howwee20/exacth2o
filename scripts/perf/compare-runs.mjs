#!/usr/bin/env node
// Markdown comparison of two measure-web.mjs result files (median, with min–max).
//   node scripts/perf/compare-runs.mjs baseline-mobile.json after-mobile.json
import { readFileSync } from "node:fs";

const [beforePath, afterPath] = process.argv.slice(2);
const before = JSON.parse(readFileSync(beforePath, "utf8"));
const after = JSON.parse(readFileSync(afterPath, "utf8"));
const kb = (value) => (value == null ? "—" : `${Math.round(value / 1024).toLocaleString("en-US")}`);
const ms = (value) => (value == null ? "—" : `${Math.round(value).toLocaleString("en-US")}`);
const cls = (value) => (value == null ? "—" : value.toFixed(3));
const range = (stat, format) => `${format(stat.median)} (${format(stat.min)}–${format(stat.max)})`;

const metrics = [
  ["Transfer KB", "transferBytes", kb],
  ["Requests", "requests", (value) => (value == null ? "—" : String(Math.round(value)))],
  ["FCP ms", "fcp", ms],
  ["LCP ms", "lcp", ms],
  ["Load event ms", "loadEvent", ms],
  ["CLS", "cls", cls],
  ["TBT ms", "totalBlockingTime", ms],
  ["Script ms", "scriptDurationMs", ms],
];

console.log(`Profile: ${after.profile} · runs: ${before.runs} before / ${after.runs} after · Chrome ${after.chrome}`);
for (const [kind] of [["cold"], ["warm"]]) {
  console.log(`\n#### ${kind === "cold" ? "Cold (empty cache)" : "Warm (second visit, same profile)"}\n`);
  console.log(`| Page | Metric | Before median (min–max) | After median (min–max) |`);
  console.log(`| --- | --- | --- | --- |`);
  for (const page of Object.keys(after.pages)) {
    const a = before.pages[page]?.[kind];
    const b = after.pages[page]?.[kind];
    if (!a || !b) continue;
    for (const [label, key, format] of metrics) {
      console.log(`| ${page} | ${label} | ${range(a[key], format)} | ${range(b[key], format)} |`);
    }
  }
}
