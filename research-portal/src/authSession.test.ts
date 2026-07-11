import { describe, expect, it } from "vitest";

import { isSessionAuthorizationError } from "./authSession";

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
