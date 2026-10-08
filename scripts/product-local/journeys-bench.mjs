// Slice 2 journeys: Bench and Pocket (registered by journeys.mjs).
//
// Notes are written through the real portal against the local database. Network trouble is
// produced in the browser (offline mode, dropped requests, a dropped response, an expired token,
// a refusal), never by changing what the server accepts.
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const projectId = "22222222-2222-4222-8222-222222222222";
const otherProjectId = "55555555-5555-4555-8555-555555555555";
const phone = { width: 390, height: 844 };
const notesUrl = "**/rest/v1/portal_pot_notes*";

export default function register({ journey, scenario, sql, session, text, assert, settle, base, out, accounts }) {
  const runTag = `J${Date.now().toString(36)}`;
  const noteBody = (label) => `${runTag} ${label}`;
  const countNotes = (body) => Number(sql(`select count(*) from portal_pot_notes where body = '${body}'`));
  const userId = (role) => sql(`select id from auth.users where email = '${role}@product.local'`);
  const deviceId = sql(`select device_id from hardware_bindings where project_id = '${projectId}' and pairing_name = 'Zone3-Pot17' and retired_at is null limit 1`);

  async function until(check, message, timeoutMs = 40_000, everyMs = 500) {
    const started = Date.now();
    for (;;) {
      const value = await check();
      if (value) return value;
      if (Date.now() - started > timeoutMs) throw new Error(message);
      await new Promise((resolve) => setTimeout(resolve, everyMs));
    }
  }

  /** Make the browser's note writes fail in a given way; `null` lets them through. */
  async function noteWrites(target, mode) {
    await target.unroute(notesUrl).catch(() => undefined);
    if (!mode) return;
    let dropped = false;
    await target.route(notesUrl, async (route) => {
      if (route.request().method() !== "POST" || (mode === "drop-response-once" && dropped)) return route.continue();
      if (mode === "network") return route.abort("internetdisconnected");
      if (mode === "expired") return route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ code: "PGRST301", message: "JWT expired", details: null, hint: null }) });
      if (mode === "refused") return route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ code: "23514", message: "The note time is outside the accepted window.", details: null, hint: null }) });
      if (mode === "drop-response-once") {
        // The server stores the note, then the response is lost: the phone must retry harmlessly.
        dropped = true;
        await route.fetch();
        return route.abort("connectionreset");
      }
      return route.continue();
    });
  }

  async function tokenFor(role) {
    const response = await fetch(`${accounts.API_URL}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: accounts.ANON_KEY, "content-type": "application/json" },
      body: JSON.stringify({ email: accounts[`${role.toUpperCase()}_EMAIL`], password: accounts[`${role.toUpperCase()}_PASSWORD`] }),
    });
    const body = await response.json();
    if (!body.access_token) throw new Error(`no token for ${role}`);
    return body.access_token;
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

  async function writeNote(page, pot, body, { navigate = true } = {}) {
    const zone = Math.min(5, Math.ceil(pot / 6));
    if (navigate) await page.goto(`${base}?view=pocket&pot=Zone${zone}-Pot${pot}`);
    await page.waitForSelector(`h1:has-text("Pot ${pot}")`, { timeout: 20_000 });
    await page.click('a.px-pocket-primary:has-text("Add note")');
    await page.waitForSelector("textarea");
    await page.fill("textarea", body);
    await page.click('button[aria-pressed]:has-text("sensor reseated")');
    await page.click('button[type="submit"]:has-text("Save note")');
    await page.waitForSelector(`h1:has-text("Pot ${pot}")`);
  }

  async function signOutFromPortal(page) {
    const dialogs = [];
    page.once("dialog", async (dialog) => {
      dialogs.push(dialog.message());
      await dialog.accept();
    });
    if (await page.$(".px-pocket-leave")) await page.click(".px-pocket-leave");
    await page.click('button:has-text("Sign out")');
    await page.waitForSelector('input[type="email"]', { timeout: 20_000 });
    return dialogs;
  }

  async function signInAgain(page, role) {
    await page.fill('input[type="email"]', accounts[`${role.toUpperCase()}_EMAIL`]);
    await page.fill('input[type="password"]', accounts[`${role.toUpperCase()}_PASSWORD`]);
    await page.click('button[type="submit"]');
    await page.waitForFunction(() => !document.querySelector('input[type="password"]'), null, { timeout: 20_000 });
  }

  // ------------------------------------------------------------------------------- Bench

  journey("bench: schematic layout, silent board, lookup and the same pot record", async () => {
    scenario("normal");
    sql(`delete from portal_bench_layout_versions where project_id = '${projectId}'`);
    scenario("board-outage");
    const { page, context } = await session("admin");
    await page.goto(`${base}?view=bench`);
    await page.waitForSelector('h1:has-text("Bench")');
    await settle(page);
    const body = await text(page);
    assert(/Schematic: pots numbered by zone/.test(body), "unrecorded layout is not marked schematic");
    assert(/B3/.test(await text(page, ".px-notice")), "silent board B3 is not named");
    const silent = await page.$$eval("a.px-bench-cell.is-silent", (cells) => cells.map((cell) => cell.getAttribute("aria-label")));
    assert(silent.length === 8 && silent.every((label) => /no current reading/.test(label)), `expected pots 17–24 marked silent, got ${silent.length}`);
    const shapes = await page.$$eval(".px-legend-item svg", (items) => items.length);
    assert(shapes >= 2, "legend does not draw shapes (treatment would be colour only)");
    await page.screenshot({ path: join(out, "bench-schematic-outage.png"), fullPage: true });
    await page.fill("#bench-lookup", "17");
    await page.click('form button:has-text("Open")');
    await page.waitForSelector('h1:has-text("Pot 17")');
    assert(new URL(page.url()).searchParams.get("view") === "bench", "lookup left the bench route");
    await page.goBack();
    await page.waitForSelector('h1:has-text("Bench")');
    await page.click('a.px-bench-cell[aria-label^="Pot 5,"]');
    await page.waitForSelector('h1:has-text("Pot 5")');
    await page.reload();
    await page.waitForSelector('h1:has-text("Pot 5")', { timeout: 20_000 });
    await context.close();
    const small = await session("researcher", { viewport: phone });
    await small.page.goto(`${base}?view=bench`);
    await small.page.waitForSelector(".px-bench-cell");
    const overflow = await small.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert(overflow <= 1, `bench overflows a phone by ${overflow}px`);
    await small.page.screenshot({ path: join(out, "bench-phone.png"), fullPage: true });
    await small.context.close();
    scenario("normal");
  });

  journey("bench: recording a layout adds a version; earlier versions stay; only admins record", async () => {
    sql(`delete from portal_bench_layout_versions where project_id = '${projectId}'`);
    const { page, context } = await session("admin");
    await page.goto(`${base}?view=bench`);
    await page.click('button:has-text("Record layout…")');
    await page.fill('input[placeholder^="e.g. Bench C"]', `${runTag} first layout`);
    await page.click('button:has-text("Record this layout")');
    await page.waitForSelector("text=Recorded layout, version 1", { timeout: 20_000 });
    const first = sql(`select md5(layout::text) || '|' || created_by from portal_bench_layout_versions where project_id = '${projectId}' and version = 1`);
    assert(first.endsWith(userId("admin")), "layout author is not the signed-in admin");
    await page.click('button:has-text("Record layout…")');
    await page.fill('input[aria-label="Bench 1 label"]', "Bench by the door");
    await page.fill('input[placeholder^="e.g. Bench C"]', `${runTag} renamed bench`);
    await page.click('button:has-text("Record this layout")');
    await page.waitForSelector("text=Recorded layout, version 2 of 2", { timeout: 20_000 });
    assert(/Bench by the door/i.test(await text(page, ".px-benches")), "new version is not drawn");
    const firstAgain = sql(`select md5(layout::text) || '|' || created_by from portal_bench_layout_versions where project_id = '${projectId}' and version = 1`);
    assert(firstAgain === first, "recording a new layout changed the earlier version");
    await page.screenshot({ path: join(out, "bench-recorded-v2.png"), fullPage: true });
    await context.close();

    const researcher = await session("researcher");
    await researcher.page.goto(`${base}?view=bench`);
    await researcher.page.waitForSelector("text=Recorded layout, version 2 of 2", { timeout: 20_000 });
    assert(!(await researcher.page.$('button:has-text("Record layout…")')), "a researcher is offered the layout recorder");
    await researcher.context.close();
    const attempt = await rest("researcher", "portal_bench_layout_versions", {
      method: "POST",
      body: JSON.stringify({ project_id: projectId, layout: { benches: [{ id: "A", label: "A", rows: 1, columns: 1 }], positions: [] }, basis: "recorded" }),
    });
    assert(attempt.status >= 400, `researcher could record a layout through the API (${attempt.status})`);
    const otherRead = await rest("other", `portal_bench_layout_versions?project_id=eq.${projectId}&select=id`);
    assert(Array.isArray(otherRead.body) && otherRead.body.length === 0, "another project's account can read this project's layouts");
    assert(Number(sql(`select count(*) from portal_bench_layout_versions where project_id = '${projectId}'`)) === 2, "unexpected number of layout versions");
    sql(`delete from portal_bench_layout_versions where project_id = '${projectId}'`);
  });

  // ------------------------------------------------------------------------------ Pocket

  journey("pocket: number pad, neighbours, recent pots, label links and unsafe links", async () => {
    scenario("normal");
    const { page, context } = await session("researcher", { viewport: phone });
    const dialogs = [];
    page.on("dialog", async (dialog) => {
      dialogs.push(dialog.message());
      await dialog.dismiss();
    });
    await page.goto(`${base}?view=pocket`);
    await page.waitForSelector('[aria-label="Number pad"]');
    await page.click('[aria-label="Number pad"] button:text-is("1")');
    await page.click('[aria-label="Number pad"] button:text-is("7")');
    await page.click('[aria-label="Number pad"] button:text-is("Go")');
    await page.waitForSelector('h1:has-text("Pot 17")');
    assert(new URL(page.url()).searchParams.get("pot") === "Zone3-Pot17", "number pad did not open Zone3-Pot17");
    const summary = await page.$eval('.px-sr-only[role="status"]', (el) => el.textContent).catch(() => "");
    assert(/Pot 17: .*% VWC measured at/.test(summary), `no accessible reading summary (${summary})`);
    await page.screenshot({ path: join(out, "pocket-sheet.png") });
    await page.click('a[aria-label="Next pot, 18"]');
    await page.waitForSelector('h1:has-text("Pot 18")');
    await page.goBack();
    await page.waitForSelector('h1:has-text("Pot 17")');
    await page.click(".px-crumb");
    await page.waitForSelector('[aria-label="Recent pots"]');
    const recent = await text(page, '[aria-label="Recent pots"]');
    assert(/Pot 18/.test(recent) && /Pot 17/.test(recent), `recent pots missing (${recent})`);
    await page.screenshot({ path: join(out, "pocket-finder.png") });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert(overflow <= 1, `pocket overflows by ${overflow}px`);

    const potUuid = sql(`select pot_id from hardware_bindings where project_id = '${projectId}' and pairing_name = 'Zone3-Pot17' and retired_at is null limit 1`);
    await page.goto(`${base}?view=pocket&pot=${potUuid}`);
    await page.waitForSelector('h1:has-text("Pot 17")', { timeout: 20_000 });
    const otherUuid = sql(`select id from research_pots where project_id = '${otherProjectId}' limit 1`);
    for (const key of [randomUUID(), otherUuid, "javascript:alert(1)", "<img src=x onerror=alert(1)>"].filter(Boolean)) {
      await page.goto(`${base}?view=pocket&pot=${encodeURIComponent(key)}`);
      await page.waitForSelector('[role="alert"]:has-text("No pot")', { timeout: 20_000 });
    }
    assert(!(await page.$("img[src='x']")), "a pot link injected markup");
    assert(!dialogs.length, `a pot link ran script (${dialogs.join(", ")})`);
    await context.close();
  });

  journey("pocket: a note written offline survives reload and a lost response, and is recorded once", async () => {
    const body = noteBody("offline note on pot 17");
    const { page, context } = await session("researcher", { viewport: phone });
    await page.goto(`${base}?view=pocket&pot=Zone3-Pot17`);
    await page.waitForSelector('h1:has-text("Pot 17")');
    await settle(page);
    await context.setOffline(true);
    await page.waitForSelector('.px-pocket-net:has-text("Offline")');
    const writtenAt = Date.now();
    // Already on the pot: opening the composer is client-side, so it works offline.
    await writeNote(page, 17, body, { navigate: false });
    await page.waitForSelector('.px-pocket-net:has-text("Offline · 1 waiting")');
    assert(/Saved on this device · waiting to send/.test(await text(page, ".px-pocket-notes")), "offline note is not shown as waiting");
    await page.screenshot({ path: join(out, "pocket-offline-waiting.png") });

    // Back online, but writes keep failing: the note must stay, through a reload.
    await noteWrites(page, "network");
    await context.setOffline(false);
    await page.waitForTimeout(1500);
    await page.reload();
    await page.waitForSelector('h1:has-text("Pot 17")', { timeout: 20_000 });
    await until(async () => /1 note waiting/.test(await text(page, ".px-pocket-top").catch(() => "")), "waiting note lost on reload", 15_000);
    assert(countNotes(body) === 0, "note reached the database while writes were failing");

    // The connection flaps: the server stores the note but the reply is lost; the retry is a no-op.
    await noteWrites(page, "drop-response-once");
    await until(() => countNotes(body) === 1, "note never reached the database", 90_000);
    await until(async () => !(await page.$(".px-pocket-net")), "phone still shows the note as waiting", 90_000);
    await page.waitForTimeout(2000);
    assert(countNotes(body) === 1, `note recorded ${countNotes(body)} times`);
    const row = sql(`select created_by || '|' || author_label || '|' || (client_context->>'written_offline') || '|' || extract(epoch from observed_at)::bigint || '|' || extract(epoch from recorded_at)::bigint || '|' || array_to_string(tags, ',') from portal_pot_notes where body = '${body}'`).split("|");
    assert(row[0] === userId("researcher") && row[1] === "researcher@product.local", "note author is not the signed-in researcher");
    assert(row[2] === "true", "note does not record that it was written offline");
    assert(Math.abs(Number(row[3]) * 1000 - writtenAt) < 10_000, "note lost the time it was written");
    assert(Number(row[4]) - Number(row[3]) >= 1, "received time is not later than written time");
    assert(row[5] === "sensor reseated", `tags not kept (${row[5]})`);
    await context.close();

    const desk = await session("admin");
    await desk.page.goto(`${base}?pot=Zone3-Pot17`);
    await desk.page.waitForSelector(`text=${body}`, { timeout: 20_000 });
    const meta = await desk.page.locator(".px-note", { hasText: body }).innerText();
    assert(/written .* without a connection · received/.test(meta.replace(/\s+/g, " ")), `pot page does not separate written and received times (${meta})`);
    await desk.page.screenshot({ path: join(out, "pot-page-notes.png"), fullPage: true });
    await desk.context.close();
  });

  journey("pocket: waiting notes stay with their account through sign-out and an account switch", async () => {
    const body = noteBody("researcher note on pot 18");
    const { page, context } = await session("researcher", { viewport: phone });
    await noteWrites(context, "network");
    await writeNote(page, 18, body);
    await page.waitForSelector('.px-pocket-net:has-text("1 note waiting")');
    const dialogs = await signOutFromPortal(page);
    assert(dialogs.length === 1 && /not reached the record/.test(dialogs[0]), `sign-out did not warn about the waiting note (${dialogs.join(" | ")})`);

    await signInAgain(page, "admin");
    await noteWrites(context, null);
    await page.goto(`${base}?view=pocket&screen=outbox`);
    await page.waitForSelector('h1:has-text("Notes on this device")');
    assert(!(await text(page)).includes(body), "the admin account sees the researcher's waiting note");
    await page.goto(`${base}?view=pocket&pot=Zone3-Pot18`);
    await page.waitForSelector('h1:has-text("Pot 18")');
    await page.waitForTimeout(17_000); // longer than one outbox poll
    assert(countNotes(body) === 0, "the admin session sent the researcher's note");
    const adminDialogs = await signOutFromPortal(page);
    assert(adminDialogs.length === 0, "admin was warned about notes that are not theirs");

    await signInAgain(page, "researcher");
    await until(() => countNotes(body) === 1, "researcher's note was not sent after signing back in", 90_000);
    assert(sql(`select created_by from portal_pot_notes where body = '${body}'`) === userId("researcher"), "note sent under the wrong account");
    await context.close();
  });

  journey("pocket: an expired session waits for sign-in; a refused note is kept, retried or discarded", async () => {
    const expiredBody = noteBody("note during an expired session");
    const { page, context } = await session("researcher", { viewport: phone });
    await noteWrites(page, "expired");
    await writeNote(page, 19, expiredBody);
    await page.waitForSelector('.px-pocket-net:has-text("Sign in to send notes")', { timeout: 20_000 });
    await page.click(".px-pocket-net");
    await page.waitForSelector("text=Your session ended");
    await page.screenshot({ path: join(out, "pocket-needs-sign-in.png") });
    assert(countNotes(expiredBody) === 0, "note recorded during an expired session");
    await noteWrites(page, null); // a fresh session is accepted again
    await until(() => countNotes(expiredBody) === 1, "note not sent once the session was valid again", 45_000);

    const refusedBody = noteBody("note the server refuses");
    await noteWrites(page, "refused");
    await writeNote(page, 20, refusedBody);
    await page.goto(`${base}?view=pocket&screen=outbox`);
    await page.waitForSelector("text=Not accepted", { timeout: 20_000 });
    assert(/outside the accepted window/.test(await text(page)), "refusal reason is not shown");
    await page.waitForTimeout(16_000);
    assert(countNotes(refusedBody) === 0, "a refused note was retried automatically");
    await page.screenshot({ path: join(out, "pocket-refused.png") });
    await noteWrites(page, null);
    await page.click('button:has-text("Try again")');
    await until(() => countNotes(refusedBody) === 1, "retried note was not recorded", 30_000);

    const discardBody = noteBody("note to discard");
    await noteWrites(page, "refused");
    await writeNote(page, 21, discardBody);
    await page.goto(`${base}?view=pocket&screen=outbox`);
    await page.waitForSelector(`text=${discardBody}`);
    await page.waitForSelector("text=Not accepted", { timeout: 20_000 });
    page.once("dialog", (dialog) => dialog.accept());
    await page.click('button:has-text("Discard")');
    await until(async () => !(await text(page)).includes(discardBody), "discarded note still listed", 10_000);
    assert(countNotes(discardBody) === 0, "discarded note reached the record");
    await context.close();
  });

  journey("pocket: two tabs on one phone send each note exactly once", async () => {
    const bodies = [noteBody("tab one, pot 22"), noteBody("tab two, pot 23")];
    const { page, context } = await session("researcher", { viewport: phone });
    const second = await context.newPage();
    const posts = [];
    context.on("request", (request) => {
      if (request.method() === "POST" && request.url().includes("/rest/v1/portal_pot_notes")) posts.push(request.postDataJSON()?.id);
    });
    await noteWrites(context, "network");
    await writeNote(page, 22, bodies[0]);
    await writeNote(second, 23, bodies[1]);
    await second.goto(`${base}?view=pocket&screen=outbox`);
    await until(async () => (await text(second)).includes(bodies[0]) && (await text(second)).includes(bodies[1]), "tabs do not share the waiting notes", 10_000);
    await noteWrites(context, null);
    await page.waitForTimeout(6_000); // past the first retry delay
    await Promise.all([page, second].map((tab) => tab.evaluate(() => window.dispatchEvent(new Event("online")))));
    await until(() => bodies.every((body) => countNotes(body) === 1), "notes from two tabs were not both recorded", 45_000);
    await page.waitForTimeout(3_000);
    for (const body of bodies) assert(countNotes(body) === 1, `"${body}" recorded ${countNotes(body)} times`);
    assert(posts.length >= 2, "expected at least one write per note");
    await context.close();
  });

  journey("notes: viewers read but cannot write; other projects cannot read; the record is append-only", async () => {
    const spoof = await rest("researcher", "portal_pot_notes", {
      method: "POST",
      body: JSON.stringify({ id: randomUUID(), project_id: projectId, device_id: deviceId, pairing_name: "Zone3-Pot17", body: noteBody("spoofed author"), observed_at: new Date().toISOString(), author_label: "someone-else@example.invalid", created_by: userId("admin") }),
    });
    assert(spoof.status < 300 && spoof.body?.[0]?.author_label === "researcher@product.local" && spoof.body?.[0]?.created_by === userId("researcher"), `the server accepted a spoofed author (${spoof.status} ${JSON.stringify(spoof.body).slice(0, 200)})`);
    const someId = spoof.body[0].id;
    const edit = await rest("researcher", `portal_pot_notes?id=eq.${someId}`, { method: "PATCH", body: JSON.stringify({ body: "edited" }) });
    const remove = await rest("researcher", `portal_pot_notes?id=eq.${someId}`, { method: "DELETE" });
    assert(sql(`select body from portal_pot_notes where id = '${someId}'`) === noteBody("spoofed author"), `a note was edited or deleted (${edit.status}/${remove.status})`);

    const viewer = await session("viewer", { viewport: phone });
    await viewer.page.goto(`${base}?view=pocket&pot=Zone3-Pot17`);
    await viewer.page.waitForLoadState("networkidle").catch(() => undefined);
    await viewer.page.waitForTimeout(1200);
    assert(!(await viewer.page.$('a.px-pocket-primary:has-text("Add note")')), "a viewer is offered Add note");
    await viewer.page.screenshot({ path: join(out, "pocket-viewer.png") });
    await viewer.context.close();
    const insert = (role) => rest(role, "portal_pot_notes", {
      method: "POST",
      body: JSON.stringify({ id: randomUUID(), project_id: projectId, device_id: deviceId, pairing_name: "Zone3-Pot17", body: noteBody(`${role} API write`), observed_at: new Date().toISOString(), author_label: "spoofed" }),
    });
    for (const role of ["viewer", "other"]) {
      const result = await insert(role);
      assert(result.status >= 400, `${role} could write a note through the API (${result.status})`);
    }
    const viewerRead = await rest("viewer", `portal_pot_notes?project_id=eq.${projectId}&select=id&limit=5`);
    assert(Array.isArray(viewerRead.body) && viewerRead.body.length > 0, "viewer cannot read the project's notes");
    const otherRead = await rest("other", `portal_pot_notes?project_id=eq.${projectId}&select=id`);
    assert(Array.isArray(otherRead.body) && otherRead.body.length === 0, "another project's account can read this project's notes");
  });
}
