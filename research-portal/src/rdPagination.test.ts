import { describe, expect, it } from "vitest";

import { mergeRdHistoryPage } from "./rdPagination";
import type { RdCorrectionEpisode, RdLabSnapshot } from "./rdTypes";

function episode(id: string, startedAt: string): RdCorrectionEpisode {
  return {
    id,
    pairing_name: "Zone2-Pot41",
    status: "complete",
    started_at: startedAt,
    last_open_at: startedAt,
    target_vwc: 20,
    pulse_count: 1,
    correction_ended_at: startedAt,
    observation_ends_at: startedAt,
    completed_at: startedAt,
    curve: [],
    pulses: [],
    missed_forecasts: 0,
    quality: {},
  };
}

function snapshot(episodes: RdCorrectionEpisode[], hasMore: boolean): RdLabSnapshot {
  return {
    generated_at: "2026-07-17T12:00:00.000Z",
    mode: "shadow",
    champion_version: "v4",
    candidate_version: null,
    clean_events_learned: 1,
    current: {
      id: "current",
      pairing_name: "Zone2-Pot41",
      state: "awaiting_threshold",
      target_vwc: 20,
      trigger_vwc: 20,
      committed_at: "2026-07-17T12:00:00.000Z",
      feature_as_of_device_at: "2026-07-17T12:00:00.000Z",
      irrigation_opened_device_at: null,
      model_version: "v4",
      prediction_lead_seconds: 0,
      curve: [],
      score: null,
      censored: false,
      confidence: "low",
    },
    pots: [{
      pairing_name: "Zone2-Pot41",
      target_vwc: 20,
      current_vwc: 19,
      distance_to_target: -1,
      last_reading_at: null,
      state: "waiting_threshold",
      event: null,
      episodes,
    }],
    episodes,
    pagination: {
      page_size: 1,
      has_more: hasMore,
      next_cursor: hasMore ? episodes.at(-1)?.started_at ?? null : null,
    },
    history: [],
    progress: [],
  };
}

describe("R&D history pagination", () => {
  it("appends older episodes without replacing the live snapshot", () => {
    const newest = episode("new", "2026-07-17T12:00:00.000Z");
    const oldest = episode("old", "2026-07-16T12:00:00.000Z");
    const merged = mergeRdHistoryPage(snapshot([newest], true), snapshot([oldest], false));

    expect(merged.current.id).toBe("current");
    expect(merged.episodes?.map((item) => item.id)).toEqual(["new", "old"]);
    expect(merged.pots[0].episodes?.map((item) => item.id)).toEqual(["new", "old"]);
    expect(merged.pagination?.has_more).toBe(false);
  });
});
