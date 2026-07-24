import { randomUUID } from "node:crypto";

const MINUTES_PER_HOUR = 60;

function requiredNumber(value, label, minimum = 0) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum) {
    throw new Error(`${label} must be at least ${minimum}`);
  }
  return number;
}

function clone(value) {
  return structuredClone(value);
}

export class ControllerSimulator {
  constructor({
    projectId = "simulated-project",
    deviceId = "simulated-device",
    startAt = "2026-01-01T00:00:00.000Z",
    evaporationPerMinute = 0.01,
    deliveryMlPerSecond = 4.2,
    vwcPointsPerMl = 0.02,
  } = {}) {
    this.projectId = projectId;
    this.deviceId = deviceId;
    this.nowMs = Date.parse(startAt);
    if (!Number.isFinite(this.nowMs)) throw new Error("startAt must be an ISO timestamp");
    this.evaporationPerMinute = requiredNumber(evaporationPerMinute, "evaporationPerMinute");
    this.deliveryMlPerSecond = requiredNumber(deliveryMlPerSecond, "deliveryMlPerSecond");
    this.vwcPointsPerMl = requiredNumber(vwcPointsPerMl, "vwcPointsPerMl");
    this.pots = new Map();
    this.events = [];
    this.operations = [];
  }

  loadExperiment(specification) {
    if (!specification || typeof specification !== "object") {
      throw new Error("Experiment specification is required");
    }
    if (!Array.isArray(specification.assignments) || specification.assignments.length === 0) {
      throw new Error("Experiment requires at least one assignment");
    }

    const names = new Set();
    for (const assignment of specification.assignments) {
      const pairingName = String(assignment.pairing_name || "").trim();
      if (!pairingName) throw new Error("Each assignment requires pairing_name");
      if (names.has(pairingName)) throw new Error(`Duplicate assignment: ${pairingName}`);
      names.add(pairingName);

      this.pots.set(pairingName, {
        experimentId: String(specification.id || specification.slug || "simulated-experiment"),
        pairingName,
        potNumber: Number(assignment.pot_number),
        targetVwcPercent: requiredNumber(
          assignment.target_vwc_percent,
          `${pairingName} target_vwc_percent`,
        ),
        measurementIntervalMinutes: requiredNumber(
          assignment.measurement_interval_minutes,
          `${pairingName} measurement_interval_minutes`,
          0.5,
        ),
        valveOpenSeconds: requiredNumber(
          assignment.valve_open_seconds ?? specification.valve_open_seconds ?? 10,
          `${pairingName} valve_open_seconds`,
          0.1,
        ),
        wateringEnabled: assignment.watering_enabled ?? specification.watering_enabled ?? false,
        vwcPercent: requiredNumber(
          assignment.initial_vwc_percent ?? assignment.target_vwc_percent,
          `${pairingName} initial_vwc_percent`,
        ),
        lastMeasuredAtMs: null,
        lastWateredAtMs: null,
        wateringHistoryMs: [],
        deliveryMode: assignment.delivery_mode || "normal",
      });
    }

    return this.snapshot();
  }

  setDeliveryMode(pairingName, deliveryMode) {
    const pot = this.pots.get(pairingName);
    if (!pot) throw new Error(`Unknown pairing: ${pairingName}`);
    if (!["normal", "blocked", "misdirected"].includes(deliveryMode)) {
      throw new Error(`Unsupported delivery mode: ${deliveryMode}`);
    }
    pot.deliveryMode = deliveryMode;
  }

  advance(minutes) {
    const elapsedMinutes = requiredNumber(minutes, "minutes", 0.01);
    this.nowMs += elapsedMinutes * 60_000;

    for (const pot of this.pots.values()) {
      pot.vwcPercent = Math.max(
        0,
        pot.vwcPercent - this.evaporationPerMinute * elapsedMinutes,
      );
      const due = pot.lastMeasuredAtMs === null
        || this.nowMs - pot.lastMeasuredAtMs >= pot.measurementIntervalMinutes * 60_000;
      if (due) this.#measureAndDecide(pot);
    }
    return this.snapshot();
  }

  #measureAndDecide(pot) {
    const recordedVwc = Number(pot.vwcPercent.toFixed(3));
    pot.lastMeasuredAtMs = this.nowMs;
    this.events.push({
      type: "sensor_reading",
      pairing_name: pot.pairingName,
      recorded_at: new Date(this.nowMs).toISOString(),
      vwc_percent: recordedVwc,
    });

    if (!pot.wateringEnabled || recordedVwc >= pot.targetVwcPercent) return;

    const recent = pot.wateringHistoryMs.filter(
      (timestamp) => this.nowMs - timestamp < MINUTES_PER_HOUR * 60_000,
    );
    pot.wateringHistoryMs = recent;
    const intervalSatisfied = pot.lastWateredAtMs === null
      || this.nowMs - pot.lastWateredAtMs >= 30 * 60_000;
    if (!intervalSatisfied || recent.length >= 2) {
      this.events.push({
        type: "watering_suppressed",
        pairing_name: pot.pairingName,
        recorded_at: new Date(this.nowMs).toISOString(),
        reason: intervalSatisfied ? "hourly_limit" : "minimum_interval",
      });
      return;
    }

    const operationId = randomUUID();
    const deliveredMl = pot.deliveryMode === "normal"
      ? pot.valveOpenSeconds * this.deliveryMlPerSecond
      : 0;
    const verificationResult = deliveredMl > 0 ? "verified" : "mismatch";

    this.operations.push({
      id: operationId,
      capability_id: "watering.manual",
      approval_state: "approved",
      execution_state: deliveredMl > 0 ? "verified" : "completed_unverified",
      verification_state: verificationResult,
      pairing_name: pot.pairingName,
      created_at: new Date(this.nowMs).toISOString(),
    });
    this.events.push({
      type: "valve_event",
      operation_id: operationId,
      pairing_name: pot.pairingName,
      recorded_at: new Date(this.nowMs).toISOString(),
      duration_seconds: pot.valveOpenSeconds,
    });
    this.events.push({
      type: "delivery_evidence",
      operation_id: operationId,
      pairing_name: pot.pairingName,
      recorded_at: new Date(this.nowMs).toISOString(),
      evidence_type: "simulator",
      delivered_ml: deliveredMl,
      verification_result: verificationResult,
    });

    pot.lastWateredAtMs = this.nowMs;
    pot.wateringHistoryMs.push(this.nowMs);
    if (pot.deliveryMode === "normal") {
      pot.vwcPercent += deliveredMl * this.vwcPointsPerMl;
    }
  }

  snapshot() {
    return clone({
      project_id: this.projectId,
      device_id: this.deviceId,
      recorded_at: new Date(this.nowMs).toISOString(),
      pots: [...this.pots.values()],
      events: this.events,
      operations: this.operations,
    });
  }
}
