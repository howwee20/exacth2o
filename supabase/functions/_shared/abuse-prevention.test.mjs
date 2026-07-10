import assert from "node:assert/strict";
import test from "node:test";

import { enforcePublicSubmission, publicClientAddress } from "./abuse-prevention.mjs";

test("publicClientAddress prefers proxy-provided direct addresses", () => {
  const request = new Request("https://example.test", {
    headers: {
      "x-real-ip": "192.0.2.8",
      "x-forwarded-for": "198.51.100.1, 198.51.100.2",
    },
  });
  assert.equal(publicClientAddress(request), "192.0.2.8");
});

test("public submission enforcement hashes identifiers and returns the RPC decision", async () => {
  const rpcCalls = [];
  const admin = {
    async rpc(name, args) {
      rpcCalls.push({ name, args });
      return { data: [{ allowed: true, duplicate: false, retry_after_seconds: 0 }], error: null };
    },
  };
  const request = new Request("https://example.test", {
    headers: { "x-real-ip": "192.0.2.8" },
  });
  const result = await enforcePublicSubmission({
    request,
    admin,
    scope: "quote",
    payload: { email: "person@example.test", name: "Person" },
    maxRequests: 5,
    salt: "test-only-rate-limit-salt-at-least-32-characters",
  });

  assert.equal(result.allowed, true);
  assert.equal(result.duplicate, false);
  assert.equal(result.retryAfterSeconds, 0);
  assert.match(result.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(rpcCalls.length, 2);
  assert.deepEqual(rpcCalls.map((call) => call.args.submission_scope), [
    "quote:network",
    "quote:identity",
  ]);
  rpcCalls.forEach((call) => {
    assert.equal(call.name, "check_public_submission");
    assert.match(call.args.submission_client_hash, /^[0-9a-f]{64}$/);
  });
  assert.equal(JSON.stringify(rpcCalls).includes("192.0.2.8"), false);
  assert.equal(JSON.stringify(rpcCalls).includes("person@example.test"), false);
});

test("public submission enforcement stops before identity state when the network is blocked", async () => {
  const scopes = [];
  const admin = {
    async rpc(_name, args) {
      scopes.push(args.submission_scope);
      if (args.submission_scope.endsWith(":identity")) {
        throw new Error("Identity rate-limit state must not be created for a blocked network");
      }
      return {
        data: [{ allowed: false, duplicate: false, retry_after_seconds: 137 }],
        error: null,
      };
    },
  };

  for (const email of ["attacker-chosen@example.test", "another-identity@example.test"]) {
    const result = await enforcePublicSubmission({
      request: new Request("https://example.test", {
        headers: { "x-real-ip": "192.0.2.8" },
      }),
      admin,
      scope: "support",
      payload: { email },
      maxRequests: 5,
      salt: "test-only-rate-limit-salt-at-least-32-characters",
    });

    assert.equal(result.allowed, false);
    assert.equal(result.duplicate, false);
    assert.equal(result.retryAfterSeconds, 137);
  }
  assert.deepEqual(scopes, ["support:network", "support:network"]);
});

test("public submission enforcement still rate limits identity when proxy address is unavailable", async () => {
  const scopes = [];
  const admin = {
    async rpc(_name, args) {
      scopes.push(args.submission_scope);
      return { data: [{ allowed: true, duplicate: false, retry_after_seconds: 0 }], error: null };
    },
  };

  const result = await enforcePublicSubmission({
    request: new Request("https://example.test"),
    admin,
    scope: "support",
    payload: { email: "person@example.test" },
    maxRequests: 5,
    salt: "test-only-rate-limit-salt-at-least-32-characters",
  });

  assert.equal(result.allowed, true);
  assert.deepEqual(scopes, ["support:identity"]);
});

test("public submission enforcement refuses a missing or weak hashing salt", async () => {
  const admin = {
    async rpc() {
      throw new Error("RPC must not be called without a strong salt");
    },
  };
  const request = new Request("https://example.test");

  await assert.rejects(
    () => enforcePublicSubmission({
      request,
      admin,
      scope: "support",
      payload: { email: "person@example.test" },
      maxRequests: 5,
      salt: "too-short",
    }),
    /strong public form rate-limit salt is required/,
  );
});
