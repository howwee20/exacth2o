import { describe, expect, it } from "vitest";
import { fitCalibration, nearestCalibrationReading } from "./calibrationFit";
import type { SensorReading } from "./types";

function reading(id: number, pairingName: string, recordedAt: string, rawValue: number): SensorReading {
  return {
    id,
    event_id: `event-${id}`,
    pairing_name: pairingName,
    sensor_key: "sensor-y",
    raw_value: rawValue,
    calibrated_value: rawValue,
    temperature: null,
    electrical_conductivity: null,
    device_recorded_at: recordedAt,
    server_received_at: recordedAt,
  };
}

describe("nearestCalibrationReading", () => {
  it("matches the nearest reading for the selected pot within tolerance", () => {
    const match = nearestCalibrationReading([
      reading(1, "Zone1-Pot15", "2026-07-22T12:00:00Z", 300),
      reading(2, "Zone1-Pot15", "2026-07-22T12:03:00Z", 310),
      reading(3, "Zone1-Pot16", "2026-07-22T12:01:00Z", 999),
    ], "Zone1-Pot15", "2026-07-22T12:02:10Z", 120);

    expect(match?.reading.id).toBe(2);
    expect(match?.deltaSeconds).toBe(50);
  });

  it("fails closed when no reading is inside the match window", () => {
    expect(nearestCalibrationReading([
      reading(1, "Zone1-Pot15", "2026-07-22T12:00:00Z", 300),
    ], "Zone1-Pot15", "2026-07-22T12:10:00Z", 60)).toBeNull();
  });
});

describe("fitCalibration", () => {
  it("recovers a deterministic linear equation", () => {
    const result = fitCalibration(Array.from({ length: 25 }, (_, index) => ({
      rawValue: index * 2 + 100,
      referenceValue: 5 + 0.25 * (index * 2 + 100),
    })));
    expect(result.fitType).toBe("linear");
    expect(result.coefficients[0]).toBeCloseTo(5, 8);
    expect(result.coefficients[1]).toBeCloseTo(0.25, 8);
    expect(result.rmse).toBeCloseTo(0, 8);
    expect(result.readyToSet).toBe(true);
  });

  it("uses a quadratic only when it materially improves the fit", () => {
    const result = fitCalibration(Array.from({ length: 25 }, (_, index) => {
      const rawValue = 100 + index * 4;
      return { rawValue, referenceValue: 8 + 0.1 * rawValue + 0.002 * rawValue ** 2 };
    }));
    expect(result.fitType).toBe("quadratic");
    expect(result.coefficients[0]).toBeCloseTo(8, 6);
    expect(result.coefficients[1]).toBeCloseTo(0.1, 6);
    expect(result.coefficients[2]).toBeCloseTo(0.002, 8);
  });
});
