import { createClient } from "npm:@supabase/supabase-js@2";

const allowedOrigins = new Set<string>([
  "https://exacth2o.com",
  "https://www.exacth2o.com",
  ...(Deno.env.get("RD_ALLOWED_ORIGINS") ?? "").split(",").map((value) =>
    value.trim()
  ).filter(Boolean),
]);

function response(body: unknown, status: number, origin: string | null) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "private, no-store",
      "access-control-allow-origin": origin && allowedOrigins.has(origin)
        ? origin
        : "https://exacth2o.com",
      "access-control-allow-headers":
        "authorization, content-type, apikey, x-client-info",
      "access-control-allow-methods": "POST, OPTIONS",
      vary: "origin",
    },
  });
}

function latestState(
  events: Array<Record<string, unknown>>,
  predictionId: string,
) {
  return events
    .filter((event) => event.prediction_id === predictionId)
    .sort((left, right) =>
      Date.parse(String(right.occurred_at)) -
      Date.parse(String(left.occurred_at))
    )[0];
}

Deno.serve(async (request) => {
  const origin = request.headers.get("origin");
  if (request.method === "OPTIONS") return response({ ok: true }, 200, origin);
  if (request.method !== "POST") {
    return response({ error: "Method not allowed" }, 405, origin);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const projectId = Deno.env.get("RD_PROJECT_ID");
  if (!supabaseUrl || !anonKey || !serviceKey || !projectId) {
    return response({ error: "R&D service is not configured" }, 503, origin);
  }

  const authorization = request.headers.get("authorization") ?? "";
  const jwt = authorization.replace(/^Bearer\s+/i, "");
  if (!jwt) return response({ error: "Authentication required" }, 401, origin);

  const authClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false },
  });
  const { data: userData, error: userError } = await authClient.auth.getUser(
    jwt,
  );
  if (userError || !userData.user) {
    return response({ error: "Authentication required" }, 401, origin);
  }

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });
  const { data: access } = await admin
    .from("rd_system_admin_access")
    .select("enabled, revoked_at")
    .eq("project_id", projectId)
    .eq("user_id", userData.user.id)
    .maybeSingle();
  if (!access?.enabled || access.revoked_at) {
    return response(
      { error: "R&D system administrator access required" },
      403,
      origin,
    );
  }

  const { data: predictions, error: predictionError } = await admin
    .from("rd_curve_predictions")
    .select(
      "id,pairing_name,model_version_id,trigger_vwc,target_vwc_at_issue,feature_as_of_device_at,issued_at,p10,p50,p90,confidence",
    )
    .eq("project_id", projectId)
    .order("issued_at", { ascending: false })
    .limit(21);
  if (predictionError) {
    return response({ error: "Could not load R&D predictions" }, 500, origin);
  }
  if (!predictions?.length) {
    return response({ allowed: true, snapshot: null }, 200, origin);
  }

  const predictionIds = predictions.map((item) => item.id);
  const modelIds = Array.from(
    new Set(predictions.map((item) => item.model_version_id)),
  );
  const [stateResult, scoreResult, modelResult, cleanCountResult] =
    await Promise.all([
      admin.from("rd_prediction_events").select(
        "prediction_id,state,details,occurred_at",
      ).in("prediction_id", predictionIds),
      admin.from("rd_prediction_scores").select(
        "prediction_id,curve_mae,peak_error,time_to_peak_error_minutes,integrated_response_error,interval_coverage,scored_horizons",
      ).in("prediction_id", predictionIds),
      admin.from("rd_model_versions").select("id,version,status").in(
        "id",
        modelIds,
      ),
      admin.from("rd_curve_outcomes").select("id", {
        count: "exact",
        head: true,
      }).eq("eligible_for_training", true),
    ]);
  if (
    stateResult.error || scoreResult.error || modelResult.error ||
    cleanCountResult.error
  ) {
    return response({ error: "Could not assemble R&D snapshot" }, 500, origin);
  }
  const states = stateResult.data ?? [];
  const scores = scoreResult.data ?? [];
  const models = modelResult.data ?? [];
  const scoreByPrediction = new Map(
    (scores ?? []).map((item) => [item.prediction_id, item]),
  );
  const modelById = new Map((models ?? []).map((item) => [item.id, item]));

  const displayEvents = predictions.map((prediction) => {
    const state = latestState(states ?? [], prediction.id);
    const details = (state?.details ?? {}) as Record<string, unknown>;
    const p10 = prediction.p10 as {
      minutes?: number[];
      values?: Array<number | null>;
    };
    const p50 = prediction.p50 as {
      minutes?: number[];
      values?: Array<number | null>;
    };
    const p90 = prediction.p90 as {
      minutes?: number[];
      values?: Array<number | null>;
    };
    const actual = (details.actual_absolute ?? {}) as {
      values?: Array<number | null>;
    };
    const minutes = p50.minutes ?? [];
    return {
      id: prediction.id,
      pairing_name: prediction.pairing_name,
      state: state?.state ?? "armed_early",
      target_vwc: prediction.target_vwc_at_issue,
      trigger_vwc: prediction.trigger_vwc,
      committed_at: prediction.issued_at,
      feature_as_of_device_at: prediction.feature_as_of_device_at,
      irrigation_opened_device_at: details.irrigation_opened_device_at ?? null,
      model_version: modelById.get(prediction.model_version_id)?.version ??
        "unknown",
      prediction_lead_seconds: details.prediction_lead_seconds ?? 0,
      curve: minutes.map((minute, index) => ({
        minute,
        p10: p10.values?.[index] ?? null,
        predicted: p50.values?.[index] ?? null,
        p90: p90.values?.[index] ?? null,
        actual: actual.values?.[index] ?? null,
      })),
      score: (() => {
        const score = scoreByPrediction.get(prediction.id);
        if (!score) return null;
        return {
          curve_mae: score.curve_mae,
          peak_error: score.peak_error,
          time_to_peak_error_minutes: score.time_to_peak_error_minutes,
          integrated_response_error: score.integrated_response_error,
          interval_coverage: score.interval_coverage,
          scored_horizons: score.scored_horizons,
        };
      })(),
      censored: details.censored === true,
      confidence: prediction.confidence,
    };
  });

  const { error: auditError } = await admin.from("rd_access_audit").insert({
    project_id: projectId,
    user_id: userData.user.id,
    action: "lab_snapshot",
    prediction_ids: predictionIds,
  });
  if (auditError) {
    return response({ error: "Could not audit R&D access" }, 500, origin);
  }

  const champion = (models ?? []).find((model) => model.status === "champion");
  const candidate = (models ?? []).find((model) =>
    model.status === "candidate"
  );
  return response(
    {
      generated_at: new Date().toISOString(),
      mode: "shadow",
      champion_version: champion?.version ?? displayEvents[0].model_version,
      candidate_version: candidate?.version ?? null,
      clean_events_learned: cleanCountResult.count ?? 0,
      current: displayEvents[0],
      history: displayEvents.slice(1),
      progress: displayEvents.slice(1).reverse().map((event, index) => ({
        event: event.pairing_name,
        index: index + 1,
        curve_mae: event.score?.curve_mae ?? null,
      })),
    },
    200,
    origin,
  );
});

