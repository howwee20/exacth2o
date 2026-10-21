import { describe, expect, it } from "vitest";

import { authEventReload, isSessionAuthorizationError } from "./authSession";

describe("portal session authorization errors", () => {
  it("recognizes the anonymous table denial shown after a session expires", () => {
    expect(isSessionAuthorizationError({
      code: "42501",
      message: "permission denied for table pairings",
    })).toBe(true);
  });

  it("recognizes expired or rejected JWT responses", () => {
    expect(isSessionAuthorizationError({ code: "PGRST301", message: "JWT expired" })).toBe(true);
    expect(isSessionAuthorizationError({ status: 401, message: "Unauthorized" })).toBe(true);
  });

  it("does not relabel unrelated database or network failures as session expiry", () => {
    expect(isSessionAuthorizationError({ code: "57014", message: "statement timeout" })).toBe(false);
    expect(isSessionAuthorizationError(new Error("Network request failed"))).toBe(false);
    expect(isSessionAuthorizationError(null)).toBe(false);
  });
});

describe("auth event reloads", () => {
  const user = { id: "user-a" };
  const now = Date.parse("2026-10-21T12:00:00Z");
  const fresh = { user, expires_at: now / 1000 + 3600 };

  it("loads once for a new sign-in, not for the same user's visibility SIGNED_IN", () => {
    const signedOut = { userId: null, tokenExpiresAtMs: null };
    const first = authEventReload(signedOut, "SIGNED_IN", fresh, now);
    expect(first.reload).toBe(true);
    expect(first.userChanged).toBe(true);
    const again = authEventReload(first.next, "SIGNED_IN", fresh, now + 60_000);
    expect(again.reload).toBe(false);
    expect(again.userChanged).toBe(false);
  });

  it("ignores routine token refreshes but reloads after a refresh that followed expiry", () => {
    const state = { userId: "user-a", tokenExpiresAtMs: now + 3_600_000 };
    expect(authEventReload(state, "TOKEN_REFRESHED", fresh, now + 3_300_000).reload).toBe(false);
    expect(authEventReload(state, "TOKEN_REFRESHED", fresh, now + 3_700_000).reload).toBe(true);
  });

  it("reloads for a different account and never for sign-out or the initial session", () => {
    const state = { userId: "user-a", tokenExpiresAtMs: now + 3_600_000 };
    const other = authEventReload(state, "SIGNED_IN", { user: { id: "user-b" }, expires_at: fresh.expires_at }, now);
    expect(other.reload).toBe(true);
    expect(authEventReload(state, "SIGNED_OUT", null, now)).toMatchObject({ reload: false, userChanged: true });
    const initial = authEventReload({ userId: null, tokenExpiresAtMs: null }, "INITIAL_SESSION", fresh, now);
    expect(initial.reload).toBe(false);
    expect(initial.next.userId).toBe("user-a");
  });
});
