import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { boardAddresses, holdExpiry, pairingPot, POT_COUNT, resolvePots, routeLabel } from "./hold-policy.mjs";

// Hold-to-water for physical pots 1-100. The server owns the destination controller and every
// valve route; the browser names only a pot number. Nothing here edits pairings or settings.
const origins = new Set(["https://exacth2o.com", "https://www.exacth2o.com", "http://127.0.0.1:4899"]);
const holdActions = ["start", "renew", "stop", "status"];
const routeActions = ["routes", "confirm_route", "remove_route"];
type ManualRoute = { pot_number: number; relay_address: number; channel: number; note: string; confirmed_at: string };
type PotRoute = { pot: number; status: "ready" | "unmapped" | "conflict"; kind?: "pairing" | "manual"; relayAddress?: number; channel?: number;
  pairingName?: string; sensorId?: number; valveId?: number; reason?: string };

async function loadRoutes(admin: SupabaseClient, projectId: string, deviceId: string) {
  const [config, manual] = await Promise.all([
    admin.from("device_config_state").select("pairings, board_config").eq("project_id", projectId).eq("device_id", deviceId).maybeSingle(),
    admin.from("manual_valve_routes").select("pot_number, relay_address, channel, note, confirmed_at").eq("project_id", projectId).eq("device_id", deviceId),
  ]);
  if (config.error || !config.data || manual.error) throw new Error("Pot routes are unavailable");
  const boards = boardAddresses(config.data.board_config);
  const pots = resolvePots(Array.isArray(config.data.pairings) ? config.data.pairings : [], (manual.data ?? []) as ManualRoute[], boards) as PotRoute[];
  return { boards, pots };
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
            route_relay_address: body.relayAddress, route_channel: body.channel, route_note: String(body.note ?? "").slice(0, 280) })
        : admin.rpc("remove_manual_valve_route", { route_project_id: projectId, route_device_id: deviceId, actor: user.id, route_pot_number: body.potNumber });
      const { error } = await rpc;
      if (error) return reply({ error: error.message }, 409);
      const { pots, boards } = await loadRoutes(admin, projectId, deviceId);
      return reply({ pots, boards, canConfirm: true });
    }

    // Portal builds published before pot numbers name the pot by its pairing.
    if (body.potNumber == null && typeof body.pairingName === "string") body.potNumber = pairingPot(body.pairingName);
    if (!Number.isInteger(body.sequence) || body.sequence < 0 || !/^[-a-f0-9]{36}$/i.test(body.sessionId || "") || !Number.isInteger(body.potNumber) || body.potNumber < 1 || body.potNumber > POT_COUNT) {
      return reply({ error: "Invalid hold request" }, 400);
    }
    const [{ pots }, gate] = await Promise.all([
      loadRoutes(admin, projectId, deviceId),
      action === "start" || action === "renew" ? controlGateClosed(admin, projectId, deviceId) : Promise.resolve(null),
    ]);
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
    const payload = { action, sessionId: body.sessionId, ownerId: user.id, sequence: body.sequence, expiresAt: expiresAt ?? 0,
      routeKind: pot.kind ?? "manual", relayAddress: pot.relayAddress ?? 0, address: pot.channel ?? 0, sensorId: pot.sensorId, valveId: pot.valveId };
    if (pot.status !== "ready") { payload.relayAddress = 32; payload.address = 1; payload.routeKind = "manual"; } // stop/status ignore the route
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
          route_kind: pot.kind ?? null, controller_ms: Date.now() - started, error: result.ok ? null : data.error ?? null } });
      // Auditing never delays or blocks the hold itself.
      const runtime = (globalThis as { EdgeRuntime?: { waitUntil(promise: Promise<unknown>): void } }).EdgeRuntime;
      if (runtime) runtime.waitUntil(Promise.resolve(audit)); else await audit;
    }
    // The controller also refuses a signal whose lease expired in transit; that is lateness, not a refusal.
    const code = result.status === 409 && /expired/i.test(String(data.error ?? "")) ? "late" : undefined;
    return reply({ ...data, code, controllerMs: Date.now() - started, pot: { pot: pot.pot, status: pot.status, kind: pot.kind } }, result.status);
  } catch {
    return reply({ error: "Controller response unavailable. Release the button; the controller ends the hold on its own." }, 503);
  }
});
