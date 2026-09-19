import { describe, expect, it } from "vitest";

import {
  controllerPresence,
  hardwareInventory,
  middleEllipsis,
  parseValveIdentity,
  relativeAgeText,
  sensorsReportingText,
} from "./settingsPresentation";
import type { PairingRow, SensorReading } from "./types";

const now = Date.parse("2026-09-19T20:00:00.000Z");

function pairing(overrides: Partial<PairingRow>): PairingRow {
  return {
    id: 1,
    name: "Zone2-Pot41",
    zone: 2,
    pot_number: 41,
    source_sensor_id: 41,
    sensor_key: "D30GQN2E:y",
    source_valve_id: 141,
    valve_key: "0x20:49",
    wtc_percent_limit: 25,
    valve_open_time_ms: 5000,
    measurement_interval_ms: 600000,
    ...overrides,
  };
}

describe("controller presence", () => {
  it("reports online only while the mirrored state is still fresh", () => {
    const presence = controllerPresence({
      stateFreshUntil: "2026-09-19T20:05:00.000Z",
      stateObservedAt: "2026-09-19T19:59:00.000Z",
      controllerState: "RUNNING",
    }, now);
    expect(presence.status).toBe("online");
    expect(presence.controllerState).toBe("Running");
  });

  it("reports offline with the last-seen age once the state is stale", () => {
    const presence = controllerPresence({
      stateFreshUntil: "2026-09-19T16:05:00.000Z",
      stateObservedAt: "2026-09-19T16:00:00.000Z",
      controllerState: "running",
    }, now);
    expect(presence.status).toBe("offline");
    expect(presence.tone).toBe("warning");
    expect(presence.detail).toContain("4 hr ago");
    expect(presence.detail).toContain("last known state");
  });

  it("falls back to the device last-seen time and never claims online without freshness", () => {
    const presence = controllerPresence({ lastSeenAt: "2026-09-19T19:59:30.000Z" }, now);
    expect(presence.status).toBe("offline");
    expect(controllerPresence({}, now).status).toBe("never");
  });
});

describe("researcher-facing formatting", () => {
  it("describes ages in plain language", () => {
    expect(relativeAgeText("2026-09-19T19:59:40.000Z", now)).toBe("just now");
    expect(relativeAgeText("2026-09-19T19:15:00.000Z", now)).toBe("45 min ago");
    expect(relativeAgeText("2026-09-16T20:00:00.000Z", now)).toBe("3 days ago");
    expect(relativeAgeText(null, now)).toBeNull();
  });

  it("summarizes sensors reporting", () => {
    expect(sensorsReportingText(22, 24)).toBe("22 of 24");
    expect(sensorsReportingText(null, 24)).toBeNull();
  });

  it("shortens long identifiers in the middle so both ends stay readable", () => {
    const shortened = middleEllipsis("matt-balena-controller-4174753-greenhouse", 20);
    expect(shortened.length).toBeLessThanOrEqual(20);
    expect(shortened.startsWith("matt-")).toBe(true);
    expect(shortened.endsWith("house")).toBe(true);
    expect(middleEllipsis("short-id", 20)).toBe("short-id");
  });
});

describe("hardware inventory", () => {
  it("parses board address and channel from a valve identity", () => {
    expect(parseValveIdentity("0x20:49")).toEqual({ board: "0x20", channel: "49" });
    expect(parseValveIdentity("valve-41")).toEqual({ board: null, channel: null });
  });

  it("keeps discovered identity separate from the typed label", () => {
    const readings = [
      { sensor_key: "D30GQN2E:y", device_recorded_at: "2026-09-19T15:00:00.000Z" },
      { sensor_key: "D30GQN2E:y", device_recorded_at: "2026-09-19T16:00:00.000Z" },
    ] as SensorReading[];
    const inventory = hardwareInventory(
      [pairing({}), pairing({ id: 2, name: "Zone2-Pot42", pot_number: 42, sensor_key: "D30GQN2E:z", valve_key: "0x20:50" })],
      readings,
    );
    expect(inventory.sensors).toHaveLength(2);
    expect(inventory.sensors[0]).toMatchObject({
      identity: "D30GQN2E:y",
      label: "Zone2-Pot41",
      lastReadingAt: "2026-09-19T16:00:00.000Z",
    });
    expect(inventory.sensors[1].lastReadingAt).toBeNull();
    expect(inventory.valves[1]).toMatchObject({ identity: "0x20:50", board: "0x20", channel: "50" });
  });
});
