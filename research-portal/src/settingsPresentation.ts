import type { PairingRow, SensorReading } from "./types";

export type StatusTone = "ok" | "warning" | "bad" | "unknown" | "info";

export type ControllerPresenceInput = {
  stateFreshUntil?: string | null;
  stateObservedAt?: string | null;
  controllerState?: string | null;
  lastSeenAt?: string | null;
};

export type ControllerPresence = {
  status: "online" | "offline" | "never";
  tone: StatusTone;
  label: string;
  detail: string;
  lastSeenAt: string | null;
  controllerState: string | null;
};

function parseTime(value?: string | null) {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

export function relativeAgeText(value: string | number | null | undefined, nowMs = Date.now()) {
  const time = typeof value === "number" ? value : parseTime(value);
  if (time == null || !Number.isFinite(time)) return null;
  const seconds = Math.max(0, Math.round((nowMs - time) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  return `${days} days ago`;
}

function titleCase(value: string) {
  const lower = value.trim().toLowerCase();
  return lower ? lower[0].toUpperCase() + lower.slice(1) : "";
}

// The controller mirror is only trusted while `state_fresh_until` is in the
// future. After that the portal is showing the last known state, not live state.
export function controllerPresence(input: ControllerPresenceInput, nowMs = Date.now()): ControllerPresence {
  const freshUntil = parseTime(input.stateFreshUntil);
  const observedAt = parseTime(input.stateObservedAt) ?? parseTime(input.lastSeenAt);
  const lastSeenAt = observedAt == null ? null : new Date(observedAt).toISOString();
  const controllerState = input.controllerState?.trim() ? titleCase(input.controllerState) : null;

  if (observedAt == null) {
    return {
      status: "never",
      tone: "unknown",
      label: "No controller data",
      detail: "The controller has not reported to the portal yet.",
      lastSeenAt: null,
      controllerState,
    };
  }

  if (freshUntil != null && freshUntil > nowMs) {
    return {
      status: "online",
      tone: "ok",
      label: "Online",
      detail: `Last seen ${relativeAgeText(observedAt, nowMs)}.`,
      lastSeenAt,
      controllerState,
    };
  }

  return {
    status: "offline",
    tone: "warning",
    label: "Offline",
    detail: `Last seen ${relativeAgeText(observedAt, nowMs)}. Showing the last known state.`,
    lastSeenAt,
    controllerState,
  };
}

export function sensorsReportingText(current?: number | null, expected?: number | null) {
  const hasCurrent = current != null && Number.isFinite(current);
  const hasExpected = expected != null && Number.isFinite(expected);
  if (hasCurrent && hasExpected) return `${Math.trunc(current)} of ${Math.trunc(expected)}`;
  if (hasCurrent) return `${Math.trunc(current)}`;
  return null;
}

export function middleEllipsis(value: string, maxLength = 22) {
  if (value.length <= maxLength) return value;
  const keep = Math.max(4, maxLength - 1);
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return `${value.slice(0, head)}…${value.slice(value.length - tail)}`;
}

export type HardwareSensor = {
  identity: string;
  sourceId: number | null;
  label: string | null;
  potNumber: number | null;
  lastReadingAt: string | null;
};

export type HardwareValve = {
  identity: string;
  board: string | null;
  channel: string | null;
  sourceId: number | null;
  label: string | null;
  potNumber: number | null;
};

// Valve outputs are addressed as "<board address>:<channel>", e.g. "0x20:49".
export function parseValveIdentity(valveKey: string) {
  const match = valveKey.trim().match(/^(0x[0-9a-f]+)\s*:\s*(\S+)$/i);
  return match ? { board: match[1].toLowerCase(), channel: match[2] } : { board: null, channel: null };
}

// Identity (what the hardware reports) is kept apart from the label a person typed.
export function hardwareInventory(pairings: PairingRow[], readings: SensorReading[]) {
  const lastReadingBySensor = new Map<string, string>();
  for (const reading of readings) {
    if (!reading.sensor_key) continue;
    const previous = lastReadingBySensor.get(reading.sensor_key);
    if (!previous || reading.device_recorded_at > previous) {
      lastReadingBySensor.set(reading.sensor_key, reading.device_recorded_at);
    }
  }

  const sensors = new Map<string, HardwareSensor>();
  const valves = new Map<string, HardwareValve>();
  for (const pairing of pairings) {
    if (pairing.sensor_key && !sensors.has(pairing.sensor_key)) {
      sensors.set(pairing.sensor_key, {
        identity: pairing.sensor_key,
        sourceId: Number.isFinite(pairing.source_sensor_id) ? pairing.source_sensor_id : null,
        label: pairing.name || null,
        potNumber: Number.isFinite(pairing.pot_number) ? pairing.pot_number : null,
        lastReadingAt: lastReadingBySensor.get(pairing.sensor_key) ?? null,
      });
    }
    if (pairing.valve_key && !valves.has(pairing.valve_key)) {
      valves.set(pairing.valve_key, {
        identity: pairing.valve_key,
        ...parseValveIdentity(pairing.valve_key),
        sourceId: Number.isFinite(pairing.source_valve_id) ? pairing.source_valve_id : null,
        label: pairing.name || null,
        potNumber: Number.isFinite(pairing.pot_number) ? pairing.pot_number : null,
      });
    }
  }

  return { sensors: Array.from(sensors.values()), valves: Array.from(valves.values()) };
}

// "since 3:59 PM" on the same day, "since Sep 19, 3:59 PM" otherwise.
export function sinceText(value: string | null | undefined, nowMs = Date.now(), timeZone?: string) {
  const time = parseTime(value);
  if (time == null) return null;
  const date = new Date(time);
  const day = (input: Date) => input.toLocaleDateString("en-US", { timeZone });
  const clock = date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone });
  if (day(date) === day(new Date(nowMs))) return `since ${clock}`;
  return `since ${date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone })}, ${clock}`;
}

// The single place the controller's connection is stated in Settings.
export function controllerPillText(presence: ControllerPresence, nowMs = Date.now(), timeZone?: string) {
  if (presence.status === "never") return "No controller data yet";
  if (presence.status === "online") return "Controller online";
  const since = sinceText(presence.lastSeenAt, nowMs, timeZone);
  return since ? `Controller offline · ${since}` : "Controller offline";
}

export type OverviewSection = "pairings" | "water" | "autocalibrate" | "hardware";

export type NextAction = {
  tone: StatusTone;
  title: string;
  detail: string;
  section: OverviewSection | null;
  actionLabel: string | null;
};

export type OverviewInput = {
  presence: ControllerPresence["status"];
  pairingCount: number;
  sensorsCurrent: number | null;
  sensorsExpected: number | null;
  wateringEnabled: boolean | null;
  sensingOnly: boolean;
  isAdmin: boolean;
};

// One plain-language answer to "what should I do next?", most urgent first.
export function overviewNextAction(input: OverviewInput): NextAction {
  if (input.presence === "never") {
    return {
      tone: "unknown",
      title: "Waiting for the controller",
      detail: "The controller has not reported to the portal yet. Settings here come from the project records until it connects.",
      section: null,
      actionLabel: null,
    };
  }
  if (input.presence === "offline") {
    return {
      tone: "warning",
      title: "Check the controller's power and network",
      detail: "You can still review everything here. Readings and watering status update as soon as it reconnects.",
      section: null,
      actionLabel: null,
    };
  }
  if (input.pairingCount === 0) {
    return {
      tone: "info",
      title: "Pair your first pot",
      detail: "Nothing can be watered until a valve is paired with the sensor in its pot.",
      section: "pairings",
      actionLabel: "Open Pairings",
    };
  }
  const missing = input.sensorsCurrent != null && input.sensorsExpected != null
    ? Math.max(0, Math.trunc(input.sensorsExpected) - Math.trunc(input.sensorsCurrent))
    : 0;
  if (missing > 0) {
    return {
      tone: "warning",
      title: `${missing} ${missing === 1 ? "sensor is" : "sensors are"} not reporting`,
      detail: "A pot with a silent sensor cannot be watered reliably. Check the sensor's cable and position.",
      section: "hardware",
      actionLabel: "See sensors",
    };
  }
  if (!input.sensingOnly && input.wateringEnabled === false) {
    return {
      tone: "warning",
      title: "Automatic watering is off",
      detail: "Sensors are reporting, but the controller will not water on its own until the experiment is started.",
      section: "water",
      actionLabel: "Open Watering",
    };
  }
  if (input.isAdmin) {
    return {
      tone: "ok",
      title: "Ready. Pairings not yet checked at the bench",
      detail: "Autocalibrate pulses one valve at a time and watches every sensor to confirm which valve waters which pot.",
      section: "autocalibrate",
      actionLabel: "Open Autocalibrate",
    };
  }
  return {
    tone: "ok",
    title: "Everything looks ready",
    detail: "The controller is online and every sensor is reporting.",
    section: null,
    actionLabel: null,
  };
}
