import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { anySecretMatches, constantTimeSecretMatch } from "./secret-compare.mjs";

test("shared secrets match only exactly, and an unset secret never matches", () => {
  assert.equal(constantTimeSecretMatch("s3cret-value", "s3cret-value"), true);
  for (const supplied of ["", "s3cret-valu", "s3cret-value ", "S3cret-value", undefined, null, 42]) {
    assert.equal(constantTimeSecretMatch(supplied, "s3cret-value"), false, String(supplied));
  }
  assert.equal(constantTimeSecretMatch("", ""), false);
});

test("any supplied value may match any accepted secret; empty secrets are ignored", () => {
  assert.equal(anySecretMatches(["wrong", "second-secret"], ["first-secret", "second-secret"]), true);
  assert.equal(anySecretMatches(["wrong"], ["first-secret", ""]), false);
  assert.equal(anySecretMatches([""], [""]), false);
});

test("secret-authenticated functions use the shared constant-time comparison", () => {
  for (const path of ["../notification-dispatcher/index.ts", "../sync-owner-health/index.ts", "../receive-walker-telemetry/receiver-policy.mjs"]) {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    assert.match(source, /secret-compare\.mjs/, path);
  }
});
