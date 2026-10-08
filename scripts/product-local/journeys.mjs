#!/usr/bin/env node
// End-to-end journeys against the disposable local product environment.
//
//   scripts/product-local/start.sh
//   (cd research-portal && npx vite --mode productlocal --host 127.0.0.1 --port 4740 --strictPort) &
//   PLAYWRIGHT_CORE=/path/to/playwright-core node scripts/product-local/journeys.mjs [--only name,name] [--out dir]
//
// Uses only the local test accounts created by start.sh. Scenarios are switched with the same
// SQL scripts start.sh uses. Every journey records pass/fail with a one-line reason; the run exits
// non-zero if any journey fails.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, localAccounts, signIn } from "./browse.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const base = opt("base", "http://127.0.0.1:4740/");
const out = opt("out", join(process.env.TMPDIR || "/tmp", "exacth2o-journeys"));
const only = opt("only", null)?.split(",") ?? null;
mkdirSync(out, { recursive: true });

const accounts = localAccounts();
const dbUrl = accounts.DB_URL;
export function scenario(name) {
  execFileSync("psql", [dbUrl, "-v", "ON_ERROR_STOP=1", "-q", "-f", join(here, `scenario-${name}.sql`)], { stdio: "ignore" });
}
export function sql(query) {
  return execFileSync("psql", [dbUrl, "-Atc", query], { encoding: "utf8" }).trim();
}

const results = [];
const journeys = [];
export function journey(name, fn) {
  journeys.push({ name, fn });
}

const browser = await launch();

async function session(role, options = {}) {
  const context = await browser.newContext({ viewport: options.viewport ?? { width: 1440, height: 900 }, reducedMotion: options.reducedMotion, ...options.context });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  if (role) await signIn(page, base, role);
  return { context, page, errors };
}

async function text(page, selector = "body") {
  return (await page.locator(selector).first().innerText()).replace(/\s+/g, " ");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function settle(page, ms = 900) {
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await page.waitForTimeout(ms);
}

// ---------------------------------------------------------------- slice 1: routes and home

journey("home is quiet when everything reports", async () => {
  scenario("normal");
  const { page, context } = await session("researcher");
  await settle(page, 1500);
  const body = await text(page);
  assert(/Matt Experiment 2/.test(body) && /24 pots/.test(body), "experiment card with configured count missing");
  assert(!/no readings since|Controller offline|Couldn.t check|plan says/i.test(body), `home not quiet: ${body.slice(0, 300)}`);
  assert(!(await page.$(".px-exp-exception")), "an exception line is shown while healthy");
  await page.screenshot({ path: join(out, "home-normal.png") });
  await context.close();
});

journey("home → experiment → pot, Back/Forward and reload keep the place", async () => {
  const { page, context } = await session("researcher");
  await page.click('.px-exp-open:has-text("Matt Experiment 2")');
  await page.waitForURL(/experiment=matt-experiment-2/);
  await page.waitForSelector(".px-wl-group");
  await page.click('.px-pot-chip:has-text("17")');
  await page.waitForURL(/pot=Zone3-Pot17/);
  await page.waitForSelector('h1:has-text("Pot 17")');
  await page.goBack();
  await page.waitForURL((url) => url.search.includes("experiment=matt-experiment-2") && !url.search.includes("pot="));
  await page.goBack();
  await page.waitForURL((url) => !url.search.includes("experiment="));
  await page.waitForSelector(".px-spine");
  await page.goForward();
  await page.waitForURL(/experiment=matt-experiment-2/);
  await page.reload();
  await page.waitForSelector(".px-wl-group", { timeout: 20000 });
  assert(/Matt Experiment 2/.test(await text(page, "h1")), "reload lost the experiment");
  await context.close();
});

journey("deep links resolve after sign-in, including tabs and pots", async () => {
  const { page, context } = await session(null);
  await page.goto(`${base}?experiment=matt-experiment-2&tab=pots&pot=Zone3-Pot17`);
  await page.waitForSelector('input[type="email"]');
  await page.fill('input[type="email"]', accounts.RESEARCHER_EMAIL);
  await page.fill('input[type="password"]', accounts.RESEARCHER_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForSelector('h1:has-text("Pot 17")', { timeout: 20000 });
  assert(page.url().includes("pot=Zone3-Pot17"), "sign-in dropped the route");
  await page.goto(`${base}?pot=Zone1-Pot2`);
  await page.waitForSelector('h1:has-text("Pot 2")');
  await page.goto(`${base}?experiment=does-not-exist`);
  await page.waitForSelector("text=No experiment “does-not-exist” is visible");
  await context.close();
});

journey("board outage, failed refresh and controller outage are distinct", async () => {
  scenario("board-outage");
  let { page, context } = await session("researcher");
  await settle(page, 1500);
  let body = await text(page);
  assert(/Pots 17–24 \(sensor board B3\) have no readings since/.test(body), `board outage line missing: ${body.slice(0, 400)}`);
  assert(!/Controller offline|Couldn.t check/.test(body), "board outage misreported as controller or portal problem");
  await page.screenshot({ path: join(out, "home-board-outage.png") });
  // The portal's own check fails: the last good data stays and the failure is stated.
  await page.route("**/rest/v1/sensor_readings**", (route) => route.abort());
  await page.route("**/rest/v1/device_config_state**", (route) => route.abort());
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await page.waitForSelector("text=Couldn't check for new readings", { timeout: 20000 });
  body = await text(page);
  assert(/Matt Experiment 2/.test(body), "last good data disappeared after a failed check");
  await page.screenshot({ path: join(out, "home-refresh-failed.png") });
  await context.close();
  scenario("controller-offline");
  ({ page, context } = await session("researcher"));
  await settle(page, 1500);
  body = await text(page);
  assert(/Controller offline since/.test(body), "controller outage not stated");
  assert(!(await page.$(".px-exp-exception")), "controller outage repeated on every experiment card");
  await page.screenshot({ path: join(out, "home-controller-offline.png") });
  await context.close();
  scenario("discrepancy");
  ({ page, context } = await session("researcher"));
  await settle(page, 1500);
  body = await text(page);
  assert(/Pots 2, 10 and 18: the experiment plan says 22% VWC, but the controller is applying 25%/.test(body), "discrepancy line missing");
  await context.close();
  scenario("normal");
});

journey("account isolation: another project's account sees none of this project", async () => {
  const { page, context } = await session("other");
  await settle(page, 1500);
  let body = await text(page);
  assert(/Other project trial/.test(body), "other account does not see its own experiment");
  assert(!/Matt Experiment 2|SWC Saturation/.test(body), "other account sees the greenhouse project");
  await page.goto(`${base}?experiment=matt-experiment-2`);
  await page.waitForSelector("text=is visible to this account", { timeout: 20000 });
  await page.goto(`${base}?pot=Zone3-Pot17`);
  await settle(page);
  body = await text(page);
  assert(!/Pot 17/.test(await text(page, "h1").catch(() => "")) || /No pot/.test(body), "other account can open a greenhouse pot");
  await context.close();
  const viewer = await session("viewer");
  await settle(viewer.page, 1500);
  body = await text(viewer.page);
  assert(!/Matt Experiment 2/.test(body), "viewer sees experiments that are limited to admins and researchers");
  await viewer.context.close();
});

journey("phone, tablet, keyboard and reduced motion", async () => {
  for (const [name, viewport] of [["phone", { width: 390, height: 844 }], ["tablet", { width: 834, height: 1112 }]]) {
    const { page, context } = await session("researcher", { viewport });
    await settle(page);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert(overflow <= 1, `${name} home overflows by ${overflow}px`);
    await page.screenshot({ path: join(out, `home-${name}.png`) });
    await page.goto(`${base}?experiment=matt-experiment-2`);
    await page.waitForSelector(".px-wl-group");
    const overflow2 = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert(overflow2 <= 1, `${name} overview overflows by ${overflow2}px`);
    await page.screenshot({ path: join(out, `overview-${name}.png`), fullPage: false });
    await context.close();
  }
  const { page, context } = await session("researcher", { reducedMotion: "reduce" });
  await page.waitForSelector(".px-spine .px-exp-card");
  const animation = await page.$eval(".px-dash-v", (el) => getComputedStyle(el).animationName);
  assert(animation === "none", `spine animates under reduced motion (${animation})`);
  // Keyboard: Find pot opens with "/", Enter on "17" opens the pot.
  await page.keyboard.press("/");
  await page.waitForSelector('[role="dialog"] input');
  await page.keyboard.type("17");
  await page.keyboard.press("Enter");
  await page.waitForSelector('h1:has-text("Pot 17")');
  await context.close();
  const moving = await session("researcher");
  await moving.page.waitForSelector(".px-spine .px-exp-card");
  const name = await moving.page.$eval(".px-dash-v", (el) => getComputedStyle(el).animationName);
  assert(name !== "none", "spine does not animate by default");
  await moving.context.close();
});

// Later slices register more journeys from their own modules.
for (const module of ["journeys-bench.mjs", "journeys-workbench.mjs"]) {
  try {
    await import(join(here, module));
  } catch (error) {
    if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
  }
}

for (const { name, fn } of journeys) {
  if (only && !only.some((item) => name.includes(item))) continue;
  const started = Date.now();
  try {
    await fn({ session, text, assert, settle, base, out, accounts });
    results.push({ name, ok: true, ms: Date.now() - started });
    console.log(`  ok   ${name}`);
  } catch (error) {
    results.push({ name, ok: false, ms: Date.now() - started, error: error.message.split("\n")[0] });
    console.log(`  FAIL ${name} — ${error.message.split("\n")[0]}`);
  }
}
await browser.close();
const failed = results.filter((result) => !result.ok).length;
writeFileSync(join(out, "journeys.json"), JSON.stringify({ base, ranAt: new Date().toISOString(), results }, null, 2));
console.log(`\n${results.length - failed} passed · ${failed} failed → ${out}`);
process.exit(failed ? 1 : 0);
