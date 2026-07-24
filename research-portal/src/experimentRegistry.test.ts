import { describe, expect, it } from "vitest";

import {
  experimentCardDescription,
  isCalibrationExperiment,
  mergePortalExperiments,
  portalExperimentById,
  portalExperimentsForRole,
  readingsForExperiment,
  type PortalExperiment,
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
  const startedAt = "2026-07-23T14:46:34.000Z";
  const history: PortalExperiment = {
    id: "history",
    name: "Historical trial",
    shortDescription: "",
    mode: "controlled",
    wateringState: "off",
    groupNames: [],
    pairingNames: ["Zone2-Pot41"],
    endedAt: startedAt,
  };
  const calibration: PortalExperiment = {
    id: "calibration",
    name: "Calibration",
    shortDescription: "",
    mode: "calibration",
    wateringState: "off",
    groupNames: [],
    pairingNames: ["Zone2-Pot41"],
    startedAt,
  };

  it("does not embed installation-specific experiment fallbacks", () => {
    expect(portalExperimentsForRole("admin")).toEqual([]);
    expect(portalExperimentsForRole("researcher")).toEqual([]);
    expect(portalExperimentById("missing").id).toBe("unavailable");
  });

  it("merges only supplied catalog records", () => {
    expect(mergePortalExperiments([], [history, calibration])).toEqual([
      history,
      calibration,
    ]);
    expect(isCalibrationExperiment(calibration)).toBe(true);
  });

  it("separates historical Matt Experiment 1 readings from the new SWC run", () => {
    const before = reading("2026-07-23T14:46:33.999Z");
    const atStart = reading(startedAt);

    expect(readingsForExperiment([before, atStart], history)).toEqual([before]);
    expect(readingsForExperiment([before, atStart], calibration)).toEqual([atStart]);
  });

  it("reports the live SWC settings and changes automatically to sensing-only", () => {
    const activeCalibration = { ...calibration, wateringState: "controller_managed" as const };
    expect(experimentCardDescription(activeCalibration, [pairing()])).toBe("100% target · 10 s / 10 min");
    expect(experimentCardDescription(activeCalibration, [
      pairing({ wtc_percent_limit: -999_999, valve_open_time_ms: 0 }),
    ])).toBe("Sensing only");
  });
});
