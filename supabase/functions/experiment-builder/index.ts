import { createClient } from "npm:@supabase/supabase-js@2";
import {
  compileControlPlan,
  experimentDraftSchema,
  inventoryFromDeviceConfig,
  responseOutputText,
  systemInstructions,
  userDraftInput,
  validateDraft,
  validatePracticeDraft,
} from "./experiment-policy.mjs";
import {
  normalizeSettingsPlan,
  settingsPlanSchema,
  settingsSystemInstructions,
  settingsUserInput,
} from "./settings-policy.mjs";
import {
  assistantIntentInput,
  assistantIntentInstructions,
  assistantIntentSchema,
  normalizeAssistantIntent,
} from "./assistant-policy.mjs";
import {
  automationReviewToken,
  monitorPlanSchema,
  monitorSystemInstructions,
  monitorUserInput,
  normalizeMonitorPlan,
  normalizeSchedulePlan,
  schedulePlanSchema,
  scheduleSystemInstructions,
  scheduleUserInput,
} from "./automation-policy.mjs";
import {
  aggregateExperimentReadings,
  aggregateValveEvents,
  assistantArtifactsFromToolEvidence,
  assistantCapabilities,
  assistantChatInstructions,
  assistantFunctionCalls,
  assistantTools,
  compareExperimentAggregates,
  experimentArchiveDecision,
  normalizeAssistantConversation,
  proposalFromFunctionCall,
  resolveExactExperimentCatalog,
  resolveExperimentCatalog,
} from "./assistant-chat-policy.mjs";
import {
  ensureApprovedOperation,
  linkOperationResource,
  markOperationCompleted,
  markOperationFailed,
} from "../_shared/operation-ledger.mjs";
import {
  clean,
  isUuid,
  openAiUsage,
  record,
  scheduleInputForNormalization,
  sha256,
} from "./request-utils.mjs";

const allowedOrigins = new Set([
  "https://exacth2o.com",
  "https://www.exacth2o.com",
  "https://howwee20.github.io",
  "http://127.0.0.1:5173",
  "http://localhost:5173",
]);
const draftRequestLimitPerDay = 20;
const chatRequestLimitPerDay = 100;
const promptLimit = 4_000;

function response(body: unknown, status: number, origin: string | null) {
  const allowedOrigin = origin && allowedOrigins.has(origin)
    ? origin
    : "https://exacth2o.com";
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "private, no-store",
      "access-control-allow-origin": allowedOrigin,
      "access-control-allow-headers":
        "authorization, content-type, apikey, x-client-info",
      "access-control-allow-methods": "POST, OPTIONS",
      vary: "origin",
    },
  });
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Experiment builder failed.";
}

Deno.serve(async (request) => {
  const origin = request.headers.get("origin");
  if (request.method === "OPTIONS") return response({ ok: true }, 200, origin);
  if (request.method !== "POST") {
    return response({ error: "Method not allowed" }, 405, origin);
  }
  if (origin && !allowedOrigins.has(origin)) {
    return response({ error: "Origin not allowed" }, 403, origin);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const openAiKey = Deno.env.get("OPENAI_API_KEY");
  const model = Deno.env.get("OPENAI_MODEL") || "gpt-5.6-luna";
  const reasoningEffort = Deno.env.get("OPENAI_REASONING_EFFORT") || "none";
  if (!supabaseUrl || !anonKey || !serviceKey || !openAiKey) {
    return response({ error: "Experiment builder is not configured." }, 503, origin);
  }

  const authorization = request.headers.get("authorization") ?? "";
  const jwt = authorization.replace(/^Bearer\s+/i, "");
  if (!jwt) return response({ error: "Authentication required." }, 401, origin);

  const authClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false },
  });
  const { data: userData, error: userError } = await authClient.auth.getUser(jwt);
  if (userError || !userData.user) {
    return response({ error: "Authentication required." }, 401, origin);
  }

  const body = record(await request.json().catch(() => ({})));
  const action = (
      body.action === "draft" ||
      body.action === "revise" ||
      body.action === "preflight" ||
      body.action === "launch" ||
      body.action === "edit_preflight" ||
      body.action === "edit_apply" ||
      body.action === "route" ||
      body.action === "assistant_chat" ||
      body.action === "assistant_thread_rename" ||
      body.action === "assistant_thread_delete" ||
      body.action === "settings_draft" ||
      body.action === "settings_revise" ||
      body.action === "archive_preflight" ||
      body.action === "archive" ||
      body.action === "schedule_draft" ||
      body.action === "schedule_create" ||
      body.action === "monitor_draft" ||
      body.action === "monitor_create" ||
      body.action === "lifecycle_preflight" ||
      body.action === "lifecycle_apply" ||
      body.action === "automation_cancel"
    )
    ? body.action
    : null;
  const projectId = clean(body.project_id, 80);
  if (!action || !isUuid(projectId)) {
    return response({ error: "A valid action and project are required." }, 400, origin);
  }

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });
  const { data: access, error: accessError } = await admin
    .from("portal_access")
    .select("role")
    .eq("project_id", projectId)
    .eq("user_id", userData.user.id)
    .maybeSingle();
  if (accessError) {
    return response({ error: "Could not verify portal access." }, 500, origin);
  }
  if (access?.role !== "admin" && access?.role !== "researcher") {
    return response({ error: "Researcher or administrator access is required." }, 403, origin);
  }

  if (action === "assistant_thread_rename" || action === "assistant_thread_delete") {
    const threadId = clean(body.thread_id, 80);
    if (!isUuid(threadId)) {
      return response({ error: "Choose a valid conversation." }, 400, origin);
    }
    if (action === "assistant_thread_rename") {
      const title = clean(body.title, 160);
      if (!title) return response({ error: "Name the conversation." }, 400, origin);
      const { data, error } = await admin
        .from("assistant_threads")
        .update({ title, updated_at: new Date().toISOString() })
        .eq("id", threadId)
        .eq("project_id", projectId)
        .eq("user_id", userData.user.id)
        .select("id,title,status,created_at,updated_at")
        .maybeSingle();
      if (error) return response({ error: "The conversation could not be renamed." }, 500, origin);
      if (!data) return response({ error: "The conversation was not found." }, 404, origin);
      return response({ thread: data }, 200, origin);
    }
    const { data, error } = await admin
      .from("assistant_threads")
      .delete()
      .eq("id", threadId)
      .eq("project_id", projectId)
      .eq("user_id", userData.user.id)
      .select("id")
      .maybeSingle();
    if (error) return response({ error: "The conversation could not be deleted." }, 500, origin);
    if (!data) return response({ error: "The conversation was not found." }, 404, origin);
    return response({
      deleted_thread_id: threadId,
      audit_history_preserved: true,
    }, 200, origin);
  }

  const { data: configState, error: configError } = await admin
    .from("device_config_state")
    .select(
      "project_id,device_id,pairings,groups,calibrations,board_config,sensors,valves,updated_at,config_hash",
    )
    .eq("project_id", projectId)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (configError || !configState) {
    return response({ error: "Current pot inventory is unavailable." }, 503, origin);
  }
  const inventory = inventoryFromDeviceConfig(configState);
  if (!inventory.length) {
    return response({ error: "Current pot inventory is empty." }, 503, origin);
  }

  if (action === "archive_preflight" || action === "archive") {
    const requestedExperiment = clean(body.experiment, 160);
    if (!requestedExperiment) {
      return response({ error: "Name the experiment to remove." }, 400, origin);
    }
    const { data: experimentRows, error: experimentError } = await admin
      .from("experiments")
      .select(
        "id,project_id,slug,name,description,mode,status,watering_state,started_at,ended_at,current_revision_id,created_by,created_at,updated_at",
      )
      .eq("project_id", projectId)
      .neq("status", "archived");
    if (experimentError) {
      return response({ error: "Experiment records are unavailable." }, 503, origin);
    }
    const experiment = resolveExactExperimentCatalog(
      experimentRows ?? [],
      requestedExperiment,
    );
    if (!experiment) {
      return response({
        error: "Use the exact experiment name or slug.",
        available_experiments: (experimentRows ?? []).map((item) => item.name),
      }, 404, origin);
    }
    const requestedExperimentId = clean(body.experiment_id, 80);
    if (
      action === "archive" &&
      (!isUuid(requestedExperimentId) || requestedExperimentId !== experiment.id)
    ) {
      return response({ error: "The reviewed experiment no longer matches." }, 409, origin);
    }
    const { data: revision, error: revisionError } = await admin
      .from("experiment_revisions")
      .select("id,source,created_by,created_at")
      .eq("id", experiment.current_revision_id)
      .eq("experiment_id", experiment.id)
      .eq("project_id", projectId)
      .maybeSingle();
    if (revisionError || !revision) {
      return response({ error: "The current experiment revision is unavailable." }, 503, origin);
    }
    const { count: activeCommandCount, error: commandError } = await admin
      .from("project_control_commands")
      .select("id", { count: "exact", head: true })
      .eq("project_id", projectId)
      .eq("experiment_id", experiment.id)
      .in("status", ["queued", "accepted", "running"]);
    if (commandError) {
      return response({ error: "Experiment activity is unavailable." }, 503, origin);
    }
    const decision = experimentArchiveDecision({
      experiment,
      revisionSource: revision.source,
      role: access.role,
      userId: userData.user.id,
      activeCommandCount: activeCommandCount ?? 0,
    });
    const reviewedState = [
      experiment.id,
      experiment.slug,
      experiment.status,
      experiment.mode,
      experiment.watering_state,
      experiment.current_revision_id,
      experiment.updated_at,
      revision.source,
      String(activeCommandCount ?? 0),
    ].join("|");
    const reviewToken = await sha256(reviewedState);

    if (action === "archive_preflight") {
      return response({
        experiment_id: experiment.id,
        experiment_slug: experiment.slug,
        experiment_name: experiment.name,
        mode: experiment.mode,
        status: experiment.status,
        watering_state: experiment.watering_state,
        history_preserved: true,
        review_token: reviewToken,
        can_archive: decision.allowed,
        reason: decision.reason,
      }, 200, origin);
    }
    if (!decision.allowed) {
      return response({ error: decision.reason }, 409, origin);
    }
    if (body.confirm !== true || clean(body.review_token, 128) !== reviewToken) {
      return response({ error: "Review this experiment again before removing it." }, 409, origin);
    }

    let archiveOperation;
    try {
      archiveOperation = await ensureApprovedOperation(admin, {
        projectId,
        userId: userData.user.id,
        capabilityId: "experiment.archive",
        idempotencyKey: `archive:${reviewToken}`,
        intent: `Archive experiment ${experiment.name} while preserving its history.`,
        specification: {
          experiment_id: experiment.id,
          experiment_name: experiment.name,
          history_preserved: true,
          watering_state: experiment.watering_state,
        },
        verificationRequired: false,
        metadata: { source: "portal_assistant" },
      });
    } catch {
      return response({ error: "The approved removal could not be recorded." }, 500, origin);
    }

    const archiveTime = new Date().toISOString();
    const { data: archived, error: archiveError } = await admin
      .from("experiments")
      .update({
        status: "archived",
        ended_at: experiment.ended_at ?? archiveTime,
        updated_at: archiveTime,
      })
      .eq("id", experiment.id)
      .eq("project_id", projectId)
      .eq("updated_at", experiment.updated_at)
      .eq("watering_state", "off")
      .select("id,slug,name,status,updated_at")
      .maybeSingle();
    if (archiveError || !archived) {
      await markOperationFailed(admin, {
        operationId: archiveOperation.id,
        projectId,
        errorCode: "experiment_changed",
        errorMessage: "The experiment changed after review.",
      });
      return response({
        error: "The experiment changed after review. Review it again.",
      }, 409, origin);
    }
    const { error: auditError } = await admin
      .from("experiment_audit_events")
      .insert({
        experiment_id: experiment.id,
        project_id: projectId,
        revision_id: experiment.current_revision_id,
        event_type: "archived",
        actor_id: userData.user.id,
        details: {
          source: "portal_assistant",
          previous_status: experiment.status,
          watering_state: experiment.watering_state,
          history_preserved: true,
        },
      });
    if (auditError) {
      await admin
        .from("experiments")
        .update({
          status: experiment.status,
          ended_at: experiment.ended_at,
          updated_at: experiment.updated_at,
        })
        .eq("id", experiment.id)
        .eq("project_id", projectId)
        .eq("updated_at", archiveTime)
        .eq("status", "archived");
      await markOperationFailed(admin, {
        operationId: archiveOperation.id,
        projectId,
        errorCode: "audit_write_failed",
        errorMessage: "The removal was not recorded and was rolled back.",
      });
      return response({
        error: "The removal was not recorded, so the experiment was left unchanged.",
      }, 500, origin);
    }
    await linkOperationResource(admin, {
      operationId: archiveOperation.id,
      projectId,
      resourceType: "experiment",
      resourceId: archived.id,
    });
    await markOperationCompleted(admin, {
      operationId: archiveOperation.id,
      projectId,
      summary: `${archived.name} was archived with history preserved.`,
      evidence: { experiment_id: archived.id, history_preserved: true },
    });
    return response({
      operation_id: archiveOperation.id,
      experiment_id: archived.id,
      experiment_slug: archived.slug,
      experiment_name: archived.name,
      status: archived.status,
      history_preserved: true,
    }, 200, origin);
  }

  if (action === "lifecycle_preflight" || action === "lifecycle_apply") {
    const requestedExperiment = clean(body.experiment, 160);
    const lifecycleAction = body.lifecycle_action === "restore" ? "restore" : "complete";
    if (!requestedExperiment) {
      return response({ error: "Name the experiment." }, 400, origin);
    }
    const { data: experimentRows, error: experimentError } = await admin
      .from("experiments")
      .select(
        "id,project_id,slug,name,mode,status,watering_state,current_revision_id,created_by,updated_at",
      )
      .eq("project_id", projectId);
    if (experimentError) {
      return response({ error: "Experiment records are unavailable." }, 503, origin);
    }
    const experiment = resolveExactExperimentCatalog(
      experimentRows ?? [],
      requestedExperiment,
    );
    if (!experiment) {
      return response({
        error: "Use the exact experiment name or slug.",
        available_experiments: (experimentRows ?? []).map((item) => item.name),
      }, 404, origin);
    }
    const { data: revision, error: revisionError } = await admin
      .from("experiment_revisions")
      .select("source,created_by")
      .eq("id", experiment.current_revision_id)
      .maybeSingle();
    const { count: activeCommandCount, error: commandError } = await admin
      .from("project_control_commands")
      .select("id", { count: "exact", head: true })
      .eq("project_id", projectId)
      .eq("experiment_id", experiment.id)
      .in("status", ["queued", "accepted", "running"]);
    if (revisionError || !revision || commandError) {
      return response({ error: "Experiment lifecycle evidence is unavailable." }, 503, origin);
    }

    let canApply = false;
    let reason = "";
    if (lifecycleAction === "complete") {
      if (experiment.watering_state !== "off") {
        reason = "Turn watering off through a separate reviewed settings plan first.";
      } else if ((activeCommandCount ?? 0) > 0) {
        reason = "Wait for active experiment commands to finish.";
      } else if (!["published_sensing", "active", "activation_failed"].includes(experiment.status)) {
        reason = "This experiment cannot be completed from its current state.";
      } else {
        canApply = true;
        reason = "Completion records the end time and preserves the tile, readings, and history.";
      }
    } else if (experiment.status !== "archived" || experiment.watering_state !== "off") {
      reason = "Only a safely archived sensing experiment can be restored.";
    } else if (
      !["manual", "natural_language"].includes(revision.source) ||
      (
        access.role !== "admin" &&
        experiment.created_by !== userData.user.id
      )
    ) {
      reason = "Only the creator or an administrator can restore this portal-created experiment.";
    } else {
      canApply = true;
      reason = "Restoration returns the sensing-only tile without changing controller settings.";
    }

    const reviewedState = JSON.stringify({
      experiment_id: experiment.id,
      action: lifecycleAction,
      status: experiment.status,
      watering_state: experiment.watering_state,
      revision_id: experiment.current_revision_id,
      updated_at: experiment.updated_at,
      active_commands: activeCommandCount ?? 0,
      actor_id: userData.user.id,
    });
    const reviewToken = await sha256(reviewedState);
    if (action === "lifecycle_preflight") {
      return response({
        experiment_id: experiment.id,
        experiment_slug: experiment.slug,
        experiment_name: experiment.name,
        lifecycle_action: lifecycleAction,
        status: experiment.status,
        watering_state: experiment.watering_state,
        can_apply: canApply,
        reason,
        review_token: reviewToken,
      }, 200, origin);
    }
    if (
      body.confirm !== true ||
      !canApply ||
      clean(body.review_token, 128) !== reviewToken ||
      clean(body.experiment_id, 80) !== experiment.id
    ) {
      return response({
        error: canApply ? "Review this lifecycle action again." : reason,
      }, 409, origin);
    }
    let lifecycleOperation;
    try {
      lifecycleOperation = await ensureApprovedOperation(admin, {
        projectId,
        userId: userData.user.id,
        capabilityId: "experiment.lifecycle",
        idempotencyKey: `lifecycle:${reviewToken}`,
        intent: `${lifecycleAction === "restore" ? "Restore" : "Complete"} experiment ${experiment.name}.`,
        specification: {
          experiment_id: experiment.id,
          experiment_name: experiment.name,
          lifecycle_action: lifecycleAction,
          history_preserved: true,
        },
        verificationRequired: false,
        metadata: { source: "portal_assistant" },
      });
    } catch {
      return response({ error: "The approved lifecycle action could not be recorded." }, 500, origin);
    }
    const functionName = lifecycleAction === "restore"
      ? "restore_assistant_experiment"
      : "complete_assistant_experiment";
    const { data: applied, error: applyError } = await authClient.rpc(functionName, {
      requested_project_id: projectId,
      requested_experiment_id: experiment.id,
    });
    if (applyError) {
      await markOperationFailed(admin, {
        operationId: lifecycleOperation.id,
        projectId,
        errorCode: "lifecycle_apply_failed",
        errorMessage: applyError.message,
      });
      return response({ error: applyError.message }, 409, origin);
    }
    const appliedRow = Array.isArray(applied) ? applied[0] : applied;
    await linkOperationResource(admin, {
      operationId: lifecycleOperation.id,
      projectId,
      resourceType: "experiment",
      resourceId: experiment.id,
    });
    await markOperationCompleted(admin, {
      operationId: lifecycleOperation.id,
      projectId,
      summary: `${experiment.name} was ${lifecycleAction === "restore" ? "restored" : "completed"}.`,
      evidence: {
        experiment_id: experiment.id,
        lifecycle_action: lifecycleAction,
        history_preserved: true,
      },
    });
    return response({
      operation_id: lifecycleOperation.id,
      experiment_id: appliedRow?.experiment_id ?? experiment.id,
      experiment_slug: appliedRow?.experiment_slug ?? experiment.slug,
      status: appliedRow?.experiment_status ??
        (lifecycleAction === "restore" ? "published_sensing" : "completed"),
      lifecycle_action: lifecycleAction,
      history_preserved: true,
    }, 200, origin);
  }

  if (action === "automation_cancel") {
    const automationId = clean(body.automation_id, 80);
    const automationType = body.automation_type === "monitor" ? "monitor" : "schedule";
    if (!isUuid(automationId)) {
      return response({ error: "Choose a valid schedule or monitor." }, 400, origin);
    }
    const table = automationType === "monitor"
      ? "assistant_monitors"
      : "assistant_schedules";
    const { data: item, error: itemError } = await admin
      .from(table)
      .select("id,project_id,created_by,status")
      .eq("id", automationId)
      .eq("project_id", projectId)
      .maybeSingle();
    if (itemError || !item) {
      return response({ error: "The schedule or monitor was not found." }, 404, origin);
    }
    if (access.role !== "admin" && item.created_by !== userData.user.id) {
      return response({ error: "Only the creator or an administrator can cancel this." }, 403, origin);
    }
    const cancellable = automationType === "monitor"
      ? ["active", "paused"].includes(item.status)
      : ["active", "paused", "failed"].includes(item.status);
    if (!cancellable) {
      return response({ error: "This item is not in a cancellable state." }, 409, origin);
    }
    const { data: canceled, error: cancelError } = await admin
      .from(table)
      .update({
        status: "canceled",
        updated_at: new Date().toISOString(),
        ...(automationType === "schedule" ? { lease_until: null } : {}),
      })
      .eq("id", automationId)
      .eq("project_id", projectId)
      .eq("status", item.status)
      .select("id,status,updated_at")
      .maybeSingle();
    if (cancelError || !canceled) {
      return response({ error: "The item changed before it could be canceled." }, 409, origin);
    }
    return response({ automation_type: automationType, item: canceled }, 200, origin);
  }

  if (action === "schedule_create") {
    const { plan } = normalizeSchedulePlan(
      scheduleInputForNormalization(body.plan),
      configState,
      access.role,
    );
    if (plan.questions.length || !plan.run_at || !plan.settings_plan.commands.length) {
      return response({
        error: "Resolve the schedule before approval.",
        validation_messages: plan.questions,
      }, 400, origin);
    }
    const reviewState = automationReviewToken(
      "schedule",
      userData.user.id,
      projectId,
      plan,
      configState.config_hash,
    );
    const reviewToken = await sha256(reviewState);
    if (body.confirm !== true || clean(body.review_token, 128) !== reviewToken) {
      return response({ error: "Review this schedule again before creating it." }, 409, origin);
    }
    let scheduleOperation;
    try {
      scheduleOperation = await ensureApprovedOperation(admin, {
        projectId,
        userId: userData.user.id,
        capabilityId: "schedule.manage",
        idempotencyKey: `schedule:${reviewToken}`,
        intent: `Create schedule ${plan.name}.`,
        specification: plan,
        verificationRequired: false,
        metadata: { source: "portal_assistant" },
      });
    } catch {
      return response({ error: "The approved schedule could not be recorded." }, 500, origin);
    }
    const { data: created, error: createError } = await admin
      .from("assistant_schedules")
      .insert({
        project_id: projectId,
        created_by: userData.user.id,
        created_by_role: access.role,
        name: plan.name,
        timezone: plan.timezone,
        recurrence: plan.recurrence,
        approved_plan: plan,
        approved_config_hash: configState.config_hash,
        review_token_hash: reviewToken,
        status: "active",
        next_run_at: plan.run_at,
        confirmed_at: new Date().toISOString(),
      })
      .select("id,name,status,next_run_at,recurrence,timezone,created_at")
      .single();
    if (createError?.code === "23505") {
      const { data: existing } = await admin
        .from("assistant_schedules")
        .select("id,name,status,next_run_at,recurrence,timezone,created_at")
        .eq("project_id", projectId)
        .eq("created_by", userData.user.id)
        .eq("review_token_hash", reviewToken)
        .maybeSingle();
      if (existing) {
        await linkOperationResource(admin, {
          operationId: scheduleOperation.id,
          projectId,
          resourceType: "schedule",
          resourceId: existing.id,
        });
        await markOperationCompleted(admin, {
          operationId: scheduleOperation.id,
          projectId,
          summary: `Schedule ${existing.name} is active.`,
          evidence: { schedule_id: existing.id, next_run_at: existing.next_run_at },
        });
        return response({
          operation_id: scheduleOperation.id,
          schedule: existing,
        }, 200, origin);
      }
    }
    if (createError || !created) {
      await markOperationFailed(admin, {
        operationId: scheduleOperation.id,
        projectId,
        errorCode: "schedule_create_failed",
        errorMessage: "The approved schedule could not be saved.",
      });
      return response({ error: "The approved schedule could not be saved." }, 500, origin);
    }
    await linkOperationResource(admin, {
      operationId: scheduleOperation.id,
      projectId,
      resourceType: "schedule",
      resourceId: created.id,
    });
    await markOperationCompleted(admin, {
      operationId: scheduleOperation.id,
      projectId,
      summary: `Schedule ${created.name} was created.`,
      evidence: { schedule_id: created.id, next_run_at: created.next_run_at },
    });
    return response({
      operation_id: scheduleOperation.id,
      schedule: created,
    }, 200, origin);
  }

  if (action === "monitor_create") {
    const { data: catalog, error: catalogError } = await authClient
      .from("portal_experiment_catalog")
      .select("id,slug,name,status,pairing_names")
      .eq("project_id", projectId);
    if (catalogError) {
      return response({ error: "Experiment catalog is unavailable." }, 503, origin);
    }
    const { plan } = normalizeMonitorPlan(body.plan, catalog ?? []);
    if (plan.questions.length) {
      return response({
        error: "Resolve the monitor before approval.",
        validation_messages: plan.questions,
      }, 400, origin);
    }
    const reviewToken = await sha256(automationReviewToken(
      "monitor",
      userData.user.id,
      projectId,
      plan,
    ));
    if (body.confirm !== true || clean(body.review_token, 128) !== reviewToken) {
      return response({ error: "Review this monitor again before creating it." }, 409, origin);
    }
    let monitorOperation;
    try {
      monitorOperation = await ensureApprovedOperation(admin, {
        projectId,
        userId: userData.user.id,
        capabilityId: "monitor.manage",
        idempotencyKey: `monitor:${reviewToken}`,
        intent: `Create monitor ${plan.name}.`,
        specification: plan,
        verificationRequired: false,
        metadata: { source: "portal_assistant" },
      });
    } catch {
      return response({ error: "The approved monitor could not be recorded." }, 500, origin);
    }
    const { data: created, error: createError } = await admin
      .from("assistant_monitors")
      .insert({
        project_id: projectId,
        experiment_id: plan.experiment_id,
        created_by: userData.user.id,
        name: plan.name,
        metric: plan.metric,
        comparator: plan.comparator,
        threshold: plan.threshold,
        window_minutes: Math.round(plan.window_minutes),
        pairing_names: plan.pairing_names,
        check_every_minutes: Math.round(plan.check_every_minutes),
        cooldown_minutes: Math.round(plan.cooldown_minutes),
        review_token_hash: reviewToken,
        status: "active",
        confirmed_at: new Date().toISOString(),
      })
      .select(
        "id,name,status,metric,comparator,threshold,window_minutes,pairing_names,check_every_minutes,created_at",
      )
      .single();
    if (createError?.code === "23505") {
      const { data: existing } = await admin
        .from("assistant_monitors")
        .select(
          "id,name,status,metric,comparator,threshold,window_minutes,pairing_names,check_every_minutes,created_at",
        )
        .eq("project_id", projectId)
        .eq("created_by", userData.user.id)
        .eq("review_token_hash", reviewToken)
        .maybeSingle();
      if (existing) {
        await linkOperationResource(admin, {
          operationId: monitorOperation.id,
          projectId,
          resourceType: "monitor",
          resourceId: existing.id,
        });
        await markOperationCompleted(admin, {
          operationId: monitorOperation.id,
          projectId,
          summary: `Monitor ${existing.name} is active.`,
          evidence: { monitor_id: existing.id },
        });
        return response({
          operation_id: monitorOperation.id,
          monitor: existing,
        }, 200, origin);
      }
    }
    if (createError || !created) {
      await markOperationFailed(admin, {
        operationId: monitorOperation.id,
        projectId,
        errorCode: "monitor_create_failed",
        errorMessage: "The approved monitor could not be saved.",
      });
      return response({ error: "The approved monitor could not be saved." }, 500, origin);
    }
    await linkOperationResource(admin, {
      operationId: monitorOperation.id,
      projectId,
      resourceType: "monitor",
      resourceId: created.id,
    });
    await markOperationCompleted(admin, {
      operationId: monitorOperation.id,
      projectId,
      summary: `Monitor ${created.name} was created.`,
      evidence: { monitor_id: created.id },
    });
    return response({
      operation_id: monitorOperation.id,
      monitor: created,
    }, 200, origin);
  }

  if (
    action === "preflight" ||
    action === "launch" ||
    action === "edit_preflight" ||
    action === "edit_apply"
  ) {
    const editing = action === "edit_preflight" || action === "edit_apply";
    const requestedExperimentId = clean(body.experiment_id, 80);
    const expectedRevisionId = clean(body.expected_revision_id, 80);
    let existingExperiment: {
      id: string;
      slug: string;
      current_revision_id: string | null;
      status: string;
    } | null = null;
    if (editing) {
      if (!isUuid(requestedExperimentId) || !isUuid(expectedRevisionId)) {
        return response({ error: "A current experiment revision is required for editing." }, 400, origin);
      }
      const { data: experimentRecord, error: experimentError } = await admin
        .from("experiments")
        .select("id,slug,current_revision_id,status")
        .eq("project_id", projectId)
        .eq("id", requestedExperimentId)
        .maybeSingle();
      if (experimentError) {
        return response({ error: "The experiment could not be loaded." }, 500, origin);
      }
      if (
        !experimentRecord ||
        experimentRecord.current_revision_id !== expectedRevisionId ||
        !["published_sensing", "active", "activation_failed"].includes(experimentRecord.status)
      ) {
        return response({
          error: "This experiment changed or is not currently editable. Reload it before continuing.",
        }, 409, origin);
      }
      existingExperiment = experimentRecord;
    }

    const compiled = compileControlPlan(body.draft, inventory);
    const { draft, messages, plan } = compiled;
    const preflightMessages = [
      ...messages,
      ...validatePracticeDraft(draft.name, draft, inventory),
    ];
    if (preflightMessages.length) {
      return response({
        error: "Review the draft.",
        validation_messages: preflightMessages,
      }, 400, origin);
    }
    if (!plan) {
      return response({ error: "Controller plan could not be compiled." }, 500, origin);
    }

    const expectedInventory = clean(body.inventory_updated_at, 80);
    if (!expectedInventory || expectedInventory !== configState.updated_at) {
      return response({ error: "The pot inventory changed. Review the experiment again." }, 409, origin);
    }

    if (action === "preflight" || action === "edit_preflight") {
      return response({
        draft,
        plan,
        inventory_updated_at: configState.updated_at,
        config_hash: configState.config_hash,
        validation_messages: [],
        experiment_id: existingExperiment?.id ?? null,
        expected_revision_id: existingExperiment?.current_revision_id ?? null,
      }, 200, origin);
    }

    if (body.confirm !== true) {
      return response({ error: "Review and confirm the controller changes." }, 400, origin);
    }
    const reviewedConfigHash = clean(body.reviewed_config_hash, 128);
    if (!reviewedConfigHash || reviewedConfigHash !== configState.config_hash) {
      return response({ error: "Controller settings changed. Review the experiment again." }, 409, origin);
    }
    if (draft.questions.length) {
      return response({
        error: "Resolve the open questions before starting.",
        validation_messages: draft.questions,
      }, 400, origin);
    }

    const source = body.source === "natural_language" ? "natural_language" : "manual";
    const sensingSpec = {
      ...draft,
      mode: draft.mode === "calibration" ? "calibration" : "observation",
      watering_requested: false,
    };
    let launchOperation;
    try {
      const launchFingerprint = await sha256(JSON.stringify({
        draft,
        reviewedConfigHash,
        expectedInventory,
        experimentId: existingExperiment?.id ?? null,
        expectedRevisionId: existingExperiment?.current_revision_id ?? null,
      }));
      launchOperation = await ensureApprovedOperation(admin, {
        projectId,
        userId: userData.user.id,
        capabilityId: editing ? "experiment.edit" : "experiment.create",
        idempotencyKey: `${editing ? "experiment-edit" : "experiment-launch"}:${launchFingerprint}`,
        intent: editing
          ? `Edit experiment ${draft.name} from the reviewed specification.`
          : `Create experiment ${draft.name} from the reviewed specification.`,
        specification: {
          draft,
          control_plan: plan,
          expected_inventory_updated_at: expectedInventory,
          reviewed_config_hash: reviewedConfigHash,
        },
        verificationRequired: false,
        metadata: {
          source,
          prompt_fingerprint: clean(body.prompt_fingerprint, 128) || null,
        },
      });
    } catch {
      return response({ error: "The approved experiment could not be recorded." }, 500, origin);
    }
    let experimentId = existingExperiment?.id ?? "";
    let experimentSlug = existingExperiment?.slug ?? "";
    let planId: string | null = null;
    let batchId: string | null = null;

    if (editing) {
      const { data: revised, error: reviseError } = await admin.rpc(
        "revise_and_attach_experiment",
        {
          requested_experiment_id: experimentId,
          requested_actor_id: userData.user.id,
          expected_revision_id: expectedRevisionId,
          reviewed_spec: draft,
          compiled_plan: plan,
          expected_inventory_updated_at: expectedInventory,
          expected_config_hash: reviewedConfigHash,
          revision_source: source,
          revision_model_name: source === "natural_language" ? clean(body.model, 120) || model : null,
          revision_prompt_fingerprint: source === "natural_language"
            ? clean(body.prompt_fingerprint, 128) || null
            : null,
        },
      );
      if (reviseError) {
        await markOperationFailed(admin, {
          operationId: launchOperation.id,
          projectId,
          errorCode: "experiment_edit_failed",
          errorMessage: reviseError.message,
        });
        return response({ error: reviseError.message }, 409, origin);
      }
      const revisedResult = Array.isArray(revised) ? revised[0] : revised;
      experimentId = clean(revisedResult?.experiment_id, 80);
      experimentSlug = clean(revisedResult?.experiment_slug, 80);
      planId = clean(revisedResult?.plan_id, 80) || null;
      batchId = clean(revisedResult?.batch_id, 80) || null;
    } else {
      const { data: published, error: publishError } = await authClient.rpc(
        "publish_sensing_experiment",
        {
          requested_project_id: projectId,
          reviewed_spec: sensingSpec,
          expected_inventory_updated_at: expectedInventory,
          draft_source: source,
          draft_model_name: source === "natural_language" ? clean(body.model, 120) || model : null,
          draft_prompt_fingerprint: source === "natural_language"
            ? clean(body.prompt_fingerprint, 128) || null
            : null,
        },
      );
      if (publishError) {
        await markOperationFailed(admin, {
          operationId: launchOperation.id,
          projectId,
          errorCode: "experiment_publish_failed",
          errorMessage: publishError.message,
        });
        return response({ error: publishError.message }, 400, origin);
      }
      const publishedResult = Array.isArray(published) ? published[0] : published;
      experimentId = clean(publishedResult?.experiment_id, 80);
      experimentSlug = clean(publishedResult?.experiment_slug, 80);
    }
    await linkOperationResource(admin, {
      operationId: launchOperation.id,
      projectId,
      resourceType: "experiment",
      resourceId: experimentId,
    });

    if (!editing) {
      const { data: attached, error: attachError } = await admin.rpc(
        "attach_experiment_control_plan",
        {
          requested_experiment_id: experimentId,
          requested_actor_id: userData.user.id,
          reviewed_spec: draft,
          compiled_plan: plan,
          expected_inventory_updated_at: expectedInventory,
          expected_config_hash: reviewedConfigHash,
        },
      );
      if (attachError) {
        await markOperationFailed(admin, {
          operationId: launchOperation.id,
          projectId,
          errorCode: "control_plan_attach_failed",
          errorMessage: attachError.message,
        });
        return response({
          error: `Experiment was saved with watering off. ${attachError.message}`,
          experiment_id: experimentId,
          experiment_slug: experimentSlug,
        }, 409, origin);
      }
      const attachedResult = Array.isArray(attached) ? attached[0] : attached;
      planId = clean(attachedResult?.plan_id, 80) || null;
      batchId = clean(attachedResult?.batch_id, 80) || null;
    }
    if (planId) {
      await linkOperationResource(admin, {
        operationId: launchOperation.id,
        projectId,
        resourceType: "control_plan",
        resourceId: planId,
      });
    }
    const commandIds: string[] = [];
    let dependsOnCommandId: string | null = null;

    for (const command of plan.commands) {
      const commandResponse = await fetch(`${supabaseUrl}/functions/v1/create-control-command`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${jwt}`,
          apikey: anonKey,
          "content-type": "application/json",
          origin: origin && allowedOrigins.has(origin) ? origin : "https://exacth2o.com",
        },
        body: JSON.stringify({
          project_id: projectId,
          device_id: configState.device_id,
          client_request_id: command.client_request_id,
          command_type: command.command_type,
          payload: command.payload,
          confirm: command.confirm,
          depends_on_command_id: dependsOnCommandId,
          batch_id: batchId,
          experiment_id: experimentId,
          operation_id: launchOperation.id,
          operation_intent: `${editing ? "Apply edits to" : "Activate"} experiment ${draft.name} from the reviewed specification.`,
        }),
      });
      const commandBody = record(await commandResponse.json().catch(() => ({})));
      const commandRecord = record(commandBody.command);
      const commandId = clean(commandRecord.id, 80);
      if (!commandResponse.ok || !commandId) {
        const enqueueError = clean(commandBody.error, 300) ||
          `Controller command could not be queued (${commandResponse.status}).`;
        if (planId) {
          await admin.rpc("mark_experiment_activation_enqueue_failed", {
            requested_plan_id: planId,
            failure_message: enqueueError,
          });
        }
        await markOperationFailed(admin, {
          operationId: launchOperation.id,
          projectId,
          errorCode: "controller_enqueue_failed",
          errorMessage: enqueueError,
        });
        return response({
          error: `Experiment was ${editing ? "updated" : "created"} but remains safely paused. ${enqueueError}`,
          experiment_id: experimentId,
          experiment_slug: experimentSlug,
        }, 409, origin);
      }
      commandIds.push(commandId);
      dependsOnCommandId = commandId;
    }

    if (!plan.commands.length) {
      await markOperationCompleted(admin, {
        operationId: launchOperation.id,
        projectId,
        summary: editing
          ? `${draft.name} was updated without controller changes.`
          : `${draft.name} was created as a sensing experiment.`,
        evidence: { experiment_id: experimentId, plan_id: planId },
      });
    }
    return response({
      operation_id: launchOperation.id,
      experiment_id: experimentId,
      experiment_slug: experimentSlug,
      plan_id: planId,
      batch_id: batchId,
      command_ids: commandIds,
      status: plan.commands.length ? "activating" : "active",
    }, 200, origin);
  }

  const prompt = clean(body.prompt, promptLimit);
  if (!prompt) {
    return response({
      error: action === "route"
        ? "Describe what you want ExactH2O to do."
        : action === "assistant_chat"
        ? "Ask ExactH2O a question or describe what you want to do."
        : action === "schedule_draft"
        ? "Describe the future or recurring change."
        : action === "monitor_draft"
        ? "Describe what ExactH2O should monitor."
        : action.startsWith("settings_")
        ? "Describe the setting change."
        : "Describe the experiment.",
    }, 400, origin);
  }

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  let countQuery = admin
    .from("experiment_builder_requests")
    .select("id", { count: "exact", head: true })
    .eq("project_id", projectId)
    .eq("user_id", userData.user.id)
    .gte("created_at", since);
  countQuery = action === "assistant_chat"
    ? countQuery.like("model_name", "assistant_chat:%")
    : countQuery.not("model_name", "like", "assistant_chat:%");
  const { count, error: countError } = await countQuery;
  if (countError) return response({ error: "Could not check the request limit." }, 500, origin);
  const requestLimit = action === "assistant_chat"
    ? chatRequestLimitPerDay
    : draftRequestLimitPerDay;
  if ((count ?? 0) >= requestLimit) {
    return response({
      error: action === "assistant_chat"
        ? "Daily assistant limit reached. Try again tomorrow."
        : "Daily draft limit reached. Enter the experiment manually.",
    }, 429, origin);
  }

  const promptFingerprint = await sha256(prompt);
  const { data: requestRow, error: requestError } = await admin
    .from("experiment_builder_requests")
    .insert({
      project_id: projectId,
      user_id: userData.user.id,
      source: "natural_language",
      status: "started",
      model_name: action === "assistant_chat" ? `assistant_chat:${model}` : model,
      prompt_fingerprint: promptFingerprint,
    })
    .select("id")
    .single();
  if (requestError) {
    return response({ error: "Could not start the experiment draft." }, 500, origin);
  }

  try {
    const routeAction = action === "route";
    const chatAction = action === "assistant_chat";
    const settingsAction = action === "settings_draft" || action === "settings_revise";
    const scheduleAction = action === "schedule_draft";
    const monitorAction = action === "monitor_draft";

    if (chatAction) {
      let threadId = clean(body.thread_id, 80);
      let thread: Record<string, unknown> | null = null;
      if (isUuid(threadId)) {
        const { data } = await admin
          .from("assistant_threads")
          .select("id,title,status")
          .eq("id", threadId)
          .eq("project_id", projectId)
          .eq("user_id", userData.user.id)
          .eq("status", "active")
          .maybeSingle();
        thread = data;
      }
      if (!thread) {
        const { data, error: threadError } = await admin
          .from("assistant_threads")
          .insert({
            project_id: projectId,
            user_id: userData.user.id,
            title: prompt.slice(0, 160),
            status: "active",
          })
          .select("id,title,status")
          .single();
        if (threadError || !data) {
          throw new Error("The assistant conversation could not be saved.");
        }
        thread = data;
        threadId = clean(data.id, 80);
      }
      const { data: persistedMessages, error: historyError } = await admin
        .from("assistant_messages")
        .select("role,content,created_at")
        .eq("thread_id", threadId)
        .eq("project_id", projectId)
        .eq("user_id", userData.user.id)
        .order("created_at", { ascending: false })
        .limit(12);
      if (historyError) throw new Error("The assistant conversation is unavailable.");
      const conversation = normalizeAssistantConversation(
        (persistedMessages ?? []).slice().reverse(),
      );
      const { error: userMessageError } = await admin
        .from("assistant_messages")
        .insert({
          thread_id: threadId,
          project_id: projectId,
          user_id: userData.user.id,
          request_id: requestRow.id,
          role: "user",
          content: prompt,
          workflow: "answer",
          metadata: { prompt_fingerprint: promptFingerprint },
        });
      if (userMessageError) throw new Error("The assistant request could not be saved.");
      const input: unknown[] = [
        {
          role: "system",
          content: assistantChatInstructions(access.role),
        },
        ...conversation,
        {
          role: "user",
          content: prompt,
        },
      ];
      const proposalState: {
        value: { workflow: string; workflow_prompt: string } | null;
      } = { value: null };
      let reply = "";
      let inputTokens = 0;
      let outputTokens = 0;
      const toolEvidence: Array<{
        tool: string;
        result: Record<string, unknown>;
      }> = [];

      const loadCatalog = async () => {
        const { data: catalog, error: catalogError } = await authClient
          .from("portal_experiment_catalog")
          .select(
            "id,slug,name,description,mode,status,watering_state,started_at,ended_at,pairing_names,assignments",
          )
          .eq("project_id", projectId)
          .order("started_at", { ascending: true });
        if (catalogError) throw new Error("Experiment catalog is unavailable.");
        return catalog ?? [];
      };

      const loadRuntime = async () => {
        const { data: runtime, error: runtimeError } = await authClient
          .from("device_runtime_state")
          .select(
            "device_name,controller_state,controller_state_updated_at,state_observed_at,state_fresh_until,owner_checked_at,overall_status,api_status,pi_online,public_url_reachable,watering_enabled,watering_disabled,watering_last_event,watering_last_event_at,watering_events_last_24h,scheduler_jobs_loaded,sensors_expected,sensors_current,sensors_stale,sensors_missing,last_sensor_reading_at,updated_at",
          )
          .eq("project_id", projectId)
          .order("updated_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (runtimeError) throw new Error("Controller state is unavailable.");
        return runtime;
      };

      const executeAssistantTool = async (
        call: { name: string; arguments: Record<string, unknown> },
      ) => {
        if (
          call.name === "prepare_experiment_specification" ||
          call.name === "prepare_settings_plan" ||
          call.name === "prepare_experiment_archive" ||
          call.name === "prepare_schedule" ||
          call.name === "prepare_monitor" ||
          call.name === "prepare_experiment_lifecycle"
        ) {
          const nextProposal = proposalFromFunctionCall(call);
          if (nextProposal && !proposalState.value) proposalState.value = nextProposal;
          return {
            prepared: Boolean(nextProposal),
            workflow: nextProposal?.workflow ?? null,
            safety: "No experiment or controller change has been executed.",
          };
        }

        if (call.name === "get_capabilities") {
          return {
            observed_at: new Date().toISOString(),
            capabilities: assistantCapabilities,
            execution_model:
              "Read actions may answer immediately. Write actions open a separate reviewed plan. Hardware changes remain policy-gated.",
          };
        }

        if (call.name === "get_project_overview") {
          const [catalog, runtime] = await Promise.all([loadCatalog(), loadRuntime()]);
          return {
            observed_at: runtime?.state_observed_at ?? configState.updated_at,
            controller: runtime ?? {
              status: "Runtime state is unavailable.",
              config_observed_at: configState.updated_at,
            },
            inventory: {
              configured_pairings: inventory.length,
              watering_enabled_pairings: inventory.filter((item: {
                wtc_percent_limit: number;
              }) =>
                item.wtc_percent_limit > -1_000
              ).length,
              sensing_only_pairings: inventory.filter((item: {
                wtc_percent_limit: number;
              }) =>
                item.wtc_percent_limit <= -1_000
              ).length,
              pots: inventory.map((item: {
                name: string;
                zone: number;
                pot_number: number;
                group_name: string | null;
                calibration_name: string | null;
                wtc_percent_limit: number;
                valve_open_time_ms: number;
                measurement_interval_ms: number;
              }) => ({
                pairing_name: item.name,
                zone: item.zone,
                pot_number: item.pot_number,
                group: item.group_name,
                calibration: item.calibration_name,
                watering_enabled: item.wtc_percent_limit > -1_000,
                target_vwc_percent: item.wtc_percent_limit > -1_000
                  ? item.wtc_percent_limit
                  : null,
                valve_open_seconds: item.valve_open_time_ms / 1_000,
                measurement_interval_minutes: item.measurement_interval_ms / 60_000,
              })),
            },
            experiments: catalog.map((item) => ({
              name: item.name,
              slug: item.slug,
              mode: item.mode,
              status: item.status,
              watering_state: item.watering_state,
              pot_count: Array.isArray(item.pairing_names) ? item.pairing_names.length : 0,
              started_at: item.started_at,
              ended_at: item.ended_at,
            })),
          };
        }

        if (call.name === "get_system_health") {
          const [runtimeResult, healthResult] = await Promise.all([
            loadRuntime(),
            authClient
              .from("device_health_snapshots")
              .select(
                "captured_at,owner_checked_at,overall_status,api_status,pi_online,public_url_reachable,ethernet_link,gateway_ping_ms,undervoltage,cpu_temp_c,uptime_seconds,sensors_expected,sensors_current,sensors_stale,sensors_missing,missing_sensors,stale_sensors,last_sensor_reading_at,watering_last_event,watering_last_event_at,watering_events_last_24h,scheduler_jobs_loaded,active_alerts,known_issues,ingest_complete,created_at",
              )
              .eq("project_id", projectId)
              .order("captured_at", { ascending: false })
              .limit(1)
              .maybeSingle(),
          ]);
          if (healthResult.error) {
            console.error("assistant_health_read_failed", {
              request_id: requestRow.id,
              code: healthResult.error.code,
            });
          }
          return {
            observed_at: healthResult.data?.captured_at ??
              runtimeResult?.state_observed_at ??
              configState.updated_at,
            runtime: runtimeResult,
            health: healthResult.error ? null : healthResult.data,
            health_snapshot_available: !healthResult.error && Boolean(healthResult.data),
          };
        }

        if (call.name === "get_recent_activity") {
          const hoursValue = Number(call.arguments.hours);
          const hours = Number.isFinite(hoursValue)
            ? Math.min(168, Math.max(1, hoursValue))
            : 24;
          const since = new Date(Date.now() - hours * 60 * 60 * 1_000).toISOString();
          const [operationResult, commandResult] = await Promise.all([
            authClient
              .from("portal_operation_timeline")
              .select(
                "id,capability_id,intent,approval_state,execution_state,verification_state,correlation_id,created_at,updated_at,completed_at,events",
              )
              .eq("project_id", projectId)
              .gte("created_at", since)
              .order("created_at", { ascending: false })
              .limit(100),
            authClient
              .from("project_control_commands")
              .select(
                "id,experiment_id,command_type,status,requested_at,started_at,completed_at,error,result",
              )
              .eq("project_id", projectId)
              .gte("requested_at", since)
              .order("requested_at", { ascending: false })
              .limit(100),
          ]);
          if (operationResult.error || commandResult.error) {
            console.error("assistant_activity_read_failed", {
              request_id: requestRow.id,
              operation_code: operationResult.error?.code,
              command_code: commandResult.error?.code,
            });
          }
          const catalog = await loadCatalog();
          const experimentNameById = new Map(
            catalog.map((item) => [String(item.id), item.name]),
          );
          return {
            observed_at: new Date().toISOString(),
            hours,
            activity_available: !operationResult.error || !commandResult.error,
            operations_available: !operationResult.error,
            operations: operationResult.data ?? [],
            commands_available: !commandResult.error,
            commands: (commandResult.data ?? []).map((item) => ({
              command_type: item.command_type,
              status: item.status,
              experiment: item.experiment_id
                ? experimentNameById.get(String(item.experiment_id)) ?? null
                : null,
              requested_at: item.requested_at,
              started_at: item.started_at,
              completed_at: item.completed_at,
              error: item.error,
              result: item.result,
            })),
          };
        }

        if (call.name === "get_calibration_status") {
          const [studyResult, observationResult, candidateResult, setRequestResult] =
            await Promise.all([
              authClient
                .from("calibration_studies")
                .select(
                  "id,experiment_id,name,pairing_name,reference_instrument,match_tolerance_seconds,status,created_at,updated_at",
                )
                .eq("project_id", projectId)
                .order("updated_at", { ascending: false })
                .limit(100),
              authClient
                .from("calibration_observations")
                .select("study_id,match_status,included,reference_recorded_at")
                .eq("project_id", projectId)
                .order("reference_recorded_at", { ascending: false })
                .limit(2_000),
              authClient
                .from("calibration_candidates")
                .select(
                  "id,study_id,version,fit_type,equation_text,sample_count,rmse,mae,r_squared,max_error,status,created_at",
                )
                .eq("project_id", projectId)
                .order("created_at", { ascending: false })
                .limit(200),
              authClient
                .from("calibration_set_requests")
                .select(
                  "study_id,candidate_id,pairing_names,status,requested_at,reviewed_at,notes",
                )
                .eq("project_id", projectId)
                .order("requested_at", { ascending: false })
                .limit(200),
            ]);
          const errors = [
            studyResult.error,
            observationResult.error,
            candidateResult.error,
            setRequestResult.error,
          ].filter(Boolean);
          if (errors.length) {
            console.error("assistant_calibration_read_failed", {
              request_id: requestRow.id,
              codes: errors.map((error) => error?.code),
            });
          }
          const observations = observationResult.data ?? [];
          return {
            observed_at: new Date().toISOString(),
            calibration_data_complete: errors.length === 0,
            unavailable_sections: [
              studyResult.error ? "studies" : null,
              observationResult.error ? "observations" : null,
              candidateResult.error ? "candidates" : null,
              setRequestResult.error ? "set requests" : null,
            ].filter(Boolean),
            studies: (studyResult.data ?? []).map((study) => {
              const studyObservations = observations.filter((item) =>
                item.study_id === study.id
              );
              return {
                ...study,
                observation_count: studyObservations.length,
                matched_observation_count: studyObservations.filter((item) =>
                  item.match_status === "matched"
                ).length,
                included_observation_count: studyObservations.filter((item) =>
                  item.match_status === "matched" && item.included
                ).length,
              };
            }),
            candidates: candidateResult.data ?? [],
            set_requests: setRequestResult.data ?? [],
          };
        }

        if (call.name === "get_automation_status") {
          const [scheduleResult, monitorResult, eventResult] = await Promise.all([
            authClient
              .from("assistant_schedules")
              .select(
                "id,name,status,next_run_at,last_run_at,last_error,recurrence,timezone,created_at,updated_at",
              )
              .eq("project_id", projectId)
              .order("created_at", { ascending: false })
              .limit(100),
            authClient
              .from("assistant_monitors")
              .select(
                "id,experiment_id,name,metric,comparator,threshold,window_minutes,pairing_names,status,last_state,last_evaluated_at,last_triggered_at,created_at",
              )
              .eq("project_id", projectId)
              .order("created_at", { ascending: false })
              .limit(100),
            authClient
              .from("assistant_monitor_events")
              .select(
                "monitor_id,state,summary,evidence,observed_at,acknowledged_at,created_at",
              )
              .eq("project_id", projectId)
              .order("created_at", { ascending: false })
              .limit(100),
          ]);
          const errors = [
            scheduleResult.error,
            monitorResult.error,
            eventResult.error,
          ].filter(Boolean);
          if (errors.length) {
            console.error("assistant_automation_read_failed", {
              request_id: requestRow.id,
              codes: errors.map((error) => error?.code),
            });
          }
          return {
            observed_at: new Date().toISOString(),
            data_complete: errors.length === 0,
            schedules: scheduleResult.data ?? [],
            monitors: monitorResult.data ?? [],
            recent_alerts: eventResult.data ?? [],
          };
        }

        if (call.name === "get_delivery_evidence") {
          const hoursValue = Number(call.arguments.hours);
          const hours = Number.isFinite(hoursValue)
            ? Math.min(168, Math.max(1, hoursValue))
            : 24;
          const since = new Date(Date.now() - hours * 60 * 60 * 1_000).toISOString();
          const requestedExperiment = clean(call.arguments.experiment, 160);
          let pairingNames: string[] | null = null;
          let experimentName: string | null = null;
          if (requestedExperiment) {
            const catalog = await loadCatalog();
            const experiment = resolveExperimentCatalog(catalog, requestedExperiment);
            if (!experiment) {
              return {
                error: "Experiment not found.",
                available_experiments: catalog.map((item) => item.name),
              };
            }
            experimentName = clean(experiment.name, 160);
            pairingNames = Array.isArray(experiment.pairing_names)
              ? experiment.pairing_names
                .map((item: unknown) => clean(item, 120))
                .filter(Boolean)
              : [];
          }

          let evidenceQuery = authClient
            .from("delivery_evidence")
            .select(
              "operation_id,command_id,valve_event_id,pairing_name,evidence_type,source_id,observed_at,value,unit,expected_value,tolerance,verification_result,created_at",
            )
            .eq("project_id", projectId)
            .gte("observed_at", since)
            .order("observed_at", { ascending: false })
            .limit(1_000);
          if (pairingNames) {
            if (!pairingNames.length) {
              return {
                observed_at: new Date().toISOString(),
                hours,
                experiment: experimentName,
                physical_evidence_available: false,
                evidence: [],
                evidence_note: "This experiment has no assigned pairings.",
              };
            }
            evidenceQuery = evidenceQuery.in("pairing_name", pairingNames);
          }
          const evidenceResult = await evidenceQuery;
          if (evidenceResult.error) {
            console.error("assistant_delivery_evidence_read_failed", {
              request_id: requestRow.id,
              code: evidenceResult.error.code,
            });
          }
          const evidence = evidenceResult.data ?? [];
          return {
            observed_at: new Date().toISOString(),
            hours,
            since,
            experiment: experimentName,
            physical_evidence_available: !evidenceResult.error && evidence.length > 0,
            data_available: !evidenceResult.error,
            evidence,
            evidence_note: evidenceResult.error
              ? "Physical-delivery evidence could not be read."
              : evidence.length
                ? "These records are independent physical or simulator evidence."
                : "No independent physical-delivery evidence was recorded. This does not prove delivery failed.",
          };
        }

        if (call.name === "compare_experiments") {
          const requestedExperiments = Array.isArray(call.arguments.experiments)
            ? call.arguments.experiments
              .map((item) => clean(item, 160))
              .filter(Boolean)
              .slice(0, 6)
            : [];
          const hoursValue = Number(call.arguments.hours);
          const hours = Number.isFinite(hoursValue)
            ? Math.min(168, Math.max(1, hoursValue))
            : 24;
          const catalog = await loadCatalog();
          const resolved = requestedExperiments
            .map((name) => resolveExperimentCatalog(catalog, name))
            .filter(Boolean);
          const unique = new Map(
            resolved.map((item) => [String(item.id), item]),
          );
          if (unique.size < 2) {
            return {
              error: "Choose at least two exact current experiments.",
              available_experiments: catalog.map((item) => item.name),
            };
          }
          const since = new Date(Date.now() - hours * 60 * 60 * 1_000).toISOString();
          const evidence = [];
          for (const experiment of unique.values()) {
            const pairingNames = Array.isArray(experiment.pairing_names)
              ? experiment.pairing_names.map((item: unknown) => clean(item, 120)).filter(Boolean)
              : [];
            const [readingResult, eventResult] = await Promise.all([
              authClient
                .from("sensor_readings")
                .select(
                  "event_id,pairing_name,calibrated_value,device_recorded_at,server_received_at",
                )
                .eq("project_id", projectId)
                .in("pairing_name", pairingNames)
                .gte("device_recorded_at", since)
                .order("device_recorded_at", { ascending: false })
                .limit(5_000),
              authClient
                .from("valve_events")
                .select(
                  "event_id,pairing_name,action,duration_ms,device_recorded_at,server_received_at",
                )
                .eq("project_id", projectId)
                .in("pairing_name", pairingNames)
                .gte("device_recorded_at", since)
                .order("device_recorded_at", { ascending: false })
                .limit(5_000),
            ]);
            evidence.push({
              experiment: experiment.name,
              expected_pots: pairingNames.length,
              readings: readingResult.error
                ? null
                : aggregateExperimentReadings(
                  readingResult.data ?? [],
                  experiment.assignments,
                  inventory,
                ),
              watering: eventResult.error
                ? null
                : aggregateValveEvents(eventResult.data ?? []),
              unavailable_evidence: [
                readingResult.error ? "sensor readings" : null,
                eventResult.error ? "recorded valve events" : null,
              ].filter(Boolean),
            });
          }
          return {
            observed_at: new Date().toISOString(),
            hours,
            since,
            comparison: compareExperimentAggregates(evidence),
            evidence,
          };
        }

        if (call.name === "get_experiment_status") {
          const catalog = await loadCatalog();
          const experiment = resolveExperimentCatalog(
            catalog,
            clean(call.arguments.experiment, 160),
          );
          if (!experiment) {
            return {
              error: "Experiment not found.",
              available_experiments: catalog.map((item) => item.name),
            };
          }
          const pairingNames = Array.isArray(experiment.pairing_names)
            ? experiment.pairing_names
              .map((item: unknown) => clean(item, 120))
              .filter(Boolean)
            : [];
          const hoursValue = Number(call.arguments.hours);
          const hours = Number.isFinite(hoursValue)
            ? Math.min(168, Math.max(1, hoursValue))
            : 24;
          const since = new Date(Date.now() - hours * 60 * 60 * 1_000).toISOString();
          if (!pairingNames.length) {
            return {
              experiment: {
                name: experiment.name,
                slug: experiment.slug,
                status: experiment.status,
              },
              error: "This experiment has no assigned pairings.",
            };
          }
          const [readingResult, eventResult, runtime] = await Promise.all([
            authClient
              .from("sensor_readings")
              .select(
                "event_id,pairing_name,calibrated_value,device_recorded_at,server_received_at",
              )
              .eq("project_id", projectId)
              .in("pairing_name", pairingNames)
              .gte("device_recorded_at", since)
              .order("device_recorded_at", { ascending: false })
              .limit(5_000),
            authClient
              .from("valve_events")
              .select(
                "event_id,pairing_name,action,duration_ms,device_recorded_at,server_received_at",
              )
              .eq("project_id", projectId)
              .in("pairing_name", pairingNames)
              .gte("device_recorded_at", since)
              .order("device_recorded_at", { ascending: false })
              .limit(5_000),
            loadRuntime(),
          ]);
          if (readingResult.error) {
            console.error("assistant_experiment_readings_failed", {
              request_id: requestRow.id,
              code: readingResult.error.code,
            });
          }
          if (eventResult.error) {
            console.error("assistant_experiment_events_failed", {
              request_id: requestRow.id,
              code: eventResult.error.code,
            });
          }
          return {
            experiment: {
              name: experiment.name,
              slug: experiment.slug,
              description: experiment.description,
              mode: experiment.mode,
              status: experiment.status,
              watering_state: experiment.watering_state,
              started_at: experiment.started_at,
              ended_at: experiment.ended_at,
              expected_pots: pairingNames.length,
            },
            window: {
              hours,
              since,
              reading_limit_reached: (readingResult.data?.length ?? 0) === 5_000,
              event_limit_reached: (eventResult.data?.length ?? 0) === 5_000,
            },
            controller_observed_at: runtime?.state_observed_at ?? null,
            readings_available: !readingResult.error,
            water_events_available: !eventResult.error,
            unavailable_evidence: [
              readingResult.error ? "sensor readings" : null,
              eventResult.error ? "recorded valve events" : null,
            ].filter(Boolean),
            readings: readingResult.error
              ? null
              : aggregateExperimentReadings(
                readingResult.data ?? [],
                experiment.assignments,
                inventory,
              ),
            watering: eventResult.error
              ? null
              : aggregateValveEvents(eventResult.data ?? []),
          };
        }

        return { error: "Unsupported assistant tool." };
      };

      for (let turn = 0; turn < 5; turn += 1) {
        const openAiResponse = await fetch("https://api.openai.com/v1/responses", {
          method: "POST",
          headers: {
            authorization: `Bearer ${openAiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model,
            store: false,
            reasoning: { effort: reasoningEffort },
            input,
            tools: assistantTools,
            tool_choice: "auto",
            parallel_tool_calls: false,
            max_output_tokens: 1_600,
          }),
        });
        const openAiBody = await openAiResponse.json().catch(() => ({}));
        if (!openAiResponse.ok) {
          throw new Error(
            clean(record(openAiBody.error).message, 300) ||
              `OpenAI request failed (${openAiResponse.status}).`,
          );
        }
        const usage = openAiUsage(openAiBody.usage);
        inputTokens += usage.input_tokens ?? 0;
        outputTokens += usage.output_tokens ?? 0;
        const calls = assistantFunctionCalls(openAiBody);
        if (!calls.length) {
          reply = clean(responseOutputText(openAiBody), 8_000);
          break;
        }
        const output = Array.isArray(record(openAiBody).output)
          ? record(openAiBody).output as unknown[]
          : [];
        input.push(...output);
        for (const call of calls) {
          const result = await executeAssistantTool(call);
          toolEvidence.push({
            tool: call.name,
            result: record(result),
          });
          input.push({
            type: "function_call_output",
            call_id: call.call_id,
            output: JSON.stringify(result),
          });
        }
      }

      if (!reply) throw new Error("Assistant did not return an answer.");
      const workflow = proposalState.value?.workflow ?? "answer";
      const evidence = assistantArtifactsFromToolEvidence(toolEvidence);
      const { error: assistantMessageError } = await admin
        .from("assistant_messages")
        .insert({
          thread_id: threadId,
          project_id: projectId,
          user_id: userData.user.id,
          request_id: requestRow.id,
          role: "assistant",
          content: reply,
          workflow,
          metadata: {
            workflow_prompt: proposalState.value?.workflow_prompt ?? null,
            model,
            evidence,
          },
        });
      if (assistantMessageError) {
        throw new Error("The assistant answer could not be saved.");
      }
      await admin
        .from("assistant_threads")
        .update({ updated_at: new Date().toISOString() })
        .eq("id", threadId)
        .eq("project_id", projectId)
        .eq("user_id", userData.user.id);
      await admin
        .from("experiment_builder_requests")
        .update({
          status: "completed",
          input_tokens: inputTokens || null,
          output_tokens: outputTokens || null,
        })
        .eq("id", requestRow.id);
      return response({
        reply,
        workflow,
        workflow_prompt: proposalState.value?.workflow_prompt ?? null,
        thread_id: threadId,
        request_id: requestRow.id,
        evidence,
        model,
        prompt_fingerprint: promptFingerprint,
      }, 200, origin);
    }

    const openAiResponse = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        authorization: `Bearer ${openAiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        store: false,
        reasoning: { effort: reasoningEffort },
        input: [
          {
            role: "system",
            content: routeAction
              ? assistantIntentInstructions()
              : settingsAction
                ? settingsSystemInstructions(access.role)
                : scheduleAction
                  ? scheduleSystemInstructions(
                    access.role,
                    new Date().toISOString(),
                    clean(body.timezone, 80) || "UTC",
                  )
                  : monitorAction
                    ? monitorSystemInstructions()
                : systemInstructions(),
          },
          {
            role: "user",
            content: routeAction
              ? assistantIntentInput(prompt)
              : settingsAction
                ? settingsUserInput(
                  prompt,
                  configState,
                  action === "settings_revise" ? body.current_plan : null,
                )
                : scheduleAction
                  ? scheduleUserInput(
                    prompt,
                    configState,
                    clean(body.timezone, 80) || "UTC",
                    body.current_plan,
                  )
                  : monitorAction
                    ? monitorUserInput(
                      prompt,
                      (
                        await authClient
                          .from("portal_experiment_catalog")
                          .select("id,slug,name,status,pairing_names")
                          .eq("project_id", projectId)
                      ).data ?? [],
                      body.current_plan,
                    )
                : userDraftInput(
                  prompt,
                  inventory,
                  action === "revise" ? body.current_draft : null,
                ),
          },
        ],
        text: {
          format: {
            type: "json_schema",
            name: routeAction
              ? "exacth2o_assistant_route"
              : settingsAction
                ? "exacth2o_settings_plan"
                : scheduleAction
                  ? "exacth2o_schedule_plan"
                  : monitorAction
                    ? "exacth2o_monitor_plan"
                : "exacth2o_experiment_draft",
            strict: true,
            schema: routeAction
              ? assistantIntentSchema
              : settingsAction
                ? settingsPlanSchema
                : scheduleAction
                  ? schedulePlanSchema
                  : monitorAction
                    ? monitorPlanSchema
                : experimentDraftSchema,
          },
        },
        max_output_tokens: 2_000,
      }),
    });
    const openAiBody = await openAiResponse.json().catch(() => ({}));
    if (!openAiResponse.ok) {
      throw new Error(
        clean(record(openAiBody.error).message, 300) ||
          `OpenAI request failed (${openAiResponse.status}).`,
      );
    }

    const parsed = JSON.parse(responseOutputText(openAiBody));
    const usage = openAiUsage(openAiBody.usage);
    if (routeAction) {
      const route = normalizeAssistantIntent(parsed);
      await admin
        .from("experiment_builder_requests")
        .update({ status: "completed", ...usage })
        .eq("id", requestRow.id);
      return response({
        ...route,
        model,
        prompt_fingerprint: promptFingerprint,
      }, 200, origin);
    }
    if (settingsAction) {
      const { plan, errors } = normalizeSettingsPlan(parsed, configState, access.role);
      await admin
        .from("experiment_builder_requests")
        .update({ status: errors.length ? "rejected" : "completed", ...usage })
        .eq("id", requestRow.id);
      return response({
        plan,
        inventory_updated_at: configState.updated_at,
        config_hash: configState.config_hash,
        model,
        prompt_fingerprint: promptFingerprint,
        validation_messages: errors,
      }, 200, origin);
    }
    if (scheduleAction) {
      const { plan } = normalizeSchedulePlan(
        parsed,
        configState,
        access.role,
      );
      const reviewToken = await sha256(automationReviewToken(
        "schedule",
        userData.user.id,
        projectId,
        plan,
        configState.config_hash,
      ));
      await admin
        .from("experiment_builder_requests")
        .update({
          status: plan.questions.length ? "rejected" : "completed",
          ...usage,
        })
        .eq("id", requestRow.id);
      return response({
        plan,
        config_hash: configState.config_hash,
        review_token: reviewToken,
        model,
        prompt_fingerprint: promptFingerprint,
        validation_messages: plan.questions,
      }, 200, origin);
    }
    if (monitorAction) {
      const { data: catalog, error: catalogError } = await authClient
        .from("portal_experiment_catalog")
        .select("id,slug,name,status,pairing_names")
        .eq("project_id", projectId);
      if (catalogError) throw new Error("Experiment catalog is unavailable.");
      const { plan } = normalizeMonitorPlan(parsed, catalog ?? []);
      const reviewToken = await sha256(automationReviewToken(
        "monitor",
        userData.user.id,
        projectId,
        plan,
      ));
      await admin
        .from("experiment_builder_requests")
        .update({
          status: plan.questions.length ? "rejected" : "completed",
          ...usage,
        })
        .eq("id", requestRow.id);
      return response({
        plan,
        review_token: reviewToken,
        model,
        prompt_fingerprint: promptFingerprint,
        validation_messages: plan.questions,
      }, 200, origin);
    }

    const { draft, messages } = validateDraft(parsed, inventory);
    const currentDraft = record(body.current_draft);
    const practiceContext = [
      prompt,
      clean(currentDraft.name, 120),
      clean(currentDraft.description, 300),
      draft.name,
      draft.description,
    ].join(" ");
    const practiceMessages = validatePracticeDraft(practiceContext, draft, inventory);
    const reviewedDraft = practiceMessages.length
      ? {
        ...draft,
        questions: [...new Set([...draft.questions, ...practiceMessages])],
      }
      : draft;
    const validationMessages = [...new Set([...messages, ...practiceMessages])];
    await admin
      .from("experiment_builder_requests")
      .update({ status: validationMessages.length ? "rejected" : "completed", ...usage })
      .eq("id", requestRow.id);

    return response({
      draft: reviewedDraft,
      inventory_updated_at: configState.updated_at,
      source: "natural_language",
      model,
      prompt_fingerprint: promptFingerprint,
      validation_messages: validationMessages,
    }, 200, origin);
  } catch (error) {
    await admin
      .from("experiment_builder_requests")
      .update({ status: "failed", error_code: "draft_failed" })
      .eq("id", requestRow.id);
    return response({ error: errorMessage(error) }, 502, origin);
  }
});
