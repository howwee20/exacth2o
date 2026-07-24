function compact(value, maxLength) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export async function ensureApprovedOperation(admin, input) {
  const operationId = compact(input.operationId, 80);
  if (operationId) {
    const { data, error } = await admin
      .from("platform_operations")
      .select("id,project_id,requested_by,capability_id,approval_state")
      .eq("id", operationId)
      .eq("project_id", input.projectId)
      .eq("requested_by", input.userId)
      .maybeSingle();
    if (error || !data || data.approval_state !== "approved") {
      throw new Error("The reviewed operation is unavailable.");
    }
    return data;
  }

  const now = new Date().toISOString();
  const { data, error } = await admin
    .from("platform_operations")
    .insert({
      project_id: input.projectId,
      requested_by: input.userId,
      capability_id: compact(input.capabilityId, 120),
      idempotency_key: compact(input.idempotencyKey, 200) || null,
      intent: compact(input.intent, 8_000) || "Apply reviewed ExactH2O operation.",
      specification: object(input.specification),
      approval_state: "approved",
      execution_state: "planned",
      verification_state: input.verificationRequired ? "pending" : "not_required",
      approved_by: input.userId,
      approved_at: now,
      metadata: object(input.metadata),
    })
    .select("id,project_id,requested_by,capability_id,approval_state")
    .single();
  if ((error?.code === "23505" || !data) && input.idempotencyKey) {
    const { data: existing, error: existingError } = await admin
      .from("platform_operations")
      .select("id,project_id,requested_by,capability_id,approval_state")
      .eq("project_id", input.projectId)
      .eq("requested_by", input.userId)
      .eq("idempotency_key", compact(input.idempotencyKey, 200))
      .maybeSingle();
    if (!existingError && existing) return existing;
  }
  if (error || !data) throw new Error("The approved operation could not be recorded.");

  await appendOperationEvent(admin, {
    operationId: data.id,
    projectId: input.projectId,
    eventType: "operation.approved",
    state: "approved",
    summary: "The reviewed operation was approved.",
    evidence: { capability_id: input.capabilityId },
    actorType: "user",
    actorId: input.userId,
  });
  return data;
}

export async function appendOperationEvent(admin, input) {
  const { error } = await admin.rpc("record_platform_operation_event", {
    selected_operation_id: input.operationId,
    selected_project_id: input.projectId,
    selected_event_type: compact(input.eventType, 120),
    selected_state: compact(input.state, 80),
    selected_summary: compact(input.summary, 500),
    selected_evidence: object(input.evidence),
    selected_actor_type: compact(input.actorType, 40) || "system",
    selected_actor_id: input.actorId || null,
  });
  if (error) throw new Error("The operation event could not be recorded.");
}

export async function linkOperationResource(admin, input) {
  const { error } = await admin.rpc("link_platform_operation_resource", {
    selected_operation_id: input.operationId,
    selected_project_id: input.projectId,
    selected_resource_type: compact(input.resourceType, 80),
    selected_resource_id: compact(input.resourceId, 200),
    selected_metadata: object(input.metadata),
  });
  if (error) throw new Error("The operation resource could not be linked.");
}

export async function markOperationQueued(admin, input) {
  const { error } = await admin
    .from("platform_operations")
    .update({
      execution_state: "queued",
      updated_at: new Date().toISOString(),
    })
    .eq("id", input.operationId)
    .eq("project_id", input.projectId);
  if (error) throw new Error("The operation queue state could not be recorded.");

  await appendOperationEvent(admin, {
    operationId: input.operationId,
    projectId: input.projectId,
    eventType: "operation.queued",
    state: "queued",
    summary: compact(input.summary, 500) || "The approved operation was queued.",
    evidence: object(input.evidence),
    actorType: "system",
  });
}

export async function markOperationCompleted(admin, input) {
  const completedAt = new Date().toISOString();
  const verificationState = input.verificationState || "not_required";
  const executionState = verificationState === "verified" ? "verified" : "completed";
  const { error } = await admin
    .from("platform_operations")
    .update({
      execution_state: executionState,
      verification_state: verificationState,
      completed_at: completedAt,
      updated_at: completedAt,
    })
    .eq("id", input.operationId)
    .eq("project_id", input.projectId);
  if (error) throw new Error("The operation completion could not be recorded.");

  await appendOperationEvent(admin, {
    operationId: input.operationId,
    projectId: input.projectId,
    eventType: "operation.completed",
    state: executionState,
    summary: compact(input.summary, 500) || "The approved operation completed.",
    evidence: object(input.evidence),
    actorType: "system",
  });
}

export async function markOperationFailed(admin, input) {
  await admin
    .from("platform_operations")
    .update({
      execution_state: "failed",
      completed_at: new Date().toISOString(),
      error_code: compact(input.errorCode, 120) || "operation_failed",
      error_message: compact(input.errorMessage, 1_000),
      updated_at: new Date().toISOString(),
    })
    .eq("id", input.operationId)
    .eq("project_id", input.projectId);

  await appendOperationEvent(admin, {
    operationId: input.operationId,
    projectId: input.projectId,
    eventType: "operation.failed",
    state: "failed",
    summary: compact(input.errorMessage, 500) || "The operation failed.",
    evidence: { error_code: input.errorCode },
    actorType: "system",
  }).catch(() => undefined);
}

export async function recordQueuedCommandResources(admin, input) {
  if (input.batchId) {
    await linkOperationResource(admin, {
      operationId: input.operationId,
      projectId: input.projectId,
      resourceType: "control_batch",
      resourceId: input.batchId,
    });
  }
  for (const command of input.commands) {
    await linkOperationResource(admin, {
      operationId: input.operationId,
      projectId: input.projectId,
      resourceType: "control_command",
      resourceId: String(command.id),
      metadata: {
        command_type: command.command_type,
        status: command.status,
      },
    });
  }
  await markOperationQueued(admin, {
    operationId: input.operationId,
    projectId: input.projectId,
    summary: `${input.commands.length} controller command${input.commands.length === 1 ? "" : "s"} queued.`,
    evidence: {
      batch_id: input.batchId || null,
      command_ids: input.commands.map((command) => command.id),
    },
  });
}
