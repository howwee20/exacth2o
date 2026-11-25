import assert from "node:assert/strict";
import test from "node:test";
import { DAILY_LIMIT, INVITE_ROLE, inviteEmail, inviteMessage, projectId } from "./invite-policy.mjs";

test("portal invitations only ever grant researcher access", () => {
  assert.equal(INVITE_ROLE, "member");
  assert.ok(DAILY_LIMIT > 0 && DAILY_LIMIT <= 50);
});

test("an invited address is one clean lower-case email", () => {
  assert.equal(inviteEmail("  New.Person@Example.EDU "), "new.person@example.edu");
  for (const bad of ["", "nobody", "a@b", "a b@example.edu", "a@example.edu, b@example.edu", "a@example.edu\nbcc: x@y.z", "<a@example.edu>", 7, null]) {
    assert.equal(inviteEmail(bad), null, String(bad));
  }
});

test("a project is named by its id", () => {
  assert.equal(projectId("22222222-2222-4222-8222-222222222222"), "22222222-2222-4222-8222-222222222222");
  assert.equal(projectId("22222222-2222-4222-8222-222222222222 or 1=1"), null);
  assert.equal(projectId(undefined), null);
});

test("the email carries the one-time link and nothing the sender wrote", () => {
  const token = "ab".repeat(32);
  const message = inviteMessage({
    to: "new.person@example.edu", from: "ExactH2O <alerts@example.com>", token,
    project: "Rhee Lab\nBcc: someone@example.com", expires: new Date("2026-12-09T17:00:00Z"),
  });
  assert.deepEqual(message.to, ["new.person@example.edu"]);
  assert.equal(message.subject, "Your ExactH2O portal invitation");
  assert.ok(message.text.includes(`https://exacth2o.com/portal?invite=${token}`));
  assert.ok(message.text.includes("for Rhee Lab Bcc: someone@example.com."));
  assert.ok(message.text.includes("expires on December 9, 2026"));
  assert.throws(() => inviteMessage({ to: "a@b.co", from: "x", token: "short", project: "", expires: new Date() }));
});
