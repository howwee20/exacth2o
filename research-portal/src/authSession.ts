type SupabaseErrorLike = {
  code?: unknown;
  message?: unknown;
  status?: unknown;
};

export const expiredPortalSessionNotice = "Your secure session expired. Please sign in again.";

export function isSessionAuthorizationError(error: unknown) {
  if (!error || typeof error !== "object") return false;

  const candidate = error as SupabaseErrorLike;
  const code = typeof candidate.code === "string" ? candidate.code.toUpperCase() : "";
  const message = typeof candidate.message === "string" ? candidate.message.toLowerCase() : "";
  const status = typeof candidate.status === "number" ? candidate.status : null;

  return status === 401
    || code === "PGRST301"
    || (code === "42501" && message.includes("permission denied"))
    || message.includes("jwt expired")
    || message.includes("invalid jwt")
    || message.includes("permission denied for table")
    || message.includes("permission denied for schema");
}
