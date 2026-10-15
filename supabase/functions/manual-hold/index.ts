import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { boardAddresses, holdExpiry, POT_COUNT, potForPairing, resolvePots, routeLabel } from "./hold-policy.mjs";

// Hold-to-water for physical pots 1-100. The server owns the destination controller and each
// pot's recorded valve route; the browser names only a pot number. Sensor pairings never
// decide which valve opens. Nothing here edits pairings, targets, schedules or settings.
const origins = new Set(["https://exacth2o.com", "https://www.exacth2o.com", "http://127.0.0.1:4899"]);
const holdActions = ["start", "renew", "stop", "status"];
const routeActions = ["routes", "confirm_route", "remove_route"];
type PotRoute = { pot: number; status: "ready" | "needs_confirmation" | "no_water_line" | "unmapped" | "conflict"; relayAddress?: number; channel?: number;
  pairing?: { name: string; sensorKey: string | null; namedPot: number | null; sensorId?: number; valveId?: number } | null; reason?: string };
type PairingRecord = { name?: string; Valve?: { relayAddress?: string | number; address?: string | number } };

async function loadRoutes(admin: SupabaseClient, projectId: string, deviceId: string) {
  const [config, routes] = await Promise.all([
    admin.from("device_config_state").select("pairings, board_config").eq("project_id", projectId).eq("device_id", deviceId).maybeSingle(),
    admin.from("manual_valve_routes").select("pot_number, status, relay_address, channel, source, evidence, updated_at").eq("project_id", projectId).eq("device_id", deviceId),
  ]);
  if (config.error || !config.data || routes.error) throw new Error("Pot routes are unavailable");
  const boards = boardAddresses(config.data.board_config);
  const pairings = (Array.isArray(config.data.pairings) ? config.data.pairings : []) as PairingRecord[];
  const pots = resolvePots(routes.data ?? [], boards, pairings) as PotRoute[];
  return { boards, pots, pairings };
}

async function controlGateClosed(admin: SupabaseClient, projectId: string, deviceId: string) {
  const [intake, quarantine] = await Promise.all([
    admin.from("control_command_intake_settings").select("enabled").eq("singleton", true).maybeSingle(),
    admin.from("device_control_quarantines").select("reason").eq("project_id", projectId).eq("device_id", deviceId).eq("active", true).limit(1),
  ]);
  if (intake.error || quarantine.error) return "Controller safety state is unavailable";
  if (!intake.data?.enabled) return "Controller commands are paused";
  if (quarantine.data?.length) return "This controller is quarantined until its last command is reconciled";
  return null;
}

serve(async (request) => {
  const origin = request.headers.get("origin") || "";
  const headers = { "Access-Control-Allow-Origin": origins.has(origin) ? origin : "https://exacth2o.com", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS", "Vary": "Origin", "Content-Type": "application/json", "Cache-Control": "no-store" };
  const reply = (body: Record<string, unknown>, status = 200) => new Response(JSON.stringify({ ...body, serverTime: Date.now() }), { status, headers });
  if (request.method === "OPTIONS") return new Response("ok", { headers });
  if (request.method !== "POST" || (origin && !origins.has(origin))) return reply({ error: "Request not allowed" }, 403);
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
    const jwt = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    const body = await request.json().catch(() => ({}));
    const { action, projectId, deviceId } = body;
    if (![...holdActions, ...routeActions].includes(action)) return reply({ error: "Invalid request" }, 400);
    const [{ data: { user }, error: authError }, access] = await Promise.all([
      admin.auth.getUser(jwt),
      admin.from("portal_access").select("role, user_id").eq("access_scope", "project").eq("project_id", projectId),
    ]);
    if (authError || !user) return reply({ error: "Sign in to use manual watering" }, 401);
    const role = access.data?.find((row) => row.user_id === user.id)?.role;
    if (access.error || !role || !["admin", "researcher"].includes(role)) return reply({ error: "Controller operator access required" }, 403);
    if (projectId !== Deno.env.get("HEALTH_SYNC_PROJECT_ID") || deviceId !== Deno.env.get("HEALTH_SYNC_DEVICE_ID")) return reply({ error: "Hold-to-water is unavailable on this controller" }, 409);

    if (action === "routes") {
      const { pots, boards } = await loadRoutes(admin, projectId, deviceId);
      return reply({ pots, boards, canConfirm: role === "admin" });
    }
    if (action === "confirm_route" || action === "remove_route") {
      if (role !== "admin") return reply({ error: "Project admin access is required" }, 403);
      const rpc = action === "confirm_route"
        ? admin.rpc("confirm_manual_valve_route", { route_project_id: projectId, route_device_id: deviceId, actor: user.id, route_pot_number: body.potNumber,
            route_relay_address: body.relayAddress, route_channel: body.channel, route_note: String(body.note ?? "").slice(0, 600) })
        : admin.rpc("remove_manual_valve_route", { route_project_id: projectId, route_device_id: deviceId, actor: user.id, route_pot_number: body.potNumber });
      const { error } = await rpc;
      if (error) return reply({ error: error.message }, 409);
      const { pots, boards } = await loadRoutes(admin, projectId, deviceId);
      return reply({ pots, boards, canConfirm: true });
    }

    if (!Number.isInteger(body.sequence) || body.sequence < 0 || !/^[-a-f0-9]{36}$/i.test(body.sessionId || "")) return reply({ error: "Invalid hold request" }, 400);
    const [{ pots, pairings }, gate] = await Promise.all([
      loadRoutes(admin, projectId, deviceId),
      action === "start" || action === "renew" ? controlGateClosed(admin, projectId, deviceId) : Promise.resolve(null),
    ]);
    // Portal builds published before pot numbers name a pairing; use the pot its valve waters.
    if (body.potNumber == null && typeof body.pairingName === "string") body.potNumber = potForPairing(pots, pairings, body.pairingName);
    if (!Number.isInteger(body.potNumber) || body.potNumber < 1 || body.potNumber > POT_COUNT) return reply({ error: "Pot route unavailable; refresh Find pot" }, 409);
    const pot = pots.find((entry) => entry.pot === body.potNumber)!;
    // Stop and status always reach the controller; only new water is refused here.
    if (gate) return reply({ error: gate }, 409);
    if (pot.status !== "ready" && action !== "stop" && action !== "status") return reply({ error: pot.reason ?? "Pot route unavailable", pot }, 409);
    const secret = Deno.env.get("EXACTH2O_MANUAL_HOLD_SECRET");
    if (!secret) return reply({ error: "Hold-to-water is awaiting controller commissioning" }, 503);
    // Bind to the press time (browser clock corrected to server time), so a delayed request
    // cannot start or extend water after release.
    const expiresAt = holdExpiry(Number(body.sentAt), Date.now());
    if ((action === "start" || action === "renew") && expiresAt == null) {
      return reply({ error: "Hold signal arrived too late", code: "late" }, 409);
    }
    // With a single pairing on this valve the controller re-checks that pairing's live route;
    // otherwise it checks the board. Stop and status act on the session, not the route.
    const ready = pot.status === "ready";
    const payload = { action, sessionId: body.sessionId, ownerId: user.id, sequence: body.sequence, expiresAt: expiresAt ?? 0,
      routeKind: ready && pot.pairing ? "pairing" : "manual", relayAddress: ready ? pot.relayAddress : 32, address: ready ? pot.channel : 1,
      sensorId: ready ? pot.pairing?.sensorId : undefined, valveId: ready ? pot.pairing?.valveId : undefined };
    const base = Deno.env.get("OWNER_HEALTH_BASE_URL") || `https://${deviceId}.balena-devices.com/owner-health`;
    const started = Date.now();
    const result = await fetch(`${base.replace(/\/$/, "")}/api/manual-hold`, { method: "POST",
      headers: { "Content-Type": "application/json", "X-ExactH2O-Hold-Secret": secret }, body: JSON.stringify(payload), signal: AbortSignal.timeout(3500) });
    const data = await result.json().catch(() => ({ error: "Controller response unreadable" }));
    if (action === "start" || action === "stop") {
      const audit = admin.from("project_control_audit").insert({ project_id: projectId, device_id: deviceId, actor_id: user.id,
        action: action === "start" ? "manual_hold_start" : "manual_hold_stop",
        status: result.ok ? String(data.status ?? "unknown") : "rejected",
        details: { session_id: body.sessionId, pot_number: body.potNumber, route: pot.relayAddress ? routeLabel(pot.relayAddress, pot.channel!) : null,
          route_kind: payload.routeKind, controller_ms: Date.now() - started, error: result.ok ? null : data.error ?? null } });
      // Auditing never delays or blocks the hold itself.
      const runtime = (globalThis as { EdgeRuntime?: { waitUntil(promise: Promise<unknown>): void } }).EdgeRuntime;
      if (runtime) runtime.waitUntil(Promise.resolve(audit)); else await audit;
    }
    // The controller also refuses a signal whose lease expired in transit; that is lateness, not a refusal.
    const code = result.status === 409 && /expired/i.test(String(data.error ?? "")) ? "late" : undefined;
    return reply({ ...data, code, controllerMs: Date.now() - started, pot: { pot: pot.pot, status: pot.status } }, result.status);
  } catch {
    return reply({ error: "Controller response unavailable. Release the button; the controller ends the hold on its own." }, 503);
  }
});
