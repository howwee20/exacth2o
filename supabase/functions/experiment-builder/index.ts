import { createClient } from "npm:@supabase/supabase-js@2";
import {
  compileControlPlan,
  experimentDraftSchema,
  inventoryFromDeviceConfig,
  responseOutputText,
  systemInstructions,
  userDraftInput,
  validateDraft,
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
  aggregateExperimentReadings,
  aggregateValveEvents,
  assistantChatInstructions,
  assistantFunctionCalls,
  assistantTools,
  experimentArchiveDecision,
  normalizeAssistantConversation,
  proposalFromFunctionCall,
  resolveExactExperimentCatalog,
  resolveExperimentCatalog,
} from "./assistant-chat-policy.mjs";

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

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function clean(value: unknown, maxLength: number) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(value);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Experiment builder failed.";
}

async function sha256(value: string) {
  const encoded = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function openAiUsage(value: unknown) {
  const usage = record(value);
  return {
    input_tokens: typeof usage.input_tokens === "number" ? usage.input_tokens : null,
    output_tokens: typeof usage.output_tokens === "number" ? usage.output_tokens : null,
  };
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
      body.action === "route" ||
      body.action === "assistant_chat" ||
      body.action === "settings_draft" ||
      body.action === "settings_revise" ||
      body.action === "archive_preflight" ||
      body.action === "archive"
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
      return response({
        error: "The removal was not recorded, so the experiment was left unchanged.",
      }, 500, origin);
    }
    return response({
      experiment_id: archived.id,
      experiment_slug: archived.slug,
      experiment_name: archived.name,
      status: archived.status,
      history_preserved: true,
    }, 200, origin);
  }

  if (action === "preflight" || action === "launch") {
    const compiled = compileControlPlan(body.draft, inventory);
    const { draft, messages, plan } = compiled;
    if (messages.length) {
      return response({ error: "Review the draft.", validation_messages: messages }, 400, origin);
    }
    if (!plan) {
      return response({ error: "Controller plan could not be compiled." }, 500, origin);
    }

    const expectedInventory = clean(body.inventory_updated_at, 80);
    if (!expectedInventory || expectedInventory !== configState.updated_at) {
      return response({ error: "The pot inventory changed. Review the experiment again." }, 409, origin);
    }

    if (action === "preflight") {
      return response({
        draft,
        plan,
        inventory_updated_at: configState.updated_at,
        config_hash: configState.config_hash,
        validation_messages: [],
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
    if (publishError) return response({ error: publishError.message }, 400, origin);
    const publishedResult = Array.isArray(published) ? published[0] : published;
    const experimentId = clean(publishedResult?.experiment_id, 80);
    const experimentSlug = clean(publishedResult?.experiment_slug, 80);

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
      return response({
        error: `Experiment was saved with watering off. ${attachError.message}`,
        experiment_id: experimentId,
        experiment_slug: experimentSlug,
      }, 409, origin);
    }
    const attachedResult = Array.isArray(attached) ? attached[0] : attached;
    const planId = clean(attachedResult?.plan_id, 80) || null;
    const batchId = clean(attachedResult?.batch_id, 80) || null;
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
        return response({
          error: `Experiment was created but remains safely paused. ${enqueueError}`,
          experiment_id: experimentId,
          experiment_slug: experimentSlug,
        }, 409, origin);
      }
      commandIds.push(commandId);
      dependsOnCommandId = commandId;
    }

    return response({
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

    if (chatAction) {
      const conversation = normalizeAssistantConversation(body.conversation);
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
          call.name === "prepare_experiment_archive"
        ) {
          const nextProposal = proposalFromFunctionCall(call);
          if (nextProposal && !proposalState.value) proposalState.value = nextProposal;
          return {
            prepared: Boolean(nextProposal),
            workflow: nextProposal?.workflow ?? null,
            safety: "No experiment or controller change has been executed.",
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
          const { data: commands, error: commandReadError } = await authClient
            .from("project_control_commands")
            .select(
              "id,experiment_id,command_type,status,requested_at,started_at,completed_at,error,result",
            )
            .eq("project_id", projectId)
            .gte("requested_at", since)
            .order("requested_at", { ascending: false })
            .limit(100);
          if (commandReadError) {
            console.error("assistant_activity_read_failed", {
              request_id: requestRow.id,
              code: commandReadError.code,
            });
            return {
              observed_at: new Date().toISOString(),
              hours,
              activity_available: false,
              error: "Recent activity could not be loaded.",
            };
          }
          const catalog = await loadCatalog();
          const experimentNameById = new Map(
            catalog.map((item) => [String(item.id), item.name]),
          );
          return {
            observed_at: new Date().toISOString(),
            hours,
            activity_available: true,
            commands: (commands ?? []).map((item) => ({
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
                "pairing_name,calibrated_value,device_recorded_at,server_received_at",
              )
              .eq("project_id", projectId)
              .in("pairing_name", pairingNames)
              .gte("device_recorded_at", since)
              .order("device_recorded_at", { ascending: false })
              .limit(5_000),
            authClient
              .from("valve_events")
              .select(
                "pairing_name,action,duration_ms,device_recorded_at,server_received_at",
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
          input.push({
            type: "function_call_output",
            call_id: call.call_id,
            output: JSON.stringify(result),
          });
        }
      }

      if (!reply) throw new Error("Assistant did not return an answer.");
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
        workflow: proposalState.value?.workflow ?? "answer",
        workflow_prompt: proposalState.value?.workflow_prompt ?? null,
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
                : "exacth2o_experiment_draft",
            strict: true,
            schema: routeAction
              ? assistantIntentSchema
              : settingsAction
                ? settingsPlanSchema
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

    const { draft, messages } = validateDraft(parsed, inventory);
    await admin
      .from("experiment_builder_requests")
      .update({ status: messages.length ? "rejected" : "completed", ...usage })
      .eq("id", requestRow.id);

    return response({
      draft,
      inventory_updated_at: configState.updated_at,
      source: "natural_language",
      model,
      prompt_fingerprint: promptFingerprint,
      validation_messages: messages,
    }, 200, origin);
  } catch (error) {
    await admin
      .from("experiment_builder_requests")
      .update({ status: "failed", error_code: "draft_failed" })
      .eq("id", requestRow.id);
    return response({ error: errorMessage(error) }, 502, origin);
  }
});
