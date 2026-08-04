import { describe, expect, it } from "vitest";

import {
  booleanMarker,
  healthEvidenceValue,
  mergeReadings,
  mergeRollingExperimentReadings,
  pairingsFromDeviceConfigState,
  resolveEffectiveMode,
  rollingExperimentHistoryStart,
  sumKnownCounts,
  visibleExperimentPairings,
} from "./portalData";
import { withSupabaseTimeout } from "./supabaseTimeout";
import {
  advanceCurrentBootUptime,
  reconstructCurrentBootUptime,
  restartOutagePresentation,
} from "./healthUptime";
import type { PairingRow, SensorReading } from "./types";

function reading(overrides: Partial<SensorReading>): SensorReading {
  return {
    id: 1,
    event_id: "live-device:1",
    pairing_name: "Pot 41",
    sensor_key: "sensor-41",
    raw_value: 100,
    calibrated_value: 25,
    temperature: null,
    electrical_conductivity: null,
    device_recorded_at: "2026-07-09T12:00:00.000Z",
    server_received_at: "2026-07-09T12:00:01.000Z",
    ...overrides,
  };
}

function pairing(overrides: Partial<PairingRow>): PairingRow {
  return {
    id: 1,
    name: "Pot 41",
    zone: 2,
    pot_number: 41,
    source_sensor_id: 41,
    sensor_key: "sensor-41",
    source_valve_id: 141,
    valve_key: "valve-41",
    wtc_percent_limit: 25,
    valve_open_time_ms: 5000,
    measurement_interval_ms: 600000,
    ...overrides,
  };
}

describe("portal data mode", () => {
  it("falls back to the imported snapshot when no fresh live reading exists", () => {
    expect(resolveEffectiveMode("auto", false)).toBe("snapshot");
    expect(resolveEffectiveMode("auto", true)).toBe("live");
  });
});

describe("reading merge", () => {
  it("deduplicates by event id and retains the incoming version", () => {
    const existing = reading({ calibrated_value: 20 });
    const incoming = reading({ calibrated_value: 26 });
    const merged = mergeReadings([existing], [incoming]);

    expect(merged).toHaveLength(1);
    expect(merged[0].calibrated_value).toBe(26);
  });

  it("keeps a rolling 72-hour experiment window", () => {
    const nowMs = Date.parse("2026-08-04T12:00:00.000Z");
    const insideWindow = reading({
      id: 2,
      event_id: "live-device:inside",
      device_recorded_at: "2026-08-01T12:00:00.000Z",
    });
    const outsideWindow = reading({
      id: 3,
      event_id: "live-device:outside",
      device_recorded_at: "2026-08-01T11:59:59.999Z",
    });

    expect(rollingExperimentHistoryStart(nowMs)).toBe("2026-08-01T12:00:00.000Z");
    expect(mergeRollingExperimentReadings([], [outsideWindow, insideWindow], nowMs))
      .toEqual([insideWindow]);
  });
});

describe("diagnostic filtering", () => {
  it("removes known diagnostic sensor rows without hiding experiment pairings", () => {
    const visible = pairing({ id: 1 });
    const diagnostic = pairing({
      id: 720,
      name: "CWD-LowercaseT",
      source_sensor_id: 720,
      sensor_key: "D30GQN2D:t",
    });

    expect(visibleExperimentPairings([visible, diagnostic])).toEqual([visible]);
  });

  it("keeps Matt Experiment 2 Pot 70 and its readings when it reuses sensor address T", () => {
    const pot70 = pairing({
      id: 692,
      name: "Zone3-Pot70",
      source_sensor_id: 692,
      sensor_key: "D30GQN2D:T",
      source_valve_id: 1558,
      valve_key: "0x20:22",
    });
    const pot70Reading = reading({
      id: 692,
      event_id: "live-device:pot70",
      pairing_name: "Zone3-Pot70",
      sensor_key: "D30GQN2D:T",
    });

    expect(visibleExperimentPairings([pot70])).toEqual([pot70]);
    expect(mergeReadings([], [pot70Reading])).toEqual([pot70Reading]);
  });

});

describe("authoritative controller pairings", () => {
  it("normalizes live controller config without using the stale pairings table", () => {
    const normalized = pairingsFromDeviceConfigState([
      {
        name: "Zone2-Pot42",
        Sensor: { boardSerialId: "D30GQN2D", address: "q" },
        Valve: { relayAddress: "0x24", address: "42" },
        sensorId: 713,
        valveId: 1626,
        groupId: 2,
        calibrationId: 4,
        Calibration: { name: "Corrected Calibration (+10)" },
        WTCPercentLimit: 5,
        ValveOpenTime: 2000,
        MeasurementInterval: 600000,
      },
    ], [{ id: 2, name: "Matt's 20 pots" }]);

    expect(normalized).toEqual([
      expect.objectContaining({
        name: "Zone2-Pot42",
        zone: 2,
        pot_number: 42,
        sensor_key: "D30GQN2D:q",
        valve_key: "0x24:42",
        wtc_percent_limit: 5,
        valve_open_time_ms: 2000,
        measurement_interval_ms: 600000,
        group_name: "Matt's 20 pots",
        calibration_name: "Corrected Calibration (+10)",
      }),
    ]);
  });
});

describe("Supabase timeout", () => {
  it("aborts the underlying request and returns a stable timeout error", async () => {
    let aborted = false;
    const request = (signal: AbortSignal) => new Promise<never>((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        aborted = true;
        reject(new Error("underlying request aborted"));
      }, { once: true });
    });

    await expect(withSupabaseTimeout(request, 5, "Readings query")).rejects.toThrow(
      "Readings query timed out",
    );
    expect(aborted).toBe(true);
  });
});

describe("compact health evidence", () => {
  it("keeps missing boolean evidence out of healthy chart markers", () => {
    expect(booleanMarker(null, 85, 0)).toBeNull();
    expect(booleanMarker(undefined, 85, 0)).toBeNull();
    expect(booleanMarker(false, 85, 0)).toBe(0);
    expect(booleanMarker(true, 85, 0)).toBe(85);
  });

  it("does not turn unknown stale or missing counts into zero", () => {
    expect(sumKnownCounts(0, 0)).toBe(0);
    expect(sumKnownCounts(2, 1)).toBe(3);
    expect(sumKnownCounts(null, 0)).toBeNull();
  });

  it("prefers fresh runtime owner evidence over compact snapshot evidence", () => {
    expect(healthEvidenceValue({
      snapshotStatus: { throttled_flags: "snapshot" },
      snapshotHealth: null,
      runtimeStatus: { throttled_flags: "runtime-status" },
      runtimeHealth: { ownerStatus: { throttled_flags: "runtime-owner" } },
      runtimeFresh: true,
    }, "throttled_flags")).toBe("runtime-owner");
  });

  it("ignores stale runtime evidence and falls back to snapshot evidence", () => {
    expect(healthEvidenceValue({
      snapshotStatus: { undervoltage_occurred: false },
      snapshotHealth: null,
      runtimeStatus: { undervoltage_occurred: true },
      runtimeHealth: null,
      runtimeFresh: false,
    }, "undervoltage_occurred")).toBe(false);
  });

  it("reads fresh top-level runtime health evidence when no owner block exists", () => {
    expect(healthEvidenceValue({
      snapshotStatus: null,
      snapshotHealth: null,
      runtimeStatus: null,
      runtimeHealth: { undervoltage_occurred: true },
      runtimeFresh: true,
    }, "undervoltage_occurred")).toBe(true);
  });
});

describe("uptime history", () => {
  it("shows a resolved monitoring gap as recovered instead of requiring review", () => {
    expect(restartOutagePresentation(true, 0, 1)).toEqual({
      detail: "Monitoring gap recovered; the controller is reporting again.",
      badge: "Recovered",
      badgeTone: "ok",
    });
  });

  it("continues to flag an observed restart for review", () => {
    expect(restartOutagePresentation(true, 1, 0)).toMatchObject({
      badge: "Review",
      badgeTone: "warning",
    });
  });

  it("shows a restart as recovered once fresh healthy telemetry resumes", () => {
    expect(restartOutagePresentation(true, 1, 1, true)).toEqual({
      detail: "Restart recorded; telemetry recovered and the controller is reporting again.",
      badge: "Recovered",
      badgeTone: "ok",
    });
  });

  it("advances fresh uptime between synchronized observations", () => {
    expect(advanceCurrentBootUptime(
      600,
      "2026-07-10T15:00:00.000Z",
      "2026-07-10T15:01:30.000Z",
    )).toBe(690);
  });

  it("reconstructs missing samples only within the currently observed boot", () => {
    const observedAt = "2026-07-10T02:30:00.000Z";
    const records = reconstructCurrentBootUptime([
      { t: "2026-07-10T00:30:00.000Z", uptimeSeconds: null },
      { t: "2026-07-10T01:30:00.000Z", uptimeSeconds: null },
      { t: observedAt, uptimeSeconds: null },
    ], 318 * 60 * 60, observedAt);

    expect(records.map((record) => record.uptimeSeconds)).toEqual([
      316 * 60 * 60,
      317 * 60 * 60,
      318 * 60 * 60,
    ]);
  });

  it("preserves observed values and does not infer across the current boot", () => {
    const records = reconstructCurrentBootUptime([
      { t: "2026-07-10T00:00:00.000Z", uptimeSeconds: null },
      { t: "2026-07-10T01:45:00.000Z", uptimeSeconds: 875 },
      { t: "2026-07-10T02:00:00.000Z", uptimeSeconds: null },
      { t: "2026-07-10T02:05:00.000Z", uptimeSeconds: null },
    ], 30 * 60, "2026-07-10T02:00:00.000Z");

    expect(records.map((record) => record.uptimeSeconds)).toEqual([
      null,
      875,
      1800,
      null,
    ]);
  });
});
