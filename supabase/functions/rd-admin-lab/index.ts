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
const mattControlTargetVwc = 20;

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

const responseMinutes = [0, 5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240];

function interpolateCurve(
  curve: Array<Record<string, unknown>>,
  field: "p10" | "predicted" | "p90",
  ageMinutes: number,
) {
  if (ageMinutes < 0 || !curve.length) return null;
  const points = curve
    .map((point) => ({
      minute: Number(point.minute),
      value: Number(point[field]),
    }))
    .filter((point) =>
      Number.isFinite(point.minute) && Number.isFinite(point.value)
    )
    .sort((left, right) => left.minute - right.minute);
  if (!points.length || ageMinutes > points[points.length - 1].minute) {
    return null;
  }
  const exact = points.find((point) => point.minute === ageMinutes);
  if (exact) return exact.value;
  const rightIndex = points.findIndex((point) => point.minute > ageMinutes);
  if (rightIndex <= 0) return points[0].value;
  const left = points[rightIndex - 1];
  const right = points[rightIndex];
  const ratio = (ageMinutes - left.minute) / (right.minute - left.minute);
  return left.value + (right.value - left.value) * ratio;
}

function episodeTotalCurve(
  episode: Record<string, unknown>,
  irrigationEvents: Array<Record<string, unknown>>,
  displayByPrediction: Map<string, Record<string, unknown>>,
  readings: Array<Record<string, unknown>>,
) {
  const startedAt = String(episode.first_open_device_at ?? "");
  const startedMs = Date.parse(startedAt);
  const pairing = String(episode.pairing_name ?? "");
  const potReadings = readings.filter((reading) =>
    reading.pairing_name === pairing
  );
  const baseline = potReadings
    .filter((reading) =>
      Date.parse(String(reading.device_recorded_at ?? "")) <= startedMs
    )
    .at(-1);
  const baselineVwc = Number(
    baseline?.calibrated_value ?? episode.target_vwc_at_start ?? 0,
  );
  const pulses = irrigationEvents
    .filter((event) => event.episode_id === episode.id)
    .sort((left, right) =>
      Date.parse(String(left.opened_device_at)) -
      Date.parse(String(right.opened_device_at))
    );
  return responseMinutes.map((minute) => {
    const totals = {
      p10: baselineVwc,
      predicted: baselineVwc,
      p90: baselineVwc,
    };
    for (const pulse of pulses) {
      if (!pulse.prediction_id) continue;
      const prediction = displayByPrediction.get(String(pulse.prediction_id));
      const curve = Array.isArray(prediction?.curve)
        ? prediction.curve as Array<Record<string, unknown>>
        : [];
      const offset = (Date.parse(String(pulse.opened_device_at)) - startedMs) /
        60_000;
      const age = minute - offset;
      for (const field of ["p10", "predicted", "p90"] as const) {
        const value = interpolateCurve(curve, field, age);
        const origin = interpolateCurve(curve, field, 0);
        if (value != null && origin != null) totals[field] += value - origin;
      }
    }
    const targetMs = startedMs + minute * 60_000;
    const nearest = potReadings
      .map((reading) => ({
        reading,
        delta:
          Math.abs(Date.parse(String(reading.device_recorded_at)) - targetMs) /
          60_000,
      }))
      .sort((left, right) => left.delta - right.delta)[0];
    return {
      minute,
      p10: totals.p10,
      predicted: totals.predicted,
      p90: totals.p90,
      actual: nearest && nearest.delta <= 6
        ? Number(nearest.reading.calibrated_value)
        : null,
    };
  });
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
    return Number.isFinite(target) &&
      Math.abs(target - mattControlTargetVwc) < 1e-9;
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
    .limit(500);
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
        learning: {
          completed_episode_totals: 0,
          eligible_episode_totals: 0,
          minimum_episode_floor: 40,
          next_training_at: 40,
          episodes_until_next_training: 40,
          represented_control_pots: 0,
          required_control_pots: 8,
          multi_pulse_episodes: 0,
          required_multi_pulse_episodes: 10,
          calendar_span_days: 0,
          required_calendar_span_days: 7,
          qualified_chronological_windows: 0,
          required_chronological_windows: 2,
          model_family: "regularized additive impulse",
          last_training_at: null,
          status: "collecting_evidence",
        },
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
  const predictionIdSet = new Set(predictionIds);
  const [
    stateResult,
    scoreResult,
    modelResult,
    episodeV2Result,
    irrigationEventV2Result,
    outcomeV2Result,
    episodeScoreV2Result,
    evaluationV2Result,
    trainingRunResult,
  ] = await Promise.all([
    admin.from("rd_prediction_events").select(
      "prediction_id,state,details,occurred_at",
    ).order("occurred_at", { ascending: false }).limit(10000),
    admin.from("rd_prediction_scores").select(
      "prediction_id,curve_mae,peak_error,time_to_peak_error_minutes,integrated_response_error,interval_coverage,scored_horizons",
    ).order("created_at", { ascending: false }).limit(5000),
    admin.from("rd_model_versions").select(
      "id,version,status,metrics,training_event_count,feature_schema_version,synthetic_data_only,created_at",
    ).order("created_at", { ascending: false }).limit(100),
    admin.from("rd_correction_episodes_v2").select(
      "id,episode_key,pairing_name,first_open_device_at,last_open_device_at,target_vwc_at_start,pulse_count,status,correction_ended_at,observation_ends_at,completed_at,quality",
    ).eq("project_id", projectId).order("first_open_device_at", {
      ascending: false,
    }).limit(200),
    admin.from("rd_irrigation_events_v2").select(
      "id,valve_event_id,episode_id,pairing_name,sequence_in_episode,prediction_id,prediction_status,opened_device_at,duration_ms,duration_source,evidence_source,prediction_lead_seconds,quality",
    ).eq("project_id", projectId).order("opened_device_at", {
      ascending: false,
    }).limit(1000),
    admin.from("rd_episode_outcomes_v2").select(
      "id,episode_id,pairing_name,first_open_device_at,observed_horizons,pulse_count,eligible_for_scoring,eligible_for_training,quality_reasons,completed_at",
    ).eq("project_id", projectId).order("completed_at", { ascending: false })
      .limit(500),
    admin.from("rd_episode_scores_v2").select(
      "episode_id,model_version_id,model_role,curve_mae,peak_error,time_to_peak_error_minutes,integrated_response_error,interval_coverage,scored_horizons,created_at",
    ).order("created_at", { ascending: false }).limit(2000),
    admin.from("rd_evaluation_windows_v2").select(
      "model_version_id,window_number,episode_count,multi_pulse_episode_count,pot_count,baseline_curve_mae,candidate_curve_mae,improvement_percent,interval_coverage,passed,evaluation_started_at,evaluation_ended_at",
    ).order("created_at", { ascending: false }).limit(200),
    admin.from("rd_training_runs").select(
      "model_version_id,training_event_count,held_out_event_count,result,metrics,completed_at",
    ).order("completed_at", { ascending: false }).limit(50),
  ]);
  if (
    stateResult.error || scoreResult.error || modelResult.error ||
    episodeV2Result.error || irrigationEventV2Result.error ||
    outcomeV2Result.error || episodeScoreV2Result.error ||
    evaluationV2Result.error || trainingRunResult.error
  ) {
    return response({ error: "Could not assemble R&D snapshot" }, 500, origin);
  }
  const states = (stateResult.data ?? []).filter((item) =>
    predictionIdSet.has(item.prediction_id)
  );
  const scores = (scoreResult.data ?? []).filter((item) =>
    predictionIdSet.has(item.prediction_id)
  );
  const models = modelResult.data ?? [];
  const outcomesV2 = outcomeV2Result.data ?? [];
  const episodeScoresV2 = episodeScoreV2Result.data ?? [];
  const evaluationsV2 = evaluationV2Result.data ?? [];
  const trainingRuns = trainingRunResult.data ?? [];
  const scoreByPrediction = new Map(
    (scores ?? []).map((item) => [item.prediction_id, item]),
  );
  const modelById = new Map((models ?? []).map((item) => [item.id, item]));
  const champion = (models ?? []).find((model) =>
    model.status === "champion" &&
    model.feature_schema_version === "episode-impulse-v2" &&
    model.synthetic_data_only === false
  );
  const candidate = (models ?? []).find((model) =>
    model.status === "candidate" &&
    model.feature_schema_version === "episode-impulse-v2" &&
    model.synthetic_data_only === false
  );
  const outcomeByEpisode = new Map(
    outcomesV2.map((outcome) => [outcome.episode_id, outcome]),
  );
  const learningScoreByEpisode = new Map<string, Record<string, unknown>>();
  for (const score of episodeScoresV2) {
    const preferred = score.model_version_id === champion?.id ||
      (!champion && score.model_version_id === candidate?.id);
    if (preferred || !learningScoreByEpisode.has(String(score.episode_id))) {
      learningScoreByEpisode.set(String(score.episode_id), score);
    }
  }

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
  const displayByPrediction = new Map<string, Record<string, unknown>>(
    displayEvents.map((event) => [event.id, event]),
  );
  const irrigationEventsV2 = (irrigationEventV2Result.data ?? []) as Array<
    Record<string, unknown>
  >;
  const episodeDtos = ((episodeV2Result.data ?? []) as Array<
    Record<string, unknown>
  >).map((episode) => {
    const pulses = irrigationEventsV2
      .filter((event) => event.episode_id === episode.id)
      .sort((left, right) =>
        Number(left.sequence_in_episode) - Number(right.sequence_in_episode)
      )
      .map((event) => ({
        id: event.id,
        valve_event_id: event.valve_event_id,
        sequence: event.sequence_in_episode,
        opened_at: event.opened_device_at,
        duration_ms: event.duration_ms,
        duration_source: event.duration_source,
        prediction_status: event.prediction_status,
        prediction_lead_seconds: event.prediction_lead_seconds,
        prediction: event.prediction_id
          ? displayByPrediction.get(String(event.prediction_id)) ?? null
          : null,
        quality: event.quality,
      }));
    const outcome = outcomeByEpisode.get(String(episode.id)) ?? null;
    const learningScore = learningScoreByEpisode.get(String(episode.id)) ?? null;
    return {
      id: episode.id,
      pairing_name: episode.pairing_name,
      status: episode.status,
      started_at: episode.first_open_device_at,
      last_open_at: episode.last_open_device_at,
      target_vwc: episode.target_vwc_at_start,
      pulse_count: episode.pulse_count,
      correction_ended_at: episode.correction_ended_at,
      observation_ends_at: episode.observation_ends_at,
      completed_at: episode.completed_at,
      curve: episodeTotalCurve(
        episode,
        irrigationEventsV2,
        displayByPrediction,
        readings,
      ),
      pulses,
      missed_forecasts: pulses.filter((pulse) => !pulse.prediction).length,
      quality: episode.quality,
      outcome: outcome
        ? {
          observed_horizons: outcome.observed_horizons,
          eligible_for_scoring: outcome.eligible_for_scoring,
          eligible_for_training: outcome.eligible_for_training,
          quality_reasons: outcome.quality_reasons,
          completed_at: outcome.completed_at,
        }
        : null,
      score: learningScore
        ? {
          model_version: modelById.get(String(learningScore.model_version_id))
            ?.version ?? "unknown",
          model_role: learningScore.model_role,
          curve_mae: learningScore.curve_mae,
          peak_error: learningScore.peak_error,
          time_to_peak_error_minutes:
            learningScore.time_to_peak_error_minutes,
          integrated_response_error: learningScore.integrated_response_error,
          interval_coverage: learningScore.interval_coverage,
          scored_horizons: learningScore.scored_horizons,
        }
        : null,
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
  const nextForecastByPairing = new Map<string, typeof displayEvents[number]>();
  for (const event of displayEvents) {
    if (
      ["armed_early", "armed_refresh"].includes(String(event.state)) &&
      !nextForecastByPairing.has(event.pairing_name)
    ) nextForecastByPairing.set(event.pairing_name, event);
  }
  const activeEpisodeByPairing = new Map<string, typeof episodeDtos[number]>();
  const episodesByPairing = new Map<
    string,
    Array<typeof episodeDtos[number]>
  >();
  for (const episode of episodeDtos) {
    const name = String(episode.pairing_name);
    const list = episodesByPairing.get(name) ?? [];
    list.push(episode);
    episodesByPairing.set(name, list);
    if (
      ["active", "observing"].includes(String(episode.status)) &&
      !activeEpisodeByPairing.has(name)
    ) activeEpisodeByPairing.set(name, episode);
  }
  const pots = enabledPairings
    .map((item) => {
      const name = pairingName(item);
      const target = targetVwc(item);
      const reading = latestByPairing.get(name);
      const currentVwc = Number(reading?.calibrated_value ?? target);
      const episode = activeEpisodeByPairing.get(name) ?? null;
      const nextForecast = nextForecastByPairing.get(name) ?? null;
      const lastPulse = episode?.pulses.at(-1);
      const event = lastPulse?.prediction ?? nextForecast ??
        latestEventByPairing.get(name) ?? null;
      return {
        pairing_name: name,
        target_vwc: target,
        current_vwc: currentVwc,
        distance_to_target: currentVwc - target,
        last_reading_at: reading?.device_recorded_at ?? null,
        state: episode
          ? `episode_${episode.status}`
          : nextForecast?.state ?? "waiting_threshold",
        event,
        next_forecast: nextForecast,
        active_episode: episode,
        episodes: episodesByPairing.get(name) ?? [],
      };
    })
    .sort((left, right) =>
      left.pairing_name.localeCompare(right.pairing_name, undefined, {
        numeric: true,
      })
    );
  const eligibleOutcomes = outcomesV2.filter((outcome) =>
    outcome.eligible_for_training === true
  );
  const eligiblePots = new Set(
    eligibleOutcomes.map((outcome) => String(outcome.pairing_name)),
  ).size;
  const multiPulseEpisodes = eligibleOutcomes.filter((outcome) =>
    Number(outcome.pulse_count) > 1
  ).length;
  const eligibleTimes = eligibleOutcomes
    .map((outcome) => Date.parse(String(outcome.first_open_device_at)))
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right);
  const calendarSpanDays = eligibleTimes.length > 1
    ? (eligibleTimes.at(-1)! - eligibleTimes[0]) / 86_400_000
    : 0;
  const activeLearningModel = champion ?? candidate ?? null;
  const activeWindows = activeLearningModel
    ? evaluationsV2.filter((window) =>
      window.model_version_id === activeLearningModel.id
    )
    : [];
  const qualifiedWindows = activeWindows.filter((window) =>
    window.passed === true
  ).length;
  const lastTraining = trainingRuns.find((run) =>
    run.result === "succeeded"
  ) ?? null;
  const priorTrainingCount = Math.max(
    0,
    ...models.filter((model) =>
      model.feature_schema_version === "episode-impulse-v2"
    ).map((model) => Number(model.training_event_count ?? 0)),
  );
  const nextTrainingAt = priorTrainingCount > 0
    ? priorTrainingCount + 10
    : 40;
  const progress = episodeDtos
    .filter((episode) => episode.score?.curve_mae != null)
    .slice()
    .reverse()
    .map((episode, index) => ({
      event: episode.pairing_name,
      index: index + 1,
      curve_mae: episode.score?.curve_mae ?? null,
    }));
  return response(
    {
      generated_at: new Date().toISOString(),
      mode: "shadow",
      champion_version: champion?.version ?? displayEvents[0].model_version,
      candidate_version: candidate?.version ?? null,
      clean_events_learned: eligibleOutcomes.length,
      learning: {
        completed_episode_totals: outcomesV2.length,
        eligible_episode_totals: eligibleOutcomes.length,
        minimum_episode_floor: 40,
        next_training_at: nextTrainingAt,
        episodes_until_next_training: Math.max(
          0,
          nextTrainingAt - eligibleOutcomes.length,
        ),
        represented_control_pots: eligiblePots,
        required_control_pots: 8,
        multi_pulse_episodes: multiPulseEpisodes,
        required_multi_pulse_episodes: 10,
        calendar_span_days: calendarSpanDays,
        required_calendar_span_days: 7,
        qualified_chronological_windows: qualifiedWindows,
        required_chronological_windows: 2,
        model_family: "regularized additive impulse",
        last_training_at: lastTraining?.completed_at ?? null,
        status: champion
          ? "champion_active"
          : candidate
          ? "candidate_evaluating"
          : "collecting_evidence",
      },
      current,
      pots,
      episodes: episodeDtos,
      history,
      progress,
    },
    200,
    origin,
  );
});
