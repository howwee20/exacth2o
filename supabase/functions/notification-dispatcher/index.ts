import { createClient } from "npm:@supabase/supabase-js@2";
import {
  notificationConfiguration,
  sendNotification,
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
  let unrecorded = 0;
  for (const notification of notifications ?? []) {
    let outcome: "accepted" | "retry" | "canceled";
    let receipt: string | null = null;
    let reason: string | null = null;
    try {
      const { data: allowed, error: accessError } = await admin.rpc("email_notification_allowed", {
        notification_id: notification.id,
      });
      if (accessError) throw new Error("Could not verify alert preferences.");
      if (!allowed) throw new SubscriptionEnded("Alert subscription or project access has ended.");
      const { data: owner, error: ownerError } = await admin.auth.admin.getUserById(notification.user_id);
      if (ownerError) throw new Error("Could not verify the recipient account.");
      verifiedDestination(notification, owner?.user ?? null);
      receipt = await sendNotification(notification, provider);
      outcome = "accepted";
    } catch (error) {
      outcome = error instanceof UnverifiedDestinationError || error instanceof SubscriptionEnded
        ? "canceled" : "retry";
      reason = error instanceof Error ? error.message.slice(0, 500) : "Email delivery failed.";
    }

    // A storage failure leaves the lease recoverable with the same provider key.
    const { data: status, error } = await admin.rpc("finish_notification_delivery", {
      notification_id: notification.id,
      claimed_attempt: notification.attempt_count,
      outcome,
      receipt,
      failure_reason: reason,
    });
    if (error) unrecorded++;
    else if (status === "delivered") delivered++;
    else if (status !== null) failed++;
  }

  if (unrecorded) return json({ error: "Could not record all email outcomes.", unrecorded }, 500);
  return json({
    ok: true,
    claimed: notifications?.length ?? 0,
    delivered,
    failed,
  });
});
