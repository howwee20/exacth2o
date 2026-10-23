import assert from "node:assert/strict";
import test from "node:test";
import {
  notificationConfiguration,
  notificationRetryState,
  resendPayload,
  retryDelaySeconds,
  UnverifiedDestinationError,
  verifiedDestination,
} from "./notification-policy.mjs";

test("notification delivery stays disabled without provider secrets", () => {
  assert.equal(notificationConfiguration({}).ready, false);
});

test("notification delivery can reuse the verified public email sender", () => {
  assert.deepEqual(
    notificationConfiguration({
      RESEND_API_KEY: "re_test",
      QUOTE_EMAIL_FROM: "ExactH2O <updates@example.com>",
    }),
    {
      ready: true,
      provider: "resend",
      from: "ExactH2O <updates@example.com>",
      apiKey: "re_test",
    },
  );
});

test("retry backoff is bounded", () => {
  assert.equal(retryDelaySeconds(1), 60);
  assert.equal(retryDelaySeconds(20), 86_400);
});

test("notifications stop retrying after the bounded attempt count", () => {
  assert.equal(notificationRetryState(19), "pending");
  assert.equal(notificationRetryState(20), "failed");
});

test("provider payload includes only the intended message fields", () => {
  assert.deepEqual(
    resendPayload({
      destination: "researcher@example.com",
      subject: "Monitor triggered",
      body: "Pot 15 is below target.",
      metadata: { secret: "not forwarded" },
    }, "ExactH2O <alerts@example.com>"),
    {
      from: "ExactH2O <alerts@example.com>",
      to: ["researcher@example.com"],
      subject: "Monitor triggered",
      text: "Pot 15 is below target.",
    },
  );
});

test("email goes only to the owner's confirmed sign-in address", () => {
  const account = { email: "Owner@Example.org", email_confirmed_at: "2026-07-01T00:00:00Z" };
  assert.equal(verifiedDestination({ destination: " owner@example.org " }, account), "owner@example.org");
  assert.throws(() => verifiedDestination({ destination: "someone-else@example.org" }, account), UnverifiedDestinationError);
  assert.throws(() => verifiedDestination({ destination: "owner@example.org" }, { ...account, email_confirmed_at: null }), UnverifiedDestinationError);
  assert.throws(() => verifiedDestination({ destination: "owner@example.org" }, null), UnverifiedDestinationError);
  assert.throws(() => verifiedDestination({ destination: "" }, account), UnverifiedDestinationError);
});
