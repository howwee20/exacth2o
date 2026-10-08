// Slice 3 journeys: Workbench and Record (registered by journeys.mjs).
//
// Comparisons and exclusions are created through the real portal against the local database;
// exported files are downloaded and checked against the statistics on screen and the database.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const projectId = "22222222-2222-4222-8222-222222222222";
const phone = { width: 390, height: 844 };

export default function register({ journey, scenario, sql, session, text, assert, settle, base, out, accounts }) {
  const runTag = `W${Date.now().toString(36)}`;
  const userId = (role) => sql(`select id from auth.users where email = '${role}@product.local'`);
  const perf = {};

  async function tokenFor(role) {
    const response = await fetch(`${accounts.API_URL}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: accounts.ANON_KEY, "content-type": "application/json" },
      body: JSON.stringify({ email: accounts[`${role.toUpperCase()}_EMAIL`], password: accounts[`${role.toUpperCase()}_PASSWORD`] }),
    });
    return (await response.json()).access_token;
  }

  async function rest(role, path, init = {}) {
    const token = await tokenFor(role);
    const response = await fetch(`${accounts.API_URL}/rest/v1/${path}`, {
      ...init,
      headers: { apikey: accounts.ANON_KEY, authorization: `Bearer ${token}`, "content-type": "application/json", prefer: "return=representation", ...(init.headers ?? {}) },
    });
    const body = await response.text();
    return { status: response.status, body: body ? JSON.parse(body) : null };
  }

  async function download(page, label) {
    const [file] = await Promise.all([page.waitForEvent("download"), page.click(`button:has-text("${label}")`)]);
    const path = join(out, `${runTag}-${file.suggestedFilename()}`);
    await file.saveAs(path);
    return readFileSync(path, "utf8");
  }

  function parseCsv(body) {
    const [header, ...lines] = body.trim().split("\n");
    const columns = header.split(",");
    return lines.map((line) => Object.fromEntries(line.split(",").map((cell, index) => [columns[index], cell])));
  }

  async function statsRow(page, label) {
    const row = page.locator(".px-wb-stats tbody tr", { hasText: label }).first();
    const cells = await row.locator("td").allInnerTexts();
    return { pots: cells[1], value: cells[2], coverage: cells[3], readings: Number(cells[4].replace(/,/g, "")), excluded: Number(cells[5].replace(/,/g, "")) };
  }

  async function waitForData(page) {
    await page.waitForFunction(() => {
      const status = document.querySelector(".px-wb-main [role='status']");
      return status && /requests?,/.test(status.textContent ?? "") && !/Loading/.test(status.textContent ?? "");
    }, null, { timeout: 30_000 });
  }

  // ---------------------------------------------------------------------------- Workbench

  journey("workbench: a question-titled comparison is saved, shared, and reopens from its link", async () => {
    scenario("normal");
    sql(`delete from portal_comparison_exclusions where project_id = '${projectId}'; delete from portal_comparisons where project_id = '${projectId}'`);
    const { page, context } = await session("researcher");
    await page.goto(`${base}?view=workbench`);
    await page.waitForSelector(".px-wb-stats");
    await waitForData(page);
    const question = `${runTag} Did the deficit pots dry faster after plan version 2?`;
    await page.fill(".px-wb-question input", question);
    await page.selectOption('label:has-text("Group by") select', "treatment");
    await page.click('button:has-text("Days since an event")');
    const eventSelect = page.locator('label:has-text("Event") select');
    const planOption = await eventSelect.locator("option", { hasText: "Plan version 2" }).getAttribute("value");
    await eventSelect.selectOption(planOption);
    await waitForData(page);
    const ticks = await page.$$eval(".px-chart text, svg text", (nodes) => nodes.map((node) => node.textContent));
    assert(ticks.some((tick) => tick === "day 0"), "aligned chart has no day 0 tick");
    await page.selectOption('label:has-text("Sharing") select', "project");
    await page.click('button:has-text("Save comparison")');
    await page.waitForURL(/comparison=/, { timeout: 20_000 });
    await page.waitForSelector('button:has-text("Saved")');
    const id = new URL(page.url()).searchParams.get("comparison");
    const row = sql(`select question || '|' || sharing || '|' || created_by || '|' || (definition->'alignment'->>'kind') from portal_comparisons where id = '${id}'`).split("|");
    assert(row[0] === question && row[1] === "project" && row[2] === userId("researcher") && row[3] === "event", `saved comparison does not match (${row.join(" / ")})`);
    await page.screenshot({ path: join(out, "workbench-aligned.png"), fullPage: true });
    await page.reload();
    await page.waitForFunction((value) => document.querySelector(".px-wb-question input")?.value === value, question, { timeout: 20_000 });
    await page.goBack();
    await page.waitForFunction(() => !new URL(location.href).searchParams.get("comparison"), null, { timeout: 10_000 });
    await page.goForward();
    await page.waitForFunction((value) => document.querySelector(".px-wb-question input")?.value === value, question, { timeout: 20_000 });
    await context.close();

    const admin = await session("admin");
    await admin.page.goto(`${base}?view=workbench&comparison=${id}`);
    await admin.page.waitForFunction((value) => document.querySelector(".px-wb-question input")?.value === value, question, { timeout: 20_000 });
    assert(/Saved by researcher@product.local/.test(await text(admin.page)), "shared comparison does not say who saved it");
    assert(!(await admin.page.$('button:has-text("Save changes")')) && await admin.page.$('button:has-text("Save a copy as mine")'), "another member can edit a shared comparison");
    await admin.context.close();

    const other = await session("other");
    await other.page.goto(`${base}?view=workbench&comparison=${id}`);
    await other.page.waitForSelector('[role="alert"]:has-text("not shared with this account")', { timeout: 20_000 });
    await other.context.close();
    const viewer = await session("viewer");
    await viewer.page.goto(`${base}?view=workbench&comparison=${id}`);
    await viewer.page.waitForSelector("text=No experiment is visible to this account", { timeout: 20_000 });
    await viewer.context.close();
    const viewerSave = await rest("viewer", "portal_comparisons", { method: "POST", body: JSON.stringify({ project_id: projectId, device_id: sql(`select device_id from portal_comparisons where id = '${id}'`), question: "Viewer?", definition: {}, author_label: "v" }) });
    assert(viewerSave.status >= 400, `a viewer could save a comparison (${viewerSave.status})`);
  });

  journey("workbench: an exclusion applies alike to statistics, figure, CSV and methods; revoking restores them", async () => {
    scenario("normal");
    const device = sql(`select device_id from hardware_bindings where project_id = '${projectId}' and pairing_name = 'Zone3-Pot17' and retired_at is null limit 1`);
    const definition = { version: 1, experimentId: "matt-experiment-2", measure: "vwc", grouping: "treatment", window: { kind: "last", days: 3 }, alignment: { kind: "calendar" }, bucketMinutes: 60, hiddenGroups: [], weighting: "pot-equal" };
    const created = await rest("researcher", "portal_comparisons", {
      method: "POST",
      body: JSON.stringify({ project_id: projectId, device_id: device, experiment_id: "e2222222-2222-4222-8222-222222222222", question: `${runTag} Is pot 17 pulling the control group?`, definition, sharing: "private", author_label: "x" }),
    });
    assert(created.status < 300, `could not create the comparison (${created.status})`);
    const id = created.body[0].id;
    const { page, context } = await session("researcher");
    await page.goto(`${base}?view=workbench&comparison=${id}`);
    await page.waitForSelector(".px-wb-stats");
    await waitForData(page);
    const groupLabel = (await page.locator(".px-wb-stats tbody tr").first().locator("th").innerText()).trim();
    const potGroup = sql(`select treatment from experiment_assignments a join experiments e on e.current_revision_id = a.revision_id where e.id = 'e2222222-2222-4222-8222-222222222222' and a.pairing_name = 'Zone3-Pot17'`);
    const label = potGroup.charAt(0).toUpperCase() + potGroup.slice(1);
    const before = await statsRow(page, label);
    const csvBefore = await download(page, "Data (CSV)");

    await page.click('button:has-text("Exclude readings…")');
    await page.selectOption('.px-wb-exclusion-form label:has-text("Pots") select', "Zone3-Pot17");
    await page.fill('.px-wb-exclusion-form label:has-text("Reason") input', `${runTag} sensor unseated when the pot was moved`);
    await page.click('button:has-text("Record exclusion")');
    await page.waitForSelector("text=1 applied to the statistics, figure and every export", { timeout: 20_000 });
    await waitForData(page);
    await page.waitForFunction((args) => {
      const row = Array.from(document.querySelectorAll(".px-wb-stats tbody tr")).find((tr) => tr.textContent?.includes(args.label));
      return row && Number(row.querySelectorAll("td")[5]?.textContent?.replace(/,/g, "")) > 0;
    }, { label }, { timeout: 20_000 });
    const after = await statsRow(page, label);
    const potReadings = Number(sql(`select count(*) from portal_comparison_exclusions x, sensor_readings r where x.comparison_id = '${id}' and r.project_id = '${projectId}' and r.pairing_name = 'Zone3-Pot17' and (x.starts_at is null or r.device_recorded_at >= x.starts_at) and (x.ends_at is null or r.device_recorded_at < x.ends_at) and r.device_recorded_at <= now()`));
    assert(after.excluded === potReadings, `statistics exclude ${after.excluded} readings; the database has ${potReadings} in the exclusion`);
    assert(after.readings === before.readings - potReadings, `readings used went from ${before.readings} to ${after.readings}, expected −${potReadings}`);
    assert(after.pots.replace(/\s+/g, " ").startsWith(`${Number(before.pots.split(" ")[0]) - 1} of`), `an open-ended exclusion left pot 17 contributing (${after.pots})`);

    const csvAfterText = await download(page, "Data (CSV)");
    const csv = parseCsv(csvAfterText);
    const pot17 = csv.filter((row) => row.row_type === "pot" && row.pairing_name === "Zone3-Pot17");
    assert(pot17.every((row) => row.value === "" || Number(row.readings) > 0), "CSV has a value for an excluded bucket");
    assert(pot17.reduce((sum, row) => sum + Number(row.excluded_readings), 0) === potReadings, "CSV excluded count differs from the database");
    const groupCsvReadings = csv.filter((row) => row.row_type === "pot" && row.group_label === label).reduce((sum, row) => sum + Number(row.readings), 0);
    assert(groupCsvReadings === after.readings, `CSV readings ${groupCsvReadings} differ from statistics ${after.readings}`);
    const sidecar = JSON.parse(await download(page, "Methods (JSON)"));
    assert(sidecar.exclusions.applied.length === 1 && /sensor unseated/.test(sidecar.exclusions.applied[0].reason), "methods file does not list the exclusion");
    assert(sidecar.completeness.readings_excluded === csv.filter((row) => row.row_type === "pot").reduce((sum, row) => sum + Number(row.excluded_readings), 0), "methods and CSV disagree on excluded readings");
    const svgWithExclusion = await download(page, "Figure (SVG)");
    assert(/excluded by 1 recorded exclusion/.test(svgWithExclusion), "figure does not state the exclusion");

    // Hiding a line is presentation only.
    await page.uncheck(`input[aria-label="Show ${groupLabel} in the figure"]`);
    const hiddenStats = await statsRow(page, label);
    assert(hiddenStats.readings === after.readings && hiddenStats.excluded === after.excluded, "hiding a line changed the statistics");
    const csvHidden = await download(page, "Data (CSV)");
    assert(csvHidden === csvAfterText, "hiding a line changed the CSV");
    const svgHidden = await download(page, "Figure (SVG)");
    assert(!svgHidden.includes(`>${groupLabel}<`) && /Hidden from this figure only/.test(svgHidden), "hidden group still drawn, or not declared hidden");
    await page.check(`input[aria-label="Show ${groupLabel} in the figure"]`);
    await page.screenshot({ path: join(out, "workbench-exclusion.png"), fullPage: true });

    // Revoking keeps the record and restores the numbers.
    page.once("dialog", (dialog) => dialog.accept(`${runTag} the reseat did not affect readings`));
    await page.click('button:has-text("Revoke…")');
    await page.waitForSelector("text=None applied", { timeout: 20_000 });
    await page.waitForFunction((args) => {
      const row = Array.from(document.querySelectorAll(".px-wb-stats tbody tr")).find((tr) => tr.textContent?.includes(args.label));
      return row && Number(row.querySelectorAll("td")[4]?.textContent?.replace(/,/g, "")) === args.readings;
    }, { label, readings: before.readings }, { timeout: 20_000 });
    assert(/revoked by researcher@product.local/.test(await text(page, ".px-wb-exclusions")), "revoked exclusion is not kept with who revoked it");
    const kept = sql(`select reason || '|' || (revoked_at is not null) || '|' || revoke_reason from portal_comparison_exclusions where comparison_id = '${id}'`);
    assert(/sensor unseated.*\|true\|.*did not affect/.test(kept), `exclusion record not preserved (${kept})`);
    const csvRestored = await download(page, "Data (CSV)");
    assert(csvRestored === csvBefore, "revoking the exclusion did not restore the CSV");
    await context.close();
  });

  journey("workbench: long history is paged within the API limit and bounded", async () => {
    const { page, context } = await session("researcher");
    const calls = [];
    page.on("response", async (response) => {
      if (!response.url().includes("/rpc/portal_reading_buckets")) return;
      const body = await response.body().catch(() => Buffer.from(""));
      calls.push({ status: response.status(), bytes: body.length, rows: (() => { try { return JSON.parse(body.toString()).length; } catch { return -1; } })(), encoding: response.headers()["content-encoding"] ?? null });
    });
    await page.goto(`${base}?view=workbench`);
    await page.waitForSelector(".px-wb-stats");
    await waitForData(page);
    calls.length = 0;
    const started = Date.now();
    await page.click('button:has-text("30 days")');
    await page.waitForFunction(() => /^Sep .*requests?,/.test(document.querySelector(".px-wb-main [role='status']")?.textContent ?? ""), null, { timeout: 30_000 });
    await page.waitForTimeout(500);
    const status = await text(page, ".px-wb-main [role='status']");
    assert(calls.length > 1 && calls.every((call) => call.status === 200 && call.rows <= 1000), `history not paged within the 1000-row limit (${JSON.stringify(calls.slice(0, 3))})`);
    perf.workbench30Days = { requests: calls.length, rows: calls.reduce((sum, call) => sum + call.rows, 0), bytes: calls.reduce((sum, call) => sum + call.bytes, 0), ms: Date.now() - started, status };
    const refused = await rest("researcher", "rpc/portal_reading_buckets", {
      method: "POST",
      body: JSON.stringify({ p_project_id: projectId, p_device_id: "x", p_pairing_names: ["Zone1-Pot1"], p_start: "2026-01-01T00:00:00Z", p_end: "2026-10-01T00:00:00Z", p_bucket_seconds: 3600, p_exclusions: [] }),
    });
    assert(refused.status >= 400, "an unbounded history request was accepted");
    await context.close();
    writeFileSync(join(out, "perf-workbench.json"), JSON.stringify(perf, null, 2));
  });

  // ------------------------------------------------------------------------------ Record

  journey("record: one lane for plan, calibration, settings, gaps, valve openings and notes", async () => {
    scenario("board-outage");
    const { page, context } = await session("researcher");
    const responses = [];
    page.on("response", (response) => {
      if (response.url().includes("/rest/v1/")) responses.push(response.url());
    });
    await page.goto(`${base}?experiment=matt-experiment-2&tab=record`);
    await page.waitForSelector(".px-record-item", { timeout: 30_000 });
    await settle(page, 1500);
    const body = await text(page, ".px-record");
    for (const expected of [
      /Plan version 2: Deficit pots: target 22% VWC/,
      /Planned target 34% → 22%/,
      /Calibration Substrate v2 applied to Pots 1–8/,
      /Update board config — did not complete/,
      /No readings from Pots 17–24 \(sensor board B3\) since then/,
      /valve openings across/,
      /controller events, not measured water/,
      /requested/,
    ]) assert(expected.test(body), `record is missing ${expected}`);
    await page.screenshot({ path: join(out, "record-lane.png") });

    await page.click('.px-record-kinds button:has-text("Valve openings")');
    await page.click('.px-record-kinds button:has-text("Notes")');
    const filtered = await text(page, ".px-record");
    assert(!/valve openings across/.test(filtered) && !/sensor reseated/.test(filtered), "filters did not hide valve openings and notes");
    await page.selectOption('.px-record label:has-text("Pot") select', "Zone1-Pot3");
    await page.click('button:has-text("Show raw output around this change")');
    await page.waitForSelector("text=the step is the calibration", { timeout: 20_000 });
    assert((await page.$$(".px-record-explain svg")).length >= 2, "calibration explanation does not draw raw and calibrated output");
    await page.screenshot({ path: join(out, "record-calibration.png"), fullPage: false });
    const requests = new Set(responses.map((url) => url.split("?")[0].replace(/.*\/rest\/v1\//, ""))).size;
    perf.recordFirstLoad = { distinctEndpoints: requests, responses: responses.length };
    await context.close();

    const small = await session("researcher", { viewport: phone });
    await small.page.goto(`${base}?experiment=matt-experiment-2&tab=record`);
    await small.page.waitForSelector(".px-record-item", { timeout: 30_000 });
    const overflow = await small.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert(overflow <= 1, `record overflows a phone by ${overflow}px`);
    await small.page.screenshot({ path: join(out, "record-phone.png") });
    await small.context.close();
    scenario("normal");
    writeFileSync(join(out, "perf-workbench.json"), JSON.stringify(perf, null, 2));
  });

  journey("record: 'since you last looked' is per person and counts only other people's recorded events", async () => {
    scenario("normal");
    sql(`delete from portal_experiment_views where experiment_id = 'e2222222-2222-4222-8222-222222222222'`);
    const visit = async (role) => {
      const { page, context } = await session(role);
      await page.goto(`${base}?experiment=matt-experiment-2&tab=record`);
      await page.waitForSelector(".px-record-item", { timeout: 30_000 });
      await settle(page, 1200);
      const banner = await page.$eval(".px-record > .px-notice.is-info", (el) => el.textContent).catch(() => null);
      const fresh = await page.$$eval(".px-record-item.is-new .px-record-title", (nodes) => nodes.map((node) => node.textContent));
      await context.close();
      return { banner, fresh };
    };
    const first = await visit("admin");
    assert(first.banner == null, "a first visit claims something is new");
    await visit("researcher");
    const device = sql(`select device_id from hardware_bindings where project_id = '${projectId}' and pairing_name = 'Zone1-Pot3' and retired_at is null limit 1`);
    const noteBody = `${runTag} leaf curl on pot 3`;
    const note = await rest("researcher", "portal_pot_notes", {
      method: "POST",
      body: JSON.stringify({ id: randomUUID(), project_id: projectId, device_id: device, pairing_name: "Zone1-Pot3", body: noteBody, observed_at: new Date().toISOString(), author_label: "x", tags: ["plant observation"] }),
    });
    assert(note.status < 300, `could not write the note (${note.status})`);
    const adminAgain = await visit("admin");
    assert(/1 new/.test(adminAgain.banner ?? "") && adminAgain.fresh.some((title) => title.includes(noteBody)), `admin is not told about the researcher's note (${adminAgain.banner})`);
    const researcherAgain = await visit("researcher");
    assert(researcherAgain.banner == null, `the researcher's own note is shown as new to them (${researcherAgain.banner})`);
    const adminThird = await visit("admin");
    assert(adminThird.banner == null, "the mark did not move after the admin looked");
    const marks = sql(`select count(distinct user_id) from portal_experiment_views where experiment_id = 'e2222222-2222-4222-8222-222222222222'`);
    assert(marks === "2", `expected one mark per person, found ${marks}`);
    const otherMarks = await rest("other", "portal_experiment_views?select=user_id");
    assert(Array.isArray(otherMarks.body) && otherMarks.body.length === 0, "another account can read view marks");
  });
}
