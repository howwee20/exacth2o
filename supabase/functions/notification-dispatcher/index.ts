import { createClient } from "npm:@supabase/supabase-js@2";
import {
  notificationConfiguration,
  notificationRetryState,
  resendPayload,
  retryDelaySeconds,
  UnverifiedDestinationError,
  verifiedDestination,
} from "./notification-policy.mjs";
import { constantTimeSecretMatch } from "../_shared/secret-compare.mjs";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

class SubscriptionEnded extends Error {}

Deno.serve(async (request) => {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const dispatcherSecret = Deno.env.get("NOTIFICATION_DISPATCHER_SECRET") || "";
  const suppliedSecret = request.headers.get("x-exacth2o-notification-secret") || "";
  if (!dispatcherSecret || !constantTimeSecretMatch(suppliedSecret, dispatcherSecret)) {
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
    { claim_limit: 8, claim_seconds: 120 },
  );
  if (claimError) return json({ error: "Notifications could not be claimed." }, 500);

  let delivered = 0;
  let failed = 0;
  for (const notification of notifications ?? []) {
    try {
      const { data: allowed, error: accessError } = await admin.rpc("email_notification_allowed", {
        notification_id: notification.id,
      });
      if (accessError) throw new Error("Could not verify alert preferences.");
      if (!allowed) throw new SubscriptionEnded("Alert subscription or project access has ended.");
      const { data: owner, error: ownerError } = await admin.auth.admin.getUserById(notification.user_id);
      if (ownerError) throw new Error("Could not verify the recipient account.");
      verifiedDestination(notification, owner?.user ?? null);
      const delivery = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          authorization: `Bearer ${provider.apiKey}`,
          "content-type": "application/json",
          "Idempotency-Key": `exacth2o-alert/${notification.id}`,
        },
        signal: AbortSignal.timeout(8_000),
        body: JSON.stringify(resendPayload(notification, provider.from)),
      });
      const deliveryBody = await delivery.json().catch(() => ({}));
      if (!delivery.ok) throw new Error(`Provider rejected delivery (${delivery.status}).`);
      const providerId = typeof deliveryBody?.id === "string" ? deliveryBody.id : null;
      const deliveredAt = new Date().toISOString();
      const { error: persistError } = await admin
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
        .eq("status", "sending")
        .eq("attempt_count", notification.attempt_count);
      if (persistError) throw new Error("Could not record provider acceptance.");
      await admin.from("notification_delivery_attempts").insert({
        notification_id: notification.id,
        status: "delivered",
        provider_id: providerId,
        response_metadata: { provider: "resend" },
      });
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
          // Retrying a revoked subscription or an unconfirmed address cannot deliver an eligible alert.
          status: error instanceof UnverifiedDestinationError || error instanceof SubscriptionEnded
            ? "canceled"
            : notificationRetryState(notification.attempt_count),
          next_attempt_at: nextAttemptAt,
          lease_until: null,
          last_error: message,
          updated_at: new Date().toISOString(),
        })
        .eq("id", notification.id)
        .eq("status", "sending")
        .eq("attempt_count", notification.attempt_count);
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
