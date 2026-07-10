function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.keys(value)
    .sort()
    .reduce((result, key) => {
      result[key] = stableValue(value[key]);
      return result;
    }, {});
}

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function publicClientAddress(request) {
  const direct = request.headers.get("x-real-ip") || request.headers.get("cf-connecting-ip");
  if (direct) return direct.trim().slice(0, 128);
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim().slice(0, 128);
  return "unavailable";
}

export async function enforcePublicSubmission({
  request,
  admin,
  scope,
  payload,
  maxRequests,
  windowSeconds = 600,
  salt,
}) {
  if (typeof salt !== "string" || salt.trim().length < 32) {
    throw new Error("A strong public form rate-limit salt is required");
  }
  const normalizedEmail = typeof payload?.email === "string"
    ? payload.email.trim().toLowerCase()
    : "";
  const address = publicClientAddress(request);
  const identifiers = [
    ...(address === "unavailable" ? [] : [{ kind: "network", value: address }]),
    ...(normalizedEmail ? [{ kind: "identity", value: normalizedEmail }] : []),
  ];
  if (identifiers.length === 0) {
    throw new Error("A public submission identity is required");
  }

  const fingerprint = await sha256(
    `${salt}:fingerprint:${scope}:${JSON.stringify(stableValue(payload))}`,
  );
  const decisions = [];
  for (const identifier of identifiers) {
    const clientHash = await sha256(`${salt}:${identifier.kind}:${identifier.value}`);
    const { data, error } = await admin.rpc("check_public_submission", {
      submission_scope: `${scope}:${identifier.kind}`,
      submission_client_hash: clientHash,
      max_requests: maxRequests,
      window_seconds: windowSeconds,
    });
    if (error) throw new Error(`Submission guard failed: ${error.message}`);
    const decision = Array.isArray(data) ? data[0] : data;
    decisions.push(decision);
    if (identifier.kind === "network" && decision?.allowed !== true) break;
  }

  return {
    allowed: decisions.every((decision) => decision?.allowed === true),
    duplicate: decisions.some((decision) => decision?.duplicate === true),
    retryAfterSeconds: Math.max(
      0,
      ...decisions.map((decision) => Number(decision?.retry_after_seconds ?? 0)),
    ),
    fingerprint,
  };
}
