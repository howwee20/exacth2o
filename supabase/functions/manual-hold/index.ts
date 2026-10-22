import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import {
  boardAddresses,
  holdExpiry,
  LEASE_MS,
  potForPairing,
  resolveDestination,
  resolveOutputs,
  resolvePots,
  routeLabel,
  ttlCache,
  verifiedClaims,
  verifiedIdentityCache,
} from "./hold-policy.mjs";

// Hold-to-water troubleshooting for every configured valve output. The server owns the
// destination controller and resolves each request to one output itself: a physical
// pot through its recorded route, or a configured output chosen directly. The browser
// never supplies an address the server did not resolve, and nothing here edits
// pairings, targets, schedules, calibration or any saved setting.
//
// Paths, in priority order:
//   stop    - signed-in owner only; no Auth call, route, role or gate checks, so it always works
//   renew   - Auth-verified token (cached per isolate for up to a minute) + short-lived
//             cached role/gate checks
//   start   - full checks: Auth, role, intake gate, quarantine, fresh route resolution
//   takeover- start that first closes another operator's session (explicit, audited)
const origins = new Set(["https://exacth2o.com", "https://www.exacth2o.com", "http://127.0.0.1:4899", "http://127.0.0.1:4740", "http://127.0.0.1:4741"]);
const holdActions = ["start", "renew", "stop", "status", "takeover"];
const readActions = ["routes", "inventory"];
const adminActions = ["confirm_route", "remove_route", "label_output"];
const RENEW_MS = 500;

type Destination = { kind: "pot"; potNumber: number } | { kind: "solenoid"; relayAddress: number; channel: number };
type Resolved = { ok: true; kind: "pot" | "solenoid"; relayAddress: number; channel: number; potNumber: number | null; solenoidNumber: number | null; routeStatus: string; pairingName: string | null }
  | { ok: false; status: number; error: string };
type SessionRoute = { ownerId: string; resolved: Extract<Resolved, { ok: true }>; takeoverOf: string | null };

// Per-isolate caches: optimizations only. A miss always falls back to the database.
const roleCache = ttlCache(5_000);
const gateCache = ttlCache(5_000);
const sessionRoutes = ttlCache(15 * 60_000, 200);
const inventoryCache = ttlCache(5_000, 20);
// Tokens Supabase Auth accepted, remembered briefly so heartbeats rarely need a round trip.
const identities = verifiedIdentityCache({ maxAgeMs: 60_000 });

async function loadInventory(admin: SupabaseClient, projectId: string, deviceId: string, fresh = false) {
  const cacheKey = `${projectId}:${deviceId}`;
  if (!fresh) {
    const cached = inventoryCache.get(cacheKey);
    if (cached) return cached;
  }
  const [config, routes, labels] = await Promise.all([
    admin.from("device_config_state").select("pairings, board_config, valves").eq("project_id", projectId).eq("device_id", deviceId).maybeSingle(),
    admin.from("manual_valve_routes").select("pot_number, status, relay_address, channel, source, evidence, updated_at").eq("project_id", projectId).eq("device_id", deviceId),
    admin.from("valve_output_labels").select("solenoid_number, relay_address, channel, status, source, evidence").eq("project_id", projectId).eq("device_id", deviceId),
  ]);
  if (config.error || !config.data || routes.error) throw new Error("Valve routes are unavailable");
  const boards = boardAddresses(config.data.board_config);
  const pairings = Array.isArray(config.data.pairings) ? config.data.pairings : [];
  const pots = resolvePots(routes.data ?? [], boards, pairings);
  const outputs = resolveOutputs({ boards, valves: Array.isArray(config.data.valves) ? config.data.valves : [], labels: labels.error ? [] : labels.data ?? [], pots, pairings });
  const inventory = { boards, pots, pairings, outputs };
  inventoryCache.set(cacheKey, inventory);
  return inventory;
}

async function controlGateClosed(admin: SupabaseClient, projectId: string, deviceId: string, useCache: boolean) {
  const key = `${projectId}:${deviceId}`;
  if (useCache) {
    const cached = gateCache.get(key);
    if (cached !== undefined) return cached as string | null;
  }
  const [intake, quarantine] = await Promise.all([
    admin.from("control_command_intake_settings").select("enabled").eq("singleton", true).maybeSingle(),
    admin.from("device_control_quarantines").select("reason").eq("project_id", projectId).eq("device_id", deviceId).eq("active", true).limit(1),
  ]);
  let closed: string | null = null;
  if (intake.error || quarantine.error) closed = "Controller safety state is unavailable";
  else if (!intake.data?.enabled) closed = "Controller commands are paused";
  else if (quarantine.data?.length) closed = "This controller is quarantined until its last command outcome is reconciled";
  gateCache.set(key, closed);
  return closed;
}

async function projectRole(admin: SupabaseClient, projectId: string, userId: string, useCache: boolean) {
  const key = `${projectId}:${userId}`;
  if (useCache) {
    const cached = roleCache.get(key);
    if (cached !== undefined) return cached as string | null;
  }
  const { data, error } = await admin.from("portal_access").select("role").eq("access_scope", "project").eq("project_id", projectId).eq("user_id", userId).maybeSingle();
  if (error) throw new Error("Could not verify portal access");
  const role = (data?.role as string | undefined) ?? null;
  roleCache.set(key, role);
  return role;
}

async function ownerLabel(admin: SupabaseClient, projectId: string, userId: string | undefined) {
  if (!userId) return null;
  const { data } = await admin.from("portal_access").select("email").eq("project_id", projectId).eq("user_id", userId).maybeSingle();
  const email = typeof data?.email === "string" ? data.email : "";
  return email ? email.split("@")[0] : "another operator";
}

function destinationFrom(body: Record<string, unknown>): Destination | null {
  const raw = body.destination as Record<string, unknown> | undefined;
  if (raw?.kind === "solenoid") return { kind: "solenoid", relayAddress: Number(raw.relayAddress), channel: Number(raw.channel) };
  if (raw?.kind === "pot") return { kind: "pot", potNumber: Number(raw.potNumber) };
  // Portal builds published before direct outputs name a pot number, or a pairing.
  if (Number.isInteger(body.potNumber)) return { kind: "pot", potNumber: Number(body.potNumber) };
  if (typeof body.pairingName === "string") return { kind: "pot", potNumber: NaN };
  return null;
}

serve(async (request) => {
  const origin = request.headers.get("origin") || "";
  const headers = { "Access-Control-Allow-Origin": origins.has(origin) ? origin : "https://exacth2o.com", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS", "Vary": "Origin", "Content-Type": "application/json", "Cache-Control": "no-store" };
  const reply = (body: Record<string, unknown>, status = 200) => new Response(JSON.stringify({ ...body, serverTime: Date.now() }), { status, headers });
  if (request.method === "OPTIONS") return new Response("ok", { headers });
  if (request.method !== "POST" || (origin && !origins.has(origin))) return reply({ error: "Request not allowed" }, 403);
  const runtime = (globalThis as { EdgeRuntime?: { waitUntil(promise: Promise<unknown>): void } }).EdgeRuntime;
  const later = (work: PromiseLike<unknown>) => {
    const promise = Promise.resolve(work).catch((error) => console.error("manual_hold_record_failed", String(error)));
    if (runtime) runtime.waitUntil(promise);
    return promise;
  };

  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
    const jwt = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const action = String(body.action ?? "");
    const projectId = String(body.projectId ?? "");
    const deviceId = String(body.deviceId ?? "");
    if (![...holdActions, ...readActions, ...adminActions].includes(action)) return reply({ error: "Invalid request" }, 400);
    if (projectId !== Deno.env.get("HEALTH_SYNC_PROJECT_ID") || deviceId !== Deno.env.get("HEALTH_SYNC_DEVICE_ID")) {
      return reply({ error: "Hold-to-water is unavailable on this controller" }, 409);
    }

    const isHold = holdActions.includes(action);
    const sessionId = String(body.sessionId ?? "");
    if (isHold && (!Number.isInteger(body.sequence) || Number(body.sequence) < 0 || !/^[-a-f0-9]{36}$/i.test(sessionId))) {
      return reply({ error: "Invalid hold request" }, 400);
    }

    // Identity. stop reads the claims of the token the gateway verified, so nothing, not
    // even an Auth outage, can delay closing a valve; a stop can only end a hold. Every
    // other action, including the renew heartbeat that keeps a valve open, is verified by
    // Supabase Auth here whatever the gateway's verify_jwt setting: renew and status reuse
    // a token Auth accepted within the last minute (per isolate), the rest ask afresh.
    let userId: string;
    if (action === "stop") {
      const claims = verifiedClaims(jwt);
      if (!claims) return reply({ error: "Sign in to use manual watering" }, 401);
      userId = claims.sub;
    } else {
      const heartbeat = action === "renew" || action === "status";
      const verifiedUserId = await identities.identify(jwt, async (token) => {
        const { data: { user }, error } = await admin.auth.getUser(token);
        return error || !user ? null : user.id;
      }, { fresh: !heartbeat });
      if (!verifiedUserId) return reply({ error: "Sign in to use manual watering" }, 401);
      userId = verifiedUserId;
    }

    // Stop first: no role, route or gate checks can block closing a valve.
    let role = "";
    if (action !== "stop") {
      role = (await projectRole(admin, projectId, userId, action === "renew" || action === "status")) ?? "";
      if (!["admin", "researcher"].includes(role)) return reply({ error: "Controller operator access required" }, 403);
    }

    if (action === "routes" || action === "inventory") {
      const { pots, boards, outputs } = await loadInventory(admin, projectId, deviceId);
      return reply({ pots, boards, outputs, canConfirm: role === "admin", canTakeover: true, leaseMs: LEASE_MS, renewMs: RENEW_MS });
    }
    if (adminActions.includes(action)) {
      if (role !== "admin") return reply({ error: "Project admin access is required" }, 403);
      const rpc = action === "confirm_route"
        ? admin.rpc("confirm_manual_valve_route", { route_project_id: projectId, route_device_id: deviceId, actor: userId, route_pot_number: body.potNumber,
            route_relay_address: body.relayAddress, route_channel: body.channel, route_note: String(body.note ?? "").slice(0, 600) })
        : action === "remove_route"
          ? admin.rpc("remove_manual_valve_route", { route_project_id: projectId, route_device_id: deviceId, actor: userId, route_pot_number: body.potNumber })
          : admin.rpc("record_valve_output_label", { label_project_id: projectId, label_device_id: deviceId, actor: userId, label_solenoid_number: body.solenoidNumber,
              label_relay_address: body.relayAddress, label_channel: body.channel, label_note: String(body.note ?? "").slice(0, 600) });
      const { error } = await rpc;
      if (error) return reply({ error: error.message }, 409);
      const { pots, boards, outputs } = await loadInventory(admin, projectId, deviceId, true);
      return reply({ pots, boards, outputs, canConfirm: true, canTakeover: true, leaseMs: LEASE_MS, renewMs: RENEW_MS });
    }

    // ---------------------------------------------------------------- hold actions
    const secret = Deno.env.get("EXACTH2O_MANUAL_HOLD_SECRET");
    if (!secret) return reply({ error: "Hold-to-water is awaiting controller commissioning" }, 503);
    const starting = action === "start" || action === "takeover";
    let session = sessionRoutes.get(sessionId) as SessionRoute | undefined;

    if (starting) {
      const gate = await controlGateClosed(admin, projectId, deviceId, false);
      if (gate) return reply({ error: gate }, 409);
      const destination = destinationFrom(body);
      if (!destination) return reply({ error: "Choose a pot or a solenoid" }, 400);
      const inventory = await loadInventory(admin, projectId, deviceId, true);
      if (destination.kind === "pot" && !Number.isInteger(destination.potNumber) && typeof body.pairingName === "string") {
        destination.potNumber = potForPairing(inventory.pots, inventory.pairings, body.pairingName) ?? NaN;
      }
      const resolved = resolveDestination(destination, { ...inventory, role, testCandidate: body.testCandidate === true }) as Resolved;
      if (!resolved.ok) return reply({ error: resolved.error }, resolved.status);
      session = { ownerId: userId, resolved, takeoverOf: null };
      sessionRoutes.set(sessionId, session);
    } else if (action === "renew") {
      const gate = await controlGateClosed(admin, projectId, deviceId, true);
      if (gate) {
        // A pause or quarantine refuses further water; the controller lease then ends the hold.
        return reply({ error: gate }, 409);
      }
      if (!session) {
        // Another isolate served the start. Resolve again; the controller still refuses any
        // renewal whose output differs from the one the session opened.
        const destination = destinationFrom(body);
        if (!destination) return reply({ error: "Invalid hold request" }, 400);
        const inventory = await loadInventory(admin, projectId, deviceId);
        const resolved = resolveDestination(destination, { ...inventory, role, testCandidate: body.testCandidate === true }) as Resolved;
        if (!resolved.ok) return reply({ error: resolved.error }, resolved.status);
        session = { ownerId: userId, resolved, takeoverOf: null };
        sessionRoutes.set(sessionId, session);
      }
    }
    if (session && session.ownerId !== userId) return reply({ error: "This hold belongs to another operator" }, 403);

    // Bind each start/renew to its press time (browser clock corrected to server time),
    // so a delayed request cannot start or extend water after release.
    const expiresAt = holdExpiry(Number(body.sentAt), Date.now());
    if ((starting || action === "renew") && expiresAt == null) return reply({ error: "Hold signal arrived too late", code: "late" }, 409);

    const route = session?.resolved;
    const payload = {
      action: action === "takeover" ? "start" : action,
      takeover: action === "takeover",
      sessionId,
      ownerId: userId,
      sequence: body.sequence,
      expiresAt: expiresAt ?? 0,
      destinationKind: route?.kind,
      relayAddress: route?.relayAddress,
      address: route?.channel,
      label: route ? (route.solenoidNumber != null ? `Solenoid ${route.solenoidNumber}` : routeLabel(route.relayAddress, route.channel)) : undefined,
    };

    const base = Deno.env.get("OWNER_HEALTH_BASE_URL") || `https://${deviceId}.balena-devices.com/owner-health`;
    const started = Date.now();
    if (starting && route) {
      // Recorded while the controller acts, never before it: autocalibration reads these
      // rows to detect manual watering, and a slow write must not delay the valve.
      later(admin.from("manual_hold_sessions").upsert({
        id: sessionId, project_id: projectId, device_id: deviceId, owner_id: userId, destination_kind: route.kind,
        pot_number: route.potNumber, solenoid_number: route.solenoidNumber, relay_address: route.relayAddress, channel: route.channel,
        route_status: route.routeStatus, pairing_name: route.pairingName, status: "opening", started_at: new Date().toISOString(),
      }, { onConflict: "id", ignoreDuplicates: true }));
    }

    let result: Response | undefined;
    let data: Record<string, unknown> = { error: "Controller response unavailable; outcome unknown" };
    try {
      result = await fetch(`${base.replace(/\/$/, "")}/api/manual-hold`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-ExactH2O-Hold-Secret": secret },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(action === "status" ? 7000 : action === "stop" ? 5000 : 3500),
      });
      data = await result.json().catch(() => ({ error: "Controller response unreadable" }));
    } catch {
      result = undefined;
    }
    const controllerMs = Date.now() - started;

    const status = result?.ok ? String(data.status ?? "") : "";
    if (starting || action === "stop" || (result?.ok && status === "closed" && data.endReason)) {
      const ended = status === "closed" || status === "fault";
      later(admin.from("manual_hold_sessions").update({
        status: !result ? (action === "stop" ? "unconfirmed" : "opening") : !result.ok ? (starting ? "refused" : "unconfirmed") : status === "acquiring" || status === "opening" ? "opening" : status,
        end_reason: (data.endReason as string | undefined) ?? (action === "stop" && result?.ok ? "released" : null),
        ...(ended ? { ended_at: new Date().toISOString() } : {}),
        updated_at: new Date().toISOString(),
      }).eq("id", sessionId).eq("owner_id", userId).neq("status", "closed"));
    }

    if (!result) {
      return reply({ error: action === "stop" ? "Stop not confirmed: the controller did not answer. Its lease ends the hold on its own." : "Controller response unavailable. Release the button; the controller ends the hold on its own.", controllerMs }, 503);
    }
    let activeOwnerLabel: string | null = null;
    if ((action === "status" || starting) && data.activeOwnerId) {
      activeOwnerLabel = data.activeOwnerId === userId ? "you (another tab or device)" : await ownerLabel(admin, projectId, String(data.activeOwnerId));
    }
    // The controller also refuses a signal whose lease expired in transit; that is lateness, not a refusal.
    const code = (data.code as string | undefined) ?? (result.status === 409 && /expired/i.test(String(data.error ?? "")) ? "late" : undefined);
    const { activeOwnerId: _hidden, ...visible } = data;
    return reply({
      ...visible,
      code,
      controllerMs,
      activeOwnerLabel,
      destination: route ? { kind: route.kind, relayAddress: route.relayAddress, channel: route.channel, potNumber: route.potNumber, solenoidNumber: route.solenoidNumber, routeStatus: route.routeStatus } : undefined,
      renewMs: RENEW_MS,
    }, result.status);
  } catch (error) {
    console.error("manual_hold_failed", String(error));
    return reply({ error: "Controller response unavailable. Release the button; the controller ends the hold on its own." }, 503);
  }
});
