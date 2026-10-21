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

export type AuthReloadState = { userId: string | null; tokenExpiresAtMs: number | null };

/**
 * Decide whether an auth event should reload portal data. supabase-js emits
 * SIGNED_IN whenever a tab becomes visible and relays every event to all
 * tabs, and TOKEN_REFRESHED about hourly; reloading on each re-ran access
 * checks, the readings window and the catalog in every open tab. Reload only
 * when the signed-in user changes, or when a refresh follows an already
 * expired token (reads may have failed meanwhile).
 */
export function authEventReload(
  previous: AuthReloadState,
  event: string,
  session: { user?: { id?: string } | null; expires_at?: number | null } | null,
  nowMs = Date.now(),
): { reload: boolean; userChanged: boolean; next: AuthReloadState } {
  const userId = session?.user?.id ?? null;
  const userChanged = userId !== previous.userId;
  const recoveredAfterExpiry = event === "TOKEN_REFRESHED" &&
    previous.tokenExpiresAtMs !== null && nowMs >= previous.tokenExpiresAtMs;
  const next = {
    userId,
    tokenExpiresAtMs: typeof session?.expires_at === "number" ? session.expires_at * 1000 : null,
  };
  if (!session || event === "INITIAL_SESSION") return { reload: false, userChanged, next };
  const reload = (event === "SIGNED_IN" && userChanged) || recoveredAfterExpiry;
  return { reload, userChanged, next };
}
