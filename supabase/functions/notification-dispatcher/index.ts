import { createClient } from "npm:@supabase/supabase-js@2";
import {
  notificationConfiguration,
  notificationRetryState,
  resendPayload,
  retryDelaySeconds,
} from "./notification-policy.mjs";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

Deno.serve(async (request) => {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const dispatcherSecret = Deno.env.get("NOTIFICATION_DISPATCHER_SECRET") || "";
  const suppliedSecret = request.headers.get("x-exacth2o-notification-secret") || "";
  if (!dispatcherSecret || suppliedSecret !== dispatcherSecret) {
    return json({ error: "Unauthorized" }, 401);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!supabaseUrl || !serviceKey) {
    return json({ error: "Notification dispatcher is not configured." }, 503);
  }

  const provider = notificationConfiguration(Deno.env.toObject());
  if (!provider.ready) return json({ error: provider.error }, 503);

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });
  const { data: notifications, error: claimError } = await admin.rpc(
    "claim_notification_outbox",
    { claim_limit: 25, claim_seconds: 120 },
  );
  if (claimError) return json({ error: "Notifications could not be claimed." }, 500);

  let delivered = 0;
  let failed = 0;
  for (const notification of notifications ?? []) {
    try {
      const delivery = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          authorization: `Bearer ${provider.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(resendPayload(notification, provider.from)),
      });
      const deliveryBody = await delivery.json().catch(() => ({}));
      if (!delivery.ok) throw new Error(`Provider rejected delivery (${delivery.status}).`);
      const providerId = typeof deliveryBody?.id === "string" ? deliveryBody.id : null;
      const deliveredAt = new Date().toISOString();
      await admin.from("notification_delivery_attempts").insert({
        notification_id: notification.id,
        status: "delivered",
        provider_id: providerId,
        response_metadata: { provider: "resend" },
      });
      await admin
        .from("notification_outbox")
        .update({
          status: "delivered",
          delivered_at: deliveredAt,
          provider_id: providerId,
          lease_until: null,
          last_error: null,
          updated_at: deliveredAt,
        })
        .eq("id", notification.id)
        .eq("status", "sending");
      delivered += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 500) : "Delivery failed.";
      const nextAttemptAt = new Date(
        Date.now() + retryDelaySeconds(notification.attempt_count) * 1_000,
      ).toISOString();
      await admin.from("notification_delivery_attempts").insert({
        notification_id: notification.id,
        status: "failed",
        error: message,
        response_metadata: { provider: "resend" },
      });
      await admin
        .from("notification_outbox")
        .update({
          status: notificationRetryState(notification.attempt_count),
          next_attempt_at: nextAttemptAt,
          lease_until: null,
          last_error: message,
          updated_at: new Date().toISOString(),
        })
        .eq("id", notification.id)
        .eq("status", "sending");
      failed += 1;
    }
  }

  return json({
    ok: true,
    claimed: notifications?.length ?? 0,
    delivered,
    failed,
  });
});
