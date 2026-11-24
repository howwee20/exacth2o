export function notificationConfiguration(env) {
  const provider = String(env.NOTIFICATION_PROVIDER || "resend").trim().toLowerCase();
  const from = String(
    env.NOTIFICATION_FROM_EMAIL || env.QUOTE_EMAIL_FROM || "",
  ).trim();
  const apiKey = String(env.NOTIFICATION_RESEND_API_KEY || env.RESEND_API_KEY || "").trim();
  if (provider !== "resend") {
    return { ready: false, error: "Unsupported notification provider." };
  }
  if (!from || !apiKey) {
    return { ready: false, error: "Email notification delivery is not configured." };
  }
  return { ready: true, provider, from, apiKey };
}

export class UnverifiedDestinationError extends Error {
  constructor() {
    super("Notification destination is not the account's confirmed email.");
    this.name = "UnverifiedDestinationError";
  }
}

/**
 * Email is delivered only to the confirmed sign-in address of the account that owns the
 * preference. set_notification_preference accepts any well-formed address, so without
 * this check a project member could route project mail (with text they influence) from
 * the company sender to any third party.
 */
export function verifiedDestination(notification, account) {
  const destination = String(notification?.destination || "").trim().toLowerCase();
  const confirmed = account?.email_confirmed_at ? String(account.email || "").trim().toLowerCase() : "";
  if (!destination || !confirmed || destination !== confirmed) throw new UnverifiedDestinationError();
  return destination;
}

export function resendPayload(notification, from) {
  const to = String(notification?.destination || "").trim();
  if (!to || !to.includes("@")) throw new Error("Notification destination is invalid.");
  return {
    from,
    to: [to],
    subject: String(notification.subject || "").trim().slice(0, 200),
    text: String(notification.body || "").trim().slice(0, 8_000),
  };
}

export async function sendNotification(notification, provider, send = fetch) {
  const response = await send("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${provider.apiKey}`,
      "content-type": "application/json",
      "Idempotency-Key": `exacth2o-alert/${notification.id}/domain`,
    },
    signal: AbortSignal.timeout(8_000),
    body: JSON.stringify(resendPayload(notification, provider.from)),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    // Provider error text can contain the address or message. Store only the code.
    const code = String(body?.name || "provider_error").replace(/[^a-z_]/gi, "").slice(0, 60);
    throw new Error(`Email provider returned ${response.status} (${code}).`);
  }
  if (typeof body?.id !== "string" || !body.id.trim()) {
    throw new Error("Email provider returned no delivery receipt.");
  }
  return body.id;
}
