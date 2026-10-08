#!/usr/bin/env node
// Per-route request counts, payload and time to a usable view, against the local product
// environment (or any portal base URL you can sign in to with the local test accounts).
//
//   PLAYWRIGHT_CORE=/path/to/playwright-core node scripts/product-local/perf.mjs [--base URL] [--out file.json]
//     [--only home,overview] [--baseline]   (--baseline: the pre-product portal, home only, ready on its cards)
//
// Each route is opened in a fresh signed-in page. "Requests" counts Supabase REST and RPC calls
// made after navigation (sign-in and the shell's own refresh loop included); "bytes" is the
// decoded JSON size. Production responses are additionally compressed in transit.
import { writeFileSync } from "node:fs";
import { launch, signIn } from "./browse.mjs";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};
const base = opt("base", "http://127.0.0.1:4740/");
const out = opt("out", null);
const only = opt("only", null)?.split(",") ?? null;
const baseline = args.includes("--baseline");
const allRoutes = [
  { name: "home", path: "", ready: ".px-spine .px-exp-card" },
  { name: "overview", path: "?experiment=matt-experiment-2", ready: ".px-wl-group" },
  { name: "pot", path: "?pot=Zone3-Pot17", ready: "h1:has-text('Pot 17')" },
  { name: "bench", path: "?view=bench", ready: ".px-bench-cell" },
  { name: "pocket", path: "?view=pocket&pot=Zone3-Pot17", ready: "h1:has-text('Pot 17')" },
  { name: "workbench-7d", path: "?view=workbench", ready: ".px-wb-stats tbody tr" },
  { name: "record-14d", path: "?experiment=matt-experiment-2&tab=record", ready: ".px-record-item" },
];
const routes = baseline
  ? [{ name: "home", path: "", ready: "text=Matt Experiment 2" }]
  : allRoutes.filter((route) => !only || only.includes(route.name));

const browser = await launch();
const results = [];
for (const route of routes) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await signIn(page, base, "researcher");
  await page.waitForLoadState("networkidle").catch(() => undefined);
  const calls = [];
  page.on("response", async (response) => {
    const url = response.url();
    if (!/\/rest\/v1\//.test(url)) return;
    const body = await response.body().catch(() => Buffer.alloc(0));
    calls.push({ endpoint: url.replace(/^.*\/rest\/v1\//, "").split("?")[0], bytes: body.length, status: response.status() });
  });
  const started = Date.now();
  await page.goto(`${base}${route.path}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(route.ready, { timeout: 30_000 });
  const readyMs = Date.now() - started;
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await page.waitForTimeout(800);
  const byEndpoint = {};
  for (const call of calls) byEndpoint[call.endpoint] = (byEndpoint[call.endpoint] ?? 0) + 1;
  results.push({
    route: route.name,
    readyMs,
    requests: calls.length,
    bytes: calls.reduce((sum, call) => sum + call.bytes, 0),
    errors: calls.filter((call) => call.status >= 400).length,
    endpoints: byEndpoint,
  });
  console.log(`${route.name.padEnd(13)} ready ${String(readyMs).padStart(5)} ms · ${String(calls.length).padStart(3)} requests · ${Math.round(calls.reduce((sum, call) => sum + call.bytes, 0) / 1024)} kB`);
  await context.close();
}
await browser.close();
if (out) writeFileSync(out, JSON.stringify({ base, baseline, measuredAt: new Date().toISOString(), results }, null, 2));
