import { describe, expect, it } from "vitest";

import {
  activeExperimentPotOccupancy,
  experimentCardDescription,
  isCalibrationExperiment,
  mergePortalExperiments,
  portalExperimentById,
  portalExperimentsForRole,
  readingsForExperiment,
  type PortalExperiment,
} from "./experimentRegistry";
import { experimentDraftFromPortalExperiment } from "./experimentSpec";
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

  it("hydrates edit drafts from the immutable current revision", () => {
    const currentSpec = {
      name: "Current revision",
      description: "Revision-backed settings",
      mode: "controlled" as const,
      start_date: "2026-07-23",
      assignments: [{
        pairing_name: "Zone2-Pot41",
        crop: "Maize",
        treatment: "Drought",
        block: "B1",
        substrate: "Sand",
        watering_enabled: true,
        target_vwc_percent: 31,
        valve_open_seconds: 7,
        measurement_interval_minutes: 8,
        notes: "Keep",
      }],
      visibility_roles: ["admin", "researcher"] as Array<"admin" | "researcher">,
      controller_changes_requested: true,
      questions: [],
    };
    const draft = experimentDraftFromPortalExperiment({
      ...history,
      name: "Editable trial",
      shortDescription: "Updated description",
      currentRevisionId: "00000000-0000-4000-8000-000000000001",
      currentVersion: 4,
      currentSpec,
    }, [pairing()]);

    expect(draft.name).toBe("Editable trial");
    expect(draft.description).toBe("Updated description");
    expect(draft.assignments[0]).toMatchObject({
      crop: "Maize",
      watering_enabled: true,
      target_vwc_percent: 31,
      valve_open_seconds: 7,
    });
    draft.assignments[0].crop = "Changed locally";
    expect(currentSpec.assignments[0].crop).toBe("Maize");
  });

  it("hydrates legacy revisions without blanking the editor", () => {
    const draft = experimentDraftFromPortalExperiment({
      ...history,
      name: "Matt Experiment 2",
      shortDescription: "24 pots · 30% target",
      currentSpec: {
        name: "Matt Experiment 2",
        mode: "controlled",
        watering_state: "controller_managed",
      } as unknown as PortalExperiment["currentSpec"],
      assignments: [{
        pairing_name: "Zone2-Pot41",
        zone: 2,
        pot_number: 41,
        crop: "Maize",
        treatment: "Control",
        block: "B1",
        substrate: "Soil",
        target_vwc_percent: 30,
        measurement_interval_minutes: 10,
      }],
    }, [pairing({ wtc_percent_limit: 30 })]);

    expect(draft.name).toBe("Matt Experiment 2");
    expect(draft.assignments).toEqual([
      expect.objectContaining({
        pairing_name: "Zone2-Pot41",
        crop: "Maize",
        treatment: "Control",
        watering_enabled: true,
        target_vwc_percent: 30,
        valve_open_seconds: 10,
      }),
    ]);
  });

  it("marks only other active experiment pots as occupied", () => {
    const occupancy = activeExperimentPotOccupancy([
      {
        ...history,
        id: "current",
        databaseId: "00000000-0000-4000-8000-000000000001",
        status: "active",
      },
      {
        ...calibration,
        id: "other-active",
        databaseId: "00000000-0000-4000-8000-000000000002",
        name: "Active calibration",
        status: "active",
      },
      {
        ...history,
        id: "completed",
        databaseId: "00000000-0000-4000-8000-000000000003",
        status: "completed",
      },
    ], "00000000-0000-4000-8000-000000000001");

    expect(occupancy.get("Zone2-Pot41")).toEqual([{
      experimentId: "00000000-0000-4000-8000-000000000002",
      experimentName: "Active calibration",
    }]);
  });
});
