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

const mattDeviceId = "3100e37ee3205651fe3dd86dafd4dc0c";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readingKey(reading: Record<string, unknown>) {
  return `${String(reading.pairing_name ?? "")}|${
    String(reading.device_recorded_at ?? "")
  }`;
}

function dedupeReadings(values: unknown[]) {
  const byPairingTime = new Map<string, Record<string, unknown>>();
  for (const value of values) {
    const reading = record(value);
    const key = readingKey(reading);
    const previous = byPairingTime.get(key);
    if (
      !previous ||
      Date.parse(String(reading.server_received_at ?? "")) >
        Date.parse(String(previous.server_received_at ?? ""))
    ) byPairingTime.set(key, reading);
  }
  return [...byPairingTime.values()].sort((left, right) =>
    Date.parse(String(left.device_recorded_at ?? "")) -
    Date.parse(String(right.device_recorded_at ?? ""))
  );
}

function pairingName(value: unknown) {
  const row = record(value);
  return String(row.name ?? row.pairing_name ?? row.pairingName ?? "");
}

function targetVwc(value: unknown) {
  const row = record(value);
  return Number(
    row.WTCPercentLimit ?? row.wtc_percent_limit ?? row.target_vwc ?? 0,
  );
}

function actualByHorizon(
  readings: Array<Record<string, unknown>>,
  pairing: string,
  openedAt: string | null,
  minutes: number[],
) {
  const values = new Map<number, number>();
  if (!openedAt) return values;
  const openedMs = Date.parse(openedAt);
  if (!Number.isFinite(openedMs)) return values;
  const rows = readings.filter((reading) =>
    reading.pairing_name === pairing &&
    Number.isFinite(Number(reading.calibrated_value))
  );
  const baseline = rows
    .filter((reading) =>
      Date.parse(String(reading.device_recorded_at ?? "")) <= openedMs
    )
    .at(-1);
  if (baseline) values.set(0, Number(baseline.calibrated_value));

  const candidates = rows.filter((reading) =>
    Date.parse(String(reading.device_recorded_at ?? "")) > openedMs
  );
  for (const reading of candidates) {
    const elapsed =
      (Date.parse(String(reading.device_recorded_at)) - openedMs) /
      60_000;
    const horizon = minutes
      .filter((minute) => minute > 0)
      .map((minute) => ({ minute, delta: Math.abs(minute - elapsed) }))
      .sort((left, right) => left.delta - right.delta)[0];
    if (!horizon || horizon.delta > 6) continue;
    values.set(horizon.minute, Number(reading.calibrated_value));
  }
  return values;
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

  const { data: observation, error: observationError } = await admin.rpc(
    "rd_worker_observation",
    {
      observation_project_id: projectId,
      observation_device_id: mattDeviceId,
      observation_since: new Date(Date.now() - 36 * 60 * 60 * 1000)
        .toISOString(),
    },
  );
  if (observationError) {
    return response({ error: "Could not load R&D observation" }, 500, origin);
  }
  const observationRecord = record(observation);
  const config = record(observationRecord.config);
  const pairings = Array.isArray(config.pairings) ? config.pairings : [];
  const enabledPairings = pairings.filter((item) => {
    const target = targetVwc(item);
    return Number.isFinite(target) && target >= 0;
  });
  const readings = dedupeReadings(
    Array.isArray(observationRecord.readings) ? observationRecord.readings : [],
  );
  const latestByPairing = new Map<string, Record<string, unknown>>();
  for (const reading of readings) {
    latestByPairing.set(String(reading.pairing_name ?? ""), reading);
  }

  const { data: predictions, error: predictionError } = await admin
    .from("rd_curve_predictions")
    .select(
      "id,pairing_name,model_version_id,trigger_vwc,target_vwc_at_issue,feature_as_of_device_at,issued_at,p10,p50,p90,confidence",
    )
    .eq("project_id", projectId)
    .order("issued_at", { ascending: false })
    .limit(200);
  if (predictionError) {
    return response({ error: "Could not load R&D predictions" }, 500, origin);
  }
  if (!predictions?.length) {
    const { error: emptyAuditError } = await admin.from("rd_access_audit")
      .insert({
        project_id: projectId,
        user_id: userData.user.id,
        action: "lab_snapshot",
        prediction_ids: [],
      });
    if (emptyAuditError) {
      return response({ error: "Could not audit R&D access" }, 500, origin);
    }
    const candidates = enabledPairings.map((item) => {
      const name = pairingName(item) || "Awaiting telemetry";
      const target = targetVwc(item);
      const reading = latestByPairing.get(name);
      const vwc = Number(reading?.calibrated_value ?? target);
      return { pairingName: name, target, vwc, reading };
    }).sort((left, right) =>
      Math.abs(left.vwc - left.target) - Math.abs(right.vwc - right.target)
    );
    const selected = candidates[0] ?? {
      pairingName: "Matt experiment",
      target: 0,
      vwc: 0,
      reading: null,
    };
    const now = new Date().toISOString();
    return response(
      {
        generated_at: now,
        mode: "shadow",
        champion_version: "bootstrap pending",
        candidate_version: null,
        clean_events_learned: 0,
        current: {
          id: "awaiting-first-causal-forecast",
          pairing_name: selected.pairingName,
          state: "awaiting_threshold",
          target_vwc: selected.target,
          trigger_vwc: selected.vwc,
          committed_at: now,
          feature_as_of_device_at: String(
            selected.reading?.device_recorded_at ?? now,
          ),
          irrigation_opened_device_at: null,
          model_version: "bootstrap pending",
          prediction_lead_seconds: 0,
          curve: [],
          score: null,
          censored: false,
          confidence: "low_confidence",
        },
        pots: candidates
          .slice()
          .sort((left, right) =>
            left.pairingName.localeCompare(right.pairingName, undefined, {
              numeric: true,
            })
          )
          .map((candidate) => ({
            pairing_name: candidate.pairingName,
            target_vwc: candidate.target,
            current_vwc: candidate.vwc,
            distance_to_target: candidate.vwc - candidate.target,
            last_reading_at: candidate.reading?.device_recorded_at ?? null,
            state: "waiting_threshold",
            event: null,
          })),
        history: [],
        progress: [],
      },
      200,
      origin,
    );
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
    const committedState = (states ?? [])
      .filter((event) =>
        event.prediction_id === prediction.id && event.state === "committed"
      )
      .sort((left, right) =>
        Date.parse(String(right.occurred_at)) -
        Date.parse(String(left.occurred_at))
      )[0];
    const committedDetails = record(committedState?.details);
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
    const openedValue = details.irrigation_opened_device_at ??
      committedDetails.irrigation_opened_device_at;
    const openedAt = typeof openedValue === "string" ? openedValue : null;
    const liveActual = actualByHorizon(
      readings,
      prediction.pairing_name,
      openedAt,
      minutes,
    );
    const storedState = String(state?.state ?? "armed_early");
    const displayState = storedState === "committed" && liveActual.size > 1
      ? "tracking_response"
      : storedState;
    return {
      id: prediction.id,
      pairing_name: prediction.pairing_name,
      state: displayState,
      target_vwc: prediction.target_vwc_at_issue,
      trigger_vwc: prediction.trigger_vwc,
      committed_at: prediction.issued_at,
      feature_as_of_device_at: prediction.feature_as_of_device_at,
      irrigation_opened_device_at: openedAt,
      model_version: modelById.get(prediction.model_version_id)?.version ??
        "unknown",
      prediction_lead_seconds: details.prediction_lead_seconds ??
        committedDetails.prediction_lead_seconds ?? 0,
      curve: minutes.map((minute, index) => ({
        minute,
        p10: p10.values?.[index] ?? null,
        predicted: p50.values?.[index] ?? null,
        p90: p90.values?.[index] ?? null,
        actual: actual.values?.[index] ?? liveActual.get(minute) ?? null,
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
  const activeCurrent = displayEvents.find((event) =>
    ![
      "expired_no_event",
      "missed_causal_window",
      "aborted_config_change",
    ].includes(String(event.state))
  );
  const current = activeCurrent ?? {
    ...displayEvents[0],
    id: "awaiting-next-causal-forecast",
    state: "awaiting_threshold",
    trigger_vwc: displayEvents[0].target_vwc,
    committed_at: new Date().toISOString(),
    feature_as_of_device_at: new Date().toISOString(),
    irrigation_opened_device_at: null,
    prediction_lead_seconds: 0,
    curve: [],
    score: null,
    censored: false,
  };
  const completedHistory = displayEvents.filter((event) =>
    ![
      "armed_early",
      "armed_refresh",
      "expired_no_event",
      "missed_causal_window",
      "aborted_config_change",
    ].includes(String(event.state))
  );
  const history = activeCurrent
    ? completedHistory.filter((event) => event.id !== activeCurrent.id)
    : completedHistory;
  const visibleEvents = displayEvents.filter((event) =>
    ![
      "expired_no_event",
      "missed_causal_window",
      "aborted_config_change",
    ].includes(String(event.state))
  );
  const latestEventByPairing = new Map<string, typeof displayEvents[number]>();
  for (const event of visibleEvents) {
    if (!latestEventByPairing.has(event.pairing_name)) {
      latestEventByPairing.set(event.pairing_name, event);
    }
  }
  const pots = enabledPairings
    .map((item) => {
      const name = pairingName(item);
      const target = targetVwc(item);
      const reading = latestByPairing.get(name);
      const currentVwc = Number(reading?.calibrated_value ?? target);
      const event = latestEventByPairing.get(name) ?? null;
      return {
        pairing_name: name,
        target_vwc: target,
        current_vwc: currentVwc,
        distance_to_target: currentVwc - target,
        last_reading_at: reading?.device_recorded_at ?? null,
        state: event?.state ?? "waiting_threshold",
        event,
      };
    })
    .sort((left, right) =>
      left.pairing_name.localeCompare(right.pairing_name, undefined, {
        numeric: true,
      })
    );
  return response(
    {
      generated_at: new Date().toISOString(),
      mode: "shadow",
      champion_version: champion?.version ?? displayEvents[0].model_version,
      candidate_version: candidate?.version ?? null,
      clean_events_learned: cleanCountResult.count ?? 0,
      current,
      pots,
      history,
      progress: history.slice().reverse().map((event, index) => ({
        event: event.pairing_name,
        index: index + 1,
        curve_mae: event.score?.curve_mae ?? null,
      })),
    },
    200,
    origin,
  );
});
