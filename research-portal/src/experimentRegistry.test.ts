import { describe, expect, it } from "vitest";

import {
  experimentCardDescription,
  isCalibrationExperiment,
  portalExperimentById,
  portalExperimentsForRole,
  readingsForExperiment,
  swcCalibrationStartedAt,
} from "./experimentRegistry";
import type { PairingRow, SensorReading } from "./types";

function pairing(overrides: Partial<PairingRow> = {}): PairingRow {
  return {
    id: 1,
    name: "Zone2-Pot41",
    zone: 2,
    pot_number: 41,
    source_sensor_id: 712,
    sensor_key: "D30GQN2D:p",
    source_valve_id: 1625,
    valve_key: "0x24:41",
    wtc_percent_limit: 100,
    valve_open_time_ms: 10_000,
    measurement_interval_ms: 600_000,
    ...overrides,
  };
}

function reading(deviceRecordedAt: string): SensorReading {
  return {
    id: 1,
    event_id: `event-${deviceRecordedAt}`,
    pairing_name: "Zone2-Pot41",
    sensor_key: "D30GQN2D:p",
    raw_value: 2200,
    calibrated_value: 20,
    temperature: 25,
    electrical_conductivity: 100,
    device_recorded_at: deviceRecordedAt,
    server_received_at: deviceRecordedAt,
  };
}

describe("experiment registry", () => {
  it("shows the approved role-specific experiment tiles", () => {
    expect(portalExperimentsForRole("admin").map((experiment) => experiment.id)).toEqual([
      "matt-experiment",
      "matt-experiment-2",
      "swc-saturation-calibration",
    ]);
    expect(portalExperimentsForRole("researcher").map((experiment) => experiment.id)).toEqual([
      "matt-experiment-2",
      "swc-saturation-calibration",
    ]);
    expect(portalExperimentsForRole("viewer").map((experiment) => experiment.id)).toEqual([
      "matt-experiment-2",
      "swc-saturation-calibration",
    ]);
  });

  it("keeps Matt Experiment 1 available to System Admin", () => {
    expect(portalExperimentById("matt-experiment").name).toBe("Matt Experiment 1");
  });

  it("defines the ten exact SWC calibration pots without inheriting the 20-pot group", () => {
    const experiment = portalExperimentById("swc-saturation-calibration");
    expect(isCalibrationExperiment(experiment)).toBe(true);
    expect(experiment.groupNames).toEqual([]);
    expect(experiment.pairingNames).toEqual([
      "Zone2-Pot41",
      "Zone2-Pot43",
      "Zone2-Pot45",
      "Zone2-Pot47",
      "Zone2-Pot49",
      "Zone4-Pot91",
      "Zone4-Pot93",
      "Zone4-Pot95",
      "Zone4-Pot97",
      "Zone4-Pot99",
    ]);
  });

  it("separates historical Matt Experiment 1 readings from the new SWC run", () => {
    const before = reading("2026-07-23T14:46:33.999Z");
    const atStart = reading(swcCalibrationStartedAt);

    expect(readingsForExperiment([before, atStart], portalExperimentById("matt-experiment"))).toEqual([before]);
    expect(readingsForExperiment([before, atStart], portalExperimentById("swc-saturation-calibration"))).toEqual([atStart]);
  });

  it("reports the live SWC settings and changes automatically to sensing-only", () => {
    const experiment = portalExperimentById("swc-saturation-calibration");
    expect(experimentCardDescription(experiment, [pairing()])).toBe("100% target · 10 s / 10 min");
    expect(experimentCardDescription(experiment, [
      pairing({ wtc_percent_limit: -999_999, valve_open_time_ms: 0 }),
    ])).toBe("Sensing only");
  });
});
