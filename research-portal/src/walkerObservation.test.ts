import { describe, expect, it } from "vitest";
import {
  filterWalkerSensors,
  isWalkerAccessDenied,
  walkerSmallMultipleGroups,
  type WalkerSensor,
  type WalkerTraceSeries,
} from "./walkerObservation";

const sensor = (overrides: Partial<WalkerSensor> = {}): WalkerSensor => ({
  source_sensor_id: 746,
  sensor_key: "D30GQN2S:A",
  display_label: "25-A",
  source_pairing_name: "25-A",
  position_number: 25,
  board_serial_id: "D30GQN2S",
  sensor_address: "A",
  historical_group: "Vegetative Drought",
  first_reading_at: "2026-03-10T04:01:53Z",
  last_reading_at: "2026-07-15T03:59:57Z",
  latest_calibrated_value: 31.2,
  reading_count: 8945,
  quality_flags: {},
  ...overrides,
});

describe("Walker observation helpers", () => {
  it("recognizes backend authorization denials", () => {
    expect(isWalkerAccessDenied({ code: "42501" })).toBe(true);
    expect(isWalkerAccessDenied({ message: "observation access required" })).toBe(true);
    expect(isWalkerAccessDenied({ code: "500" })).toBe(false);
  });

  it("filters only verified sensor metadata", () => {
    const sensors = [
      sensor(),
      sensor({
        source_sensor_id: 794,
        display_label: "72-x",
        source_pairing_name: "72-x",
        position_number: 72,
        board_serial_id: "D30GQN2F",
        historical_group: null,
      }),
    ];
    expect(filterWalkerSensors(sensors, "25", "all", "all")).toHaveLength(1);
    expect(filterWalkerSensors(sensors, "", "D30GQN2F", "all")).toHaveLength(1);
    expect(filterWalkerSensors(sensors, "", "all", "Ungrouped")).toHaveLength(1);
  });

  it("partitions 96 traces into six 16-trace panels", () => {
    const traces = Array.from({ length: 96 }, (_, index) => ({
      source_sensor_id: 700 + index,
      display_label: String(index + 1),
      source_pairing_name: String(index + 1),
      board_serial_id: index < 48 ? "D30GQN2S" : "D30GQN2F",
      historical_group: null,
      points: [],
    })) satisfies WalkerTraceSeries[];
    const groups = walkerSmallMultipleGroups(traces);
    expect(groups).toHaveLength(6);
    expect(groups.every((group) => group.series.length === 16)).toBe(true);
  });
});
