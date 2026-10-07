#!/usr/bin/env node
// Portal lab measurements: requests while active, idle, hidden and on return; memory over
// repeated navigation; chart hover cost. Runs the production App against a counting mock
// (mockSupabase.ts), so it needs no credentials and touches no service.
//
//   PORTAL_SRC=/path/to/research-portal/src LAB_OUT=/tmp/lab-a node .../vite/bin/vite.js build --config scripts/perf/portal-lab/vite.config.mjs
//   PLAYWRIGHT_CORE=... node scripts/perf/portal-lab/measure-portal.mjs /tmp/lab-a --label after --out after.json
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { startStaticServer } from "../static-server.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE || "playwright-core");
const [dist, ...rest] = process.argv.slice(2);
const args = Object.fromEntries(rest.reduce((pairs, value, index, all) => (value.startsWith("--") ? [...pairs, [value.slice(2), all[index + 1]]] : pairs), []));
const chromePath = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const minute = 60_000;

const server = await startStaticServer({ root: resolve(dist) });
const browser = await chromium.launch({ executablePath: chromePath, headless: true });
const url = `http://127.0.0.1:${server.port}/index.html`;

async function setVisibility(page, state) {
  await page.evaluate((next) => {
    window.__labVisibility = next;
    document.dispatchEvent(new Event("visibilitychange"));
    if (next === "visible") {
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: false }));
    }
  }, state);
}

async function calls(page) {
  return page.evaluate(() => window.__labCalls.length);
}

async function breakdown(page, since) {
  return page.evaluate((from) => {
    const counts = {};
    for (const call of window.__labCalls.slice(from)) counts[`${call.kind}:${call.name}`] = (counts[`${call.kind}:${call.name}`] ?? 0) + 1;
    return counts;
  }, since);
}

const results = { label: args.label ?? "run", measuredAt: new Date().toISOString(), phases: {} };
try {
  // 1. Request counts with a controllable clock.
  {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await page.addInitScript(() => {
      window.__labVisibility = "visible";
      Object.defineProperty(Document.prototype, "visibilityState", { configurable: true, get: () => window.__labVisibility });
      Object.defineProperty(Document.prototype, "hidden", { configurable: true, get: () => window.__labVisibility !== "visible" });
    });
    await page.clock.install();
    await page.goto(url);
    await page.clock.runFor(10_000);
    let mark = 0;
    const phase = async (name, action) => {
      const before = await calls(page);
      await action();
      const after = await calls(page);
      results.phases[name] = { requests: after - before, breakdown: await breakdown(page, before) };
      mark = after;
    };
    results.phases.initialLoad = { requests: await calls(page), breakdown: await breakdown(page, 0) };
    await phase("homeVisible30min", () => page.clock.runFor(30 * minute));
    await phase("hidden30min", async () => {
      await setVisibility(page, "hidden");
      await page.clock.runFor(30 * minute);
    });
    await phase("returnToTab", async () => {
      await setVisibility(page, "visible");
      await page.clock.runFor(10_000);
    });
    await phase("focusBurstWithin30s", async () => {
      for (let index = 0; index < 3; index += 1) {
        await page.evaluate(() => window.dispatchEvent(new Event("focus")));
        await page.clock.runFor(2_000);
      }
    });
    await page.getByText("Lab experiment", { exact: true }).first().click();
    await page.clock.runFor(5_000);
    await phase("experimentVisible30min", () => page.clock.runFor(30 * minute));
    void mark;
    await context.close();
  }

  // 2. Memory across repeated navigation, and chart hover cost (real clock).
  {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send("Performance.enable");
    await page.goto(url);
    await page.getByText("Lab experiment", { exact: true }).first().waitFor();
    const heap = async () => {
      await cdp.send("HeapProfiler.collectGarbage");
      const metrics = Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((item) => [item.name, item.value]));
      return { heapMB: Number((metrics.JSHeapUsedSize / 1048576).toFixed(1)), nodes: metrics.Nodes, listeners: metrics.JSEventListeners };
    };
    const start = await heap();
    for (let index = 0; index < 20; index += 1) {
      await page.getByText("Lab experiment", { exact: true }).first().click();
      await page.locator(".chart-panel-main canvas, .experiment-graph-chart canvas").first().waitFor();
      await page.waitForTimeout(150);
      await page.getByRole("button", { name: /Home/ }).first().click();
      await page.getByText("Lab experiment", { exact: true }).first().waitFor();
    }
    const end = await heap();
    results.phases.navigation20x = { start, end };

    await page.getByText("Lab experiment", { exact: true }).first().click();
    await page.waitForTimeout(1500);
    // Use the single chart view (expand the first graph group when an overview grid is shown).
    const card = page.locator(".experiment-graph-card").first();
    if (await card.count()) {
      await card.click();
      await page.waitForTimeout(800);
    }
    const hover = await page.evaluate(async () => {
      const canvas = document.querySelector(".chart-panel-main canvas");
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      const samples = [];
      for (let round = 0; round < 3; round += 1) {
        const started = performance.now();
        for (let index = 0; index < 200; index += 1) {
          const x = rect.left + 80 + ((rect.width - 120) * index) / 200;
          canvas.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: x, clientY: rect.top + rect.height * (0.3 + 0.4 * ((index * 7) % 10) / 10) }));
        }
        samples.push((performance.now() - started) / 200);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return { msPerMoveSamples: samples.map((value) => Number(value.toFixed(3))), readingsLoaded: 50_000 };
    });
    results.phases.chartHover = hover;
    await context.close();
  }
} finally {
  await browser.close();
  await server.close();
}
const summary = Object.fromEntries(Object.entries(results.phases).map(([name, value]) => [name, value.requests ?? value]));
console.log(JSON.stringify({ label: results.label, summary }, null, 1));
if (args.out) writeFileSync(args.out, JSON.stringify(results, null, 2));
