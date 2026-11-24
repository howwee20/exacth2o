import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";
import { constantTimeSecretMatch } from "../_shared/secret-compare.mjs";

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers":
    "authorization,apikey,content-type,x-client-info",
  "access-control-allow-methods": "POST,OPTIONS",
};
const reply = (value: unknown, status = 200) =>
  Response.json(value, {
    status,
    headers: { ...cors, "cache-control": "no-store" },
  });
const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);
const pub = Deno.env.get("MOISTURE_VAPID_PUBLIC") || "";
const priv = Deno.env.get("MOISTURE_VAPID_PRIVATE") || "";

function validEndpoint(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2500) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.port && !url.username &&
      !url.password && !url.hash && url.pathname.length > 1 &&
      ([
        "fcm.googleapis.com",
        "updates.push.services.mozilla.com",
        "web.push.apple.com",
      ].includes(url.hostname) ||
        url.hostname.endsWith(".push.apple.com") ||
        url.hostname.endsWith(".notify.windows.com"));
  } catch {
    return false;
  }
}
async function deliver(id: string | null) {
  const { data: jobs, error } = await admin.rpc("claim_moisture_push", {
    only_id: id,
  });
  if (error) throw new Error("Could not claim notifications");
  let delivered = 0;
  for (const job of jobs ?? []) {
    const { data: phone, error: readError } = await admin.from(
      "moisture_alert_phones",
    ).select("endpoint,keys").eq("user_id", job.user_id).maybeSingle();
    if (readError) continue;
    let status = "failed";
    if (phone && validEndpoint(phone.endpoint)) {
      try {
        const request = webpush.generateRequestDetails(
          phone,
          JSON.stringify({
            title: job.title,
            body: job.body,
            url: job.link,
            tag: job.id,
          }),
          {
            TTL: 600,
            vapidDetails: {
              subject: "mailto:support@exacth2o.com",
              publicKey: pub,
              privateKey: priv,
            },
          },
        );
        const result = await fetch(request.endpoint, {
          method: "POST",
          headers: request.headers,
          body: new Uint8Array(request.body),
          redirect: "error",
          signal: AbortSignal.timeout(7000),
        });
        if (result.ok) {
          status = "sent";
          delivered++;
        } else if (result.status === 404 || result.status === 410) {
          await admin.from("moisture_alert_phones").delete().eq(
            "user_id",
            job.user_id,
          ).eq("endpoint", phone.endpoint);
          status = "canceled";
        } else if (result.status === 429 || result.status >= 500) {
          status = "pending";
        }
      } catch {
        status = "pending";
      }
    }
    const { error: writeError } = await admin.from("moisture_alert_queue")
      .update({ status, due_at: new Date(Date.now() + 120000).toISOString() })
      .eq("id", job.id).eq("status", "sending").eq("attempts", job.attempts);
    if (writeError) throw new Error("Could not record delivery");
  }
  return delivered;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return reply({ error: "POST required" }, 405);
  try {
    if (!pub || !priv) {
      return reply({ error: "Phone alert delivery is unavailable" }, 503);
    }
    const body = await req.json();
    if (body.action === "dispatch") {
      const secret = req.headers.get("x-phone-alert-cron") || "";
      if (
        !["SYNC_OWNER_HEALTH_CRON_SECRET", "SYNC_OWNER_HEALTH_SECRET"].some(
          (k) => {
            const v = Deno.env.get(k);
            return v && constantTimeSecretMatch(secret, v);
          },
        )
      ) return reply({ error: "Unauthorized" }, 401);
      return reply({ sent: await deliver(null) });
    }
    const token = (req.headers.get("authorization") || "").replace(
      /^Bearer\s+/i,
      "",
    );
    if (!token) return reply({ error: "Sign in required" }, 401);
    const { data: { user }, error: authError } = await admin.auth.getUser(
      token,
    );
    if (authError || !user) return reply({ error: "Sign in required" }, 401);
    const { data: access } = await admin.from("portal_access").select(
      "project_id",
    ).eq("user_id", user.id)
      .eq("access_scope", "project").in("role", ["admin", "researcher"]).limit(
        1,
      );
    if (!access?.length) {
      return reply({ error: "Researcher access required" }, 403);
    }
    const phones = () => admin.from("moisture_alert_phones");
    if (body.action === "status") {
      const { data, error } = await phones().select("registered_at").eq(
        "user_id",
        user.id,
      ).maybeSingle();
      if (error) throw error;
      return reply({ connected: !!data, publicKey: pub });
    }
    if (body.action === "connect") {
      const sub = body.subscription;
      if (
        !validEndpoint(sub?.endpoint) ||
        !/^[\w-]{87}$/.test(sub?.keys?.p256dh ?? "") ||
        !/^[\w-]{22}$/.test(sub?.keys?.auth ?? "")
      ) {
        return reply({ error: "Unsupported browser push subscription" }, 400);
      }
      const { error } = await phones().upsert({
        user_id: user.id,
        endpoint: sub.endpoint,
        keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
        registered_at: new Date().toISOString(),
      }, { onConflict: "user_id" });
      if (error) {
        return reply({
          error:
            "Could not connect this device. It may already belong to another account.",
        }, 409);
      }
      return reply({ connected: true });
    }
    if (body.action === "disconnect") {
      const { error } = await phones().delete().eq("user_id", user.id);
      if (error) throw error;
      return reply({ connected: false });
    }
    if (body.action === "test") {
      const { data: id, error } = await admin.rpc("test_moisture_push", {
        uid: user.id,
      });
      if (error) {
        return reply({
          error: "Connect a phone before sending a test.",
        }, 409);
      }
      const count = await deliver(id);
      const { data: row } = await admin.from("moisture_alert_queue").select(
        "status",
      ).eq("id", id).single();
      return reply({ status: count ? "sent" : row?.status ?? "pending" });
    }
    return reply({ error: "Unknown action" }, 400);
  } catch {
    return reply({ error: "Phone alert service unavailable" }, 503);
  }
});
