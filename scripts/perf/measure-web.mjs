#!/usr/bin/env node
// Repeatable lab measurements for the public website and portal shells.
//
// Usage (from the repository root):
//   PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core \
//   node scripts/perf/measure-web.mjs --label baseline --profile mobile --runs 5 --out /tmp/baseline-mobile.json
//
// The site is served from this checkout by scripts/perf/static-server.mjs (gzip, clean URLs,
// max-age=600 like GitHub Pages). Chrome resolves exacth2o.com to that local server so the
// public metrics script initialises exactly as in production, while every request to the
// analytics proxy is intercepted and answered locally: nothing is sent to PostHog or Supabase.
// These are laboratory numbers for before/after comparison, not real-user observations.
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { startStaticServer } from "./static-server.mjs";

const require = createRequire(import.meta.url);
const playwrightPath = process.env.PLAYWRIGHT_CORE || "playwright-core";
const { chromium } = require(playwrightPath);

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => {
  if (value.startsWith("--")) pairs.push([value.slice(2), all[index + 1]?.startsWith("--") ? "true" : all[index + 1] ?? "true"]);
  return pairs;
}, []));
const runs = Number(args.runs ?? 5);
const profileName = args.profile ?? "desktop";
const label = args.label ?? "run";
const pages = (args.pages ?? "/,/applications,/about,/support,/quote,/portal,/demo").split(",");
const blockMetrics = args["block-metrics"] === "true";
const chromePath = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const profiles = {
  // Desktop: unthrottled CPU, cable-like network.
  desktop: {
    viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, isMobile: false, hasTouch: false,
    network: { latency: 40, downloadThroughput: (10 * 1024 * 1024) / 8, uploadThroughput: (5 * 1024 * 1024) / 8 },
    cpu: 1,
  },
  // Mobile: the Lighthouse "slow 4G" network and 4x CPU slowdown.
  mobile: {
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
    userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Mobile Safari/537.36",
    network: { latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 },
    cpu: 4,
  },
};
const profile = profiles[profileName];
if (!profile) throw new Error(`Unknown profile ${profileName}`);

const observerScript = () => {
  const perf = { lcp: null, lcpElement: null, cls: 0, shifts: [], fcp: null, longTasks: [], firstAnalyticsAt: null };
  window.__perf = perf;
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        perf.lcp = entry.startTime;
        const element = entry.element;
        perf.lcpElement = element ? `${element.tagName.toLowerCase()}${element.currentSrc ? ` ${element.currentSrc.split("/").pop()}` : ""}` : entry.url || null;
      }
    }).observe({ type: "largest-contentful-paint", buffered: true });
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.hadRecentInput) continue;
        perf.cls += entry.value;
        perf.shifts.push({ at: Math.round(entry.startTime), value: Number(entry.value.toFixed(4)) });
      }
    }).observe({ type: "layout-shift", buffered: true });
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) if (entry.name === "first-contentful-paint") perf.fcp = entry.startTime;
    }).observe({ type: "paint", buffered: true });
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) perf.longTasks.push({ start: entry.startTime, duration: entry.duration });
    }).observe({ type: "longtask", buffered: true });
  } catch { /* Observers unsupported */ }
};

function resourceBucket(type, url) {
  if (url.includes("e.exacth2o.com")) return "analytics";
  if (/fonts\.(googleapis|gstatic)\.com/.test(url)) return "font";
  if (type === "Image") return "image";
  if (type === "Script") return "script";
  if (type === "Stylesheet") return "css";
  if (type === "Document") return "document";
  if (type === "Media") return "media";
  if (type === "Font") return "font";
  return "other";
}

async function measure(context, url, origin) {
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Performance.enable");
  await cdp.send("Network.emulateNetworkConditions", { offline: false, ...profile.network });
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: profile.cpu });
  const requests = new Map();
  let lastActivity = Date.now();
  cdp.on("Network.requestWillBeSent", (event) => {
    requests.set(event.requestId, { url: event.request.url, type: event.type ?? "Other", bytes: 0, start: event.timestamp, cached: false });
    lastActivity = Date.now();
  });
  cdp.on("Network.responseReceived", (event) => {
    const item = requests.get(event.requestId);
    if (item) {
      item.type = event.type ?? item.type;
      item.cached = Boolean(event.response.fromDiskCache || event.response.fromMemoryCache || event.response.status === 304);
      item.status = event.response.status;
    }
  });
  cdp.on("Network.loadingFinished", (event) => {
    const item = requests.get(event.requestId);
    if (item) item.bytes = event.encodedDataLength;
    lastActivity = Date.now();
  });
  cdp.on("Network.loadingFailed", (event) => {
    const item = requests.get(event.requestId);
    if (item) item.failed = event.errorText;
    lastActivity = Date.now();
  });
  await page.addInitScript(observerScript);
  const started = Date.now();
  let loadTimedOut = false;
  try {
    await page.goto(`${origin}${url}`, { waitUntil: "load", timeout: 90_000 });
  } catch (error) {
    // A stalled third-party request (e.g. a font) can hold the load event. Record it and keep
    // measuring what did load instead of abandoning the whole run.
    if (!String(error).includes("Timeout")) throw error;
    loadTimedOut = true;
  }
  const loadMs = Date.now() - started;
  // Network quiet: three seconds without activity, capped at 60 seconds.
  while (Date.now() - lastActivity < 3000 && Date.now() - started < 60_000) await page.waitForTimeout(250);
  const timing = await page.evaluate(() => {
    const navigation = performance.getEntriesByType("navigation")[0];
    return {
      domContentLoaded: navigation?.domContentLoadedEventEnd ?? null,
      load: navigation?.loadEventEnd ?? null,
      perf: window.__perf,
    };
  });
  const metrics = Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((item) => [item.name, item.value]));
  const all = Array.from(requests.values());
  const byType = {};
  for (const item of all) {
    const bucket = resourceBucket(item.type, item.url);
    byType[bucket] ??= { count: 0, bytes: 0 };
    byType[bucket].count += 1;
    byType[bucket].bytes += item.bytes;
  }
  const fcp = timing.perf?.fcp ?? 0;
  const blocking = (timing.perf?.longTasks ?? [])
    .filter((task) => task.start >= fcp)
    .reduce((sum, task) => sum + Math.max(0, task.duration - 50), 0);
  await page.close();
  return {
    url,
    requests: all.length,
    transferBytes: all.reduce((sum, item) => sum + item.bytes, 0),
    byType,
    fcp: timing.perf?.fcp ?? null,
    lcp: timing.perf?.lcp ?? null,
    lcpElement: timing.perf?.lcpElement ?? null,
    cls: Number((timing.perf?.cls ?? 0).toFixed(4)),
    shifts: timing.perf?.shifts ?? [],
    domContentLoaded: timing.domContentLoaded,
    loadEvent: timing.load,
    totalBlockingTime: Math.round(blocking),
    scriptDurationMs: Math.round((metrics.ScriptDuration ?? 0) * 1000),
    taskDurationMs: Math.round((metrics.TaskDuration ?? 0) * 1000),
    jsHeapUsedBytes: metrics.JSHeapUsedSize ?? null,
    wallLoadMs: loadMs,
    loadTimedOut,
    pendingRequests: all.filter((item) => !item.bytes && !item.failed && !item.cached).map((item) => item.url).slice(0, 10),
    images: all.filter((item) => resourceBucket(item.type, item.url) === "image").map((item) => ({ file: item.url.split("/").pop(), bytes: item.bytes, cached: item.cached })),
    failed: all.filter((item) => item.failed && !item.url.includes("supabase")).map((item) => ({ url: item.url, error: item.failed })),
  };
}

function median(values) {
  const sorted = values.filter((value) => typeof value === "number" && Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function summarize(samples) {
  const keys = ["requests", "transferBytes", "fcp", "lcp", "cls", "domContentLoaded", "loadEvent", "totalBlockingTime", "scriptDurationMs", "taskDurationMs"];
  return Object.fromEntries(keys.map((key) => {
    const values = samples.map((sample) => sample[key]).filter((value) => typeof value === "number");
    return [key, { median: median(values), min: values.length ? Math.min(...values) : null, max: values.length ? Math.max(...values) : null }];
  }));
}

const server = await startStaticServer({ root: resolve(args.root ?? process.cwd()) });
const origin = `http://exacth2o.com:${server.port}`;
const browser = await chromium.launch({
  executablePath: chromePath,
  headless: true,
  args: [
    "--host-resolver-rules=MAP exacth2o.com 127.0.0.1, MAP www.exacth2o.com 127.0.0.1",
    "--disable-features=HttpsUpgrades,HttpsFirstBalancedModeAutoEnable",
  ],
});

const analyticsBodies = [];
const results = { label, profile: profileName, runs, blockMetrics, chrome: browser.version(), measuredAt: new Date().toISOString(), pages: {} };
try {
  for (const url of pages) {
    const cold = [];
    const warm = [];
    for (let run = 0; run < runs; run += 1) {
      const context = await browser.newContext({
        viewport: profile.viewport,
        deviceScaleFactor: profile.deviceScaleFactor,
        isMobile: profile.isMobile,
        hasTouch: profile.hasTouch,
        userAgent: profile.userAgent,
      });
      await context.route("https://e.exacth2o.com/**", async (route) => {
        analyticsBodies.push({ url: route.request().url(), page: url, size: route.request().postDataBuffer()?.length ?? 0 });
        await route.fulfill({ status: 200, contentType: "application/json", body: "{\"status\":1}" });
      });
      await context.route(/supabase\.co/, (route) => route.abort());
      if (blockMetrics) await context.route(/\/site-metrics\.js/, (route) => route.abort());
      try {
        cold.push(await measure(context, url, origin));
        warm.push(await measure(context, url, origin));
      } catch (error) {
        console.error(`${label} ${profileName} ${url} run ${run + 1} failed: ${String(error).split("\n")[0]}`);
      }
      await context.close();
    }
    results.pages[url] = { cold: summarize(cold), warm: summarize(warm), coldSamples: cold, warmSamples: warm };
    const c = results.pages[url].cold;
    if (!cold.length) continue;
    console.log(`${label} ${profileName} ${url}: cold ${(c.transferBytes.median / 1024).toFixed(0)} KB, ${c.requests.median} req, LCP ${Math.round(c.lcp.median ?? 0)} ms, load ${Math.round(c.loadEvent.median ?? 0)} ms, CLS ${c.cls.median}, TBT ${c.totalBlockingTime.median} ms${cold.some((sample) => sample.loadTimedOut) ? ` (${cold.filter((sample) => sample.loadTimedOut).length} load timeouts)` : ""}`);
  }
} finally {
  await browser.close();
  await server.close();
}
results.analyticsRequests = analyticsBodies.length;
if (args.out) writeFileSync(args.out, JSON.stringify(results, null, 2));
