import { describe, expect, it } from "vitest";
import {
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
