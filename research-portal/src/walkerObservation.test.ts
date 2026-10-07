import { describe, expect, it } from "vitest";
import {
  walkerFreshness,
  isWalkerAccessDenied,
  toggleWalkerSensorSelection,
  walkerSensorsByBoard,
  type WalkerLiveSensor,
} from "./walkerObservation";

const sensor = (overrides: Partial<WalkerLiveSensor> = {}): WalkerLiveSensor => ({
  source_sensor_id: 746,
  sensor_key: "D30GQN2S:A",
  display_label: "25-A",
  source_pairing_name: "25-A",
  position_number: 25,
  board_serial_id: "D30GQN2S",
  sensor_address: "A",
  latest_calibrated_value: null,
  latest_reading_at: null,
  live_point_count: 0,
  ...overrides,
});

describe("Walker live observation helpers", () => {
  it("recognizes backend authorization denials", () => {
    expect(isWalkerAccessDenied({ code: "42501" })).toBe(true);
    expect(isWalkerAccessDenied({ message: "observation access required" })).toBe(true);
    expect(isWalkerAccessDenied({ code: "500" })).toBe(false);
  });

  it("groups the evidenced inventory by physical board", () => {
    const grouped = walkerSensorsByBoard([
      sensor(),
      sensor({ source_sensor_id: 747, board_serial_id: "D30GQN2F" }),
      sensor({ source_sensor_id: 748 }),
    ]);
    expect(grouped.map(([board, sensors]) => [board, sensors.length])).toEqual([
      ["D30GQN2F", 1],
      ["D30GQN2S", 2],
    ]);
  });

  it("isolates a sensor from All and then builds a subset", () => {
    const allIds = [746, 747, 748];
    const isolated = toggleWalkerSensorSelection(new Set(allIds), 747, allIds);
    expect([...isolated]).toEqual([747]);
    const subset = toggleWalkerSensorSelection(isolated, 748, allIds);
    expect([...subset]).toEqual([747, 748]);
    expect(toggleWalkerSensorSelection(subset, 747, allIds).has(747)).toBe(false);
  });
});

describe("walkerFreshness", () => {
  const nowMs = Date.parse("2026-10-07T16:00:00Z");

  it("does not call a September reading live even if the feed reports live", () => {
    const result = walkerFreshness({ freshness: "live", latest_live_reading_at: "2026-09-16T19:23:00Z" }, nowMs);
    expect(result.state).toBe("stale");
    expect(result.label).toBe("Stale");
  });

  it("keeps the server's delayed or stale judgement for a recent timestamp", () => {
    expect(walkerFreshness({ freshness: "stale", latest_live_reading_at: "2026-10-07T15:58:00Z" }, nowMs).state).toBe("stale");
    expect(walkerFreshness({ freshness: "live", latest_live_reading_at: "2026-10-07T15:58:00Z" }, nowMs).state).toBe("current");
  });

  it("reports a feed with no readings yet as awaiting data, not offline", () => {
    const result = walkerFreshness({ freshness: "awaiting_publisher", latest_live_reading_at: null }, nowMs);
    expect(result.state).toBe("unknown");
  });
});
