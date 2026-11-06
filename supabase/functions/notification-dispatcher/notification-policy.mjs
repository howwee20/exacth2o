export function retryDelaySeconds(attemptCount) {
  const attempt = Math.max(1, Math.min(20, Number(attemptCount) || 1));
  return Math.min(24 * 60 * 60, 60 * (2 ** (attempt - 1)));
}

export function notificationRetryState(attemptCount, maxAttempts = 20) {
  return Number(attemptCount) >= maxAttempts ? "failed" : "pending";
}

export function notificationConfiguration(env) {
  const provider = String(env.NOTIFICATION_PROVIDER || "resend").trim().toLowerCase();
  const from = String(
    env.NOTIFICATION_FROM_EMAIL || env.QUOTE_EMAIL_FROM || "",
  ).trim();
  const apiKey = String(env.RESEND_API_KEY || "").trim();
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
