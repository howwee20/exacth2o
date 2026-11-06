// The Walker Lab bridge exchanges a Walker Lab session cookie for a full ExactH2O session
// (access and refresh token) after depi.berkleywalker.org confirms the account. That site
// is outside ExactH2O's control, so the bridge stays off unless it is explicitly enabled.
export function bridgeEnabled(env) {
  return env?.WALKER_MIXER_SESSION_ENABLED === "true";
}

const userIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Linked accounts come from the WALKER_MIXER_SESSION_IDENTITIES secret, a JSON object that
// maps a Walker Lab username (email) to an ExactH2O user id, so they stay out of source.
/** @returns {Record<string, string>} */
export function linkedIdentities(raw) {
  let parsed;
  try {
    parsed = JSON.parse(String(raw ?? ""));
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  /** @type {Record<string, string>} */
  const identities = {};
  for (const [username, userId] of Object.entries(parsed)) {
    if (typeof userId === "string" && userIdPattern.test(userId)) {
      identities[username.trim().toLowerCase()] = userId.toLowerCase();
    }
  }
  return identities;
}
