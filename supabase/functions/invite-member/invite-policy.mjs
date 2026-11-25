/** Rules for an invitation a project administrator sends from Account & access. */

/** Everyone invited from the portal joins as a researcher. Other roles stay an operator task. */
export const INVITE_ROLE = "member";
/** New invitations a project may send in a day. */
export const DAILY_LIMIT = 20;
export const INVITE_DAYS = 14;

/** @param {unknown} value */
export function inviteEmail(value) {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return email.length <= 200 && /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/.test(email) ? email : null;
}

/** @param {unknown} value */
export function projectId(value) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    ? value.toLowerCase() : null;
}

/**
 * The message is fixed. The sender cannot add words to it, so the company address cannot be used
 * to send someone else's text. The link works once and only for the invited address.
 *
 * @param {{ to: string, from: string, token: string, project: string, expires: Date }} invite
 */
export function inviteMessage({ to, from, token, project, expires }) {
  if (!/^[0-9a-f]{64}$/.test(token)) throw new Error("Invalid invite token.");
  const name = String(project || "").replace(/[\r\n]+/g, " ").trim().slice(0, 80);
  const until = expires.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "America/Detroit" });
  return {
    from,
    to: [to],
    subject: "Your ExactH2O portal invitation",
    text: [
      `You have been invited to the ExactH2O portal${name ? ` for ${name}` : ""}.`,
      "",
      "Create your account:",
      `https://exacth2o.com/portal?invite=${token}`,
      "",
      `Use ${to} when you sign up. The link works once and expires on ${until}.`,
      "If you were not expecting this, you can ignore this email.",
    ].join("\n"),
  };
}
