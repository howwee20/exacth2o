import test from "node:test";
import assert from "node:assert/strict";
import {
  ensureApprovedOperation,
  recordQueuedCommandResources,
} from "./operation-ledger.mjs";

function query(result) {
  const chain = {
    insert: () => chain,
    select: () => chain,
    update: () => chain,
    eq: () => chain,
    maybeSingle: async () => result,
    single: async () => result,
  };
  return chain;
}

test("new operations are approved records with an immutable actor", async () => {
  const calls = [];
  const admin = {
    from: (table) => {
      assert.equal(table, "platform_operations");
      const chain = query({ data: { id: "op-1", approval_state: "approved" }, error: null });
      chain.insert = (value) => {
        calls.push(value);
        return chain;
      };
      return chain;
    },
    rpc: async (name, payload) => {
      calls.push({ name, payload });
      return { error: null };
    },
  };
  const operation = await ensureApprovedOperation(admin, {
    projectId: "project-1",
    userId: "user-1",
    capabilityId: "settings.change",
    intent: "Set the target to 30%.",
    specification: { target: 30 },
  });
  assert.equal(operation.id, "op-1");
  assert.equal(calls[0].approval_state, "approved");
  assert.equal(calls[0].requested_by, "user-1");
  assert.equal(calls[1].name, "record_platform_operation_event");
});

test("queued command resources share one operation", async () => {
  const rpcCalls = [];
  const admin = {
    from: () => query({ data: null, error: null }),
    rpc: async (name, payload) => {
      rpcCalls.push({ name, payload });
      return { error: null };
    },
  };
  await recordQueuedCommandResources(admin, {
    operationId: "op-1",
    projectId: "project-1",
    batchId: "batch-1",
    commands: [
      { id: "command-1", command_type: "update_system_state", status: "queued" },
      { id: "command-2", command_type: "update_pairing", status: "queued" },
    ],
  });
  assert.equal(
    rpcCalls.filter((call) => call.name === "link_platform_operation_resource").length,
    3,
  );
  assert.equal(rpcCalls.at(-1).name, "record_platform_operation_event");
});
