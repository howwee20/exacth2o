#!/usr/bin/env node
// Sign in to the local product environment as a test role and screenshot portal routes.
//
//   PLAYWRIGHT_CORE=/path/to/playwright-core node scripts/product-local/browse.mjs \
//     --role admin --out /tmp/shots --width 1440 --height 900 home= 'overview=?experiment=matt-experiment-2'
//
// Local test accounts only (created by start.sh); the portal must be running against the local
// environment (vite --mode productlocal on port 4740).
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE || "playwright-core");
const chromePath = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export function localAccounts() {
  const dir = process.env.EXACTH2O_PRODUCT_LOCAL_DIR || join(process.env.TMPDIR || "/tmp", "exacth2o-product-local");
  const file = join(dir, "accounts.env");
  if (!existsSync(file)) throw new Error(`No local accounts at ${file}; run scripts/product-local/start.sh first.`);
  return Object.fromEntries(readFileSync(file, "utf8").trim().split("\n").map((line) => line.split(/=(.*)/s).slice(0, 2)));
}

export async function launch(options = {}) {
  return chromium.launch({ executablePath: chromePath, headless: true, ...options });
}

export async function signIn(page, base, role) {
  const accounts = localAccounts();
  const key = role.toUpperCase();
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('input[type="email"]', { timeout: 20000 });
  await page.fill('input[type="email"]', accounts[`${key}_EMAIL`]);
  await page.fill('input[type="password"]', accounts[`${key}_PASSWORD`]);
  await page.click('button[type="submit"]');
  await page.waitForFunction(() => !document.querySelector('input[type="password"]'), null, { timeout: 20000 });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const opt = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args.splice(i, 2)[1] : fallback;
  };
  const role = opt("role", "admin");
  const out = opt("out", "/tmp/exacth2o-shots");
  const width = Number(opt("width", "1440"));
  const height = Number(opt("height", "900"));
  const base = opt("base", "http://127.0.0.1:4740/");
  const full = opt("full", "1") === "1";
  mkdirSync(out, { recursive: true });
  const browser = await launch();
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  const errors = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text().slice(0, 240)); });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message.slice(0, 240)}`));
  page.on("response", (response) => { if (response.status() >= 400) errors.push(`${response.status()} ${response.request().method()} ${response.url().slice(0, 200)}`); });
  await signIn(page, base, role);
  for (const pair of args) {
    const index = pair.indexOf("=");
    const name = pair.slice(0, index);
    const path = pair.slice(index + 1);
    await page.goto(`${base}${path}`, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle").catch(() => undefined);
    await page.waitForTimeout(1200);
    await page.screenshot({ path: join(out, `${name}.png`), fullPage: full });
    console.log(name, page.url());
  }
  console.log("console errors:", errors.length ? `\n${errors.join("\n")}` : "none");
  await browser.close();
}
