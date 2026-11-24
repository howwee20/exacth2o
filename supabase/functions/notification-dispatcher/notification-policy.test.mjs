import assert from "node:assert/strict";
import test from "node:test";
import {
  notificationConfiguration,
  sendNotification,
  resendPayload,
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

const notification = { id: "sample-job", destination: "owner@example.org", subject: "Test", body: "Test body" };
const provider = { from: "alerts@example.org", apiKey: "fixture" };

test("an ambiguous attempt reuses its key and body, and requires a provider receipt", async () => {
  const requests = [];
  const send = async (_url, request) => {
    requests.push({ key: request.headers["Idempotency-Key"], body: request.body });
    if (requests.length === 1) throw new Error("Connection lost");
    return Response.json({ id: "receipt" });
  };
  await assert.rejects(sendNotification(notification, provider, send), /Connection lost/);
  assert.equal(await sendNotification(notification, provider, send), "receipt");
  assert.deepEqual(requests[0], requests[1]);
  assert.equal(requests[0].key, "exacth2o-alert/sample-job/domain");
  for (const body of ["{}", '{"id":" "}', "invalid JSON"]) {
    await assert.rejects(sendNotification(notification, provider, async () => new Response(body)), /no delivery receipt/);
  }
});

test("provider rejections keep private response text out of the delivery log", async () => {
  const send = async () => Response.json({ name: "rate_limit", message: notification.destination }, { status: 429 });
  await assert.rejects(sendNotification(notification, provider, send), { message: "Email provider returned 429 (rate_limit)." });
});
