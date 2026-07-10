import assert from "node:assert/strict";
import test from "node:test";

import { acceptedInviteRoles } from "./invite-role-policy.mjs";

test("invite roles map to project membership and portal access without widening viewers", () => {
  assert.deepEqual(acceptedInviteRoles("owner"), {
    projectMemberRole: "owner",
    portalRole: "admin",
  });
  assert.deepEqual(acceptedInviteRoles("admin"), {
    projectMemberRole: "admin",
    portalRole: "admin",
  });
  assert.deepEqual(acceptedInviteRoles("member"), {
    projectMemberRole: "researcher",
    portalRole: "researcher",
  });
  assert.deepEqual(acceptedInviteRoles("viewer"), {
    projectMemberRole: "viewer",
    portalRole: "viewer",
  });
});

test("unknown invite roles fail closed", () => {
  for (const role of [undefined, null, "", "Viewer", "researcher", "superadmin"]) {
    assert.equal(acceptedInviteRoles(role), null, String(role));
  }
});
