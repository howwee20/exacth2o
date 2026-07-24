import { createClient } from "npm:@supabase/supabase-js@2";
import {
  experimentDraftSchema,
  inventoryFromDeviceConfig,
  responseOutputText,
  systemInstructions,
  userDraftInput,
  validateDraft,
} from "./experiment-policy.mjs";

const allowedOrigins = new Set([
  "https://exacth2o.com",
  "https://www.exacth2o.com",
  "https://howwee20.github.io",
  "http://127.0.0.1:5173",
  "http://localhost:5173",
]);
const requestLimitPerDay = 20;
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
  const action = body.action === "draft" || body.action === "publish"
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
    .select("project_id,pairings,groups,updated_at,config_hash")
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

  if (action === "publish") {
    const source = body.source === "natural_language" ? "natural_language" : "manual";
    const { draft, messages } = validateDraft(body.draft, inventory);
    if (messages.length) {
      return response({ error: "Review the draft.", validation_messages: messages }, 400, origin);
    }

    const expectedInventory = clean(body.inventory_updated_at, 80);
    if (!expectedInventory || expectedInventory !== configState.updated_at) {
      return response({ error: "The pot inventory changed. Review the experiment again." }, 409, origin);
    }

    const { data: published, error: publishError } = await authClient.rpc(
      "publish_sensing_experiment",
      {
        requested_project_id: projectId,
        reviewed_spec: { ...draft, watering_requested: false },
        expected_inventory_updated_at: expectedInventory,
        draft_source: source,
        draft_model_name: source === "natural_language" ? clean(body.model, 120) || model : null,
        draft_prompt_fingerprint: source === "natural_language"
          ? clean(body.prompt_fingerprint, 128) || null
          : null,
      },
    );
    if (publishError) {
      return response({ error: publishError.message }, 400, origin);
    }
    const result = Array.isArray(published) ? published[0] : published;
    return response({
      experiment_id: result?.experiment_id,
      experiment_slug: result?.experiment_slug,
    }, 200, origin);
  }

  const prompt = clean(body.prompt, promptLimit);
  if (!prompt) return response({ error: "Describe the experiment." }, 400, origin);

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { count, error: countError } = await admin
    .from("experiment_builder_requests")
    .select("id", { count: "exact", head: true })
    .eq("project_id", projectId)
    .eq("user_id", userData.user.id)
    .gte("created_at", since);
  if (countError) return response({ error: "Could not check the request limit." }, 500, origin);
  if ((count ?? 0) >= requestLimitPerDay) {
    return response({ error: "Daily draft limit reached. Enter the experiment manually." }, 429, origin);
  }

  const promptFingerprint = await sha256(prompt);
  const { data: requestRow, error: requestError } = await admin
    .from("experiment_builder_requests")
    .insert({
      project_id: projectId,
      user_id: userData.user.id,
      source: "natural_language",
      status: "started",
      model_name: model,
      prompt_fingerprint: promptFingerprint,
    })
    .select("id")
    .single();
  if (requestError) {
    return response({ error: "Could not start the experiment draft." }, 500, origin);
  }

  try {
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
          { role: "system", content: systemInstructions() },
          { role: "user", content: userDraftInput(prompt, inventory) },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "exacth2o_experiment_draft",
            strict: true,
            schema: experimentDraftSchema,
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
    const { draft, messages } = validateDraft(parsed, inventory);
    const usage = openAiUsage(openAiBody.usage);
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
