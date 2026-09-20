import { createRng, type Rng } from "./random";

// INTERNAL TEST INFRASTRUCTURE. Not part of the product and not shipped in the
// portal bundle. Nothing in this module talks to a controller, a database, or
// the network. It models a bench of pots so the discovery workflow can be
// exercised while no hardware is involved.

export const maxSimulatedPots = 100;
export const minSimulatedPots = 8;

export type PresetId =
  | "clean-24"
  | "clean-100"
  | "noisy"
  | "disconnected-hose"
  | "bad-sensor"
  | "cross-talk"
  | "swapped-hoses"
  | "difficult-soil";

export type SimPreset = {
  id: PresetId;
  label: string;
  description: string;
  defaultPotCount: number;
};

export const simPresets: SimPreset[] = [
  {
    id: "clean-24",
    label: "Clean 24-pot installation",
    description: "Every sensor and hose is healthy. The expected result is a complete, high-confidence mapping.",
    defaultPotCount: 24,
  },
  {
    id: "clean-100",
    label: "Clean 100-pot installation",
    description: "The same healthy installation at the largest supported size.",
    defaultPotCount: 100,
  },
  {
    id: "noisy",
    label: "Noisy installation",
    description: "Higher sensor noise everywhere, two sensors too noisy to trust, and one pot that responds erratically.",
    defaultPotCount: 24,
  },
  {
    id: "disconnected-hose",
    label: "Disconnected hose",
    description: "One hose waters nothing, one valve never opens, and one line delivers weak flow.",
    defaultPotCount: 24,
  },
  {
    id: "bad-sensor",
    label: "Bad sensors",
    description: "One sensor is unreachable, one reports raw counts, one is stuck on a value, and one pot is already saturated.",
    defaultPotCount: 24,
  },
  {
    id: "cross-talk",
    label: "Cross-talk and ambiguous plumbing",
    description: "Two hoses leak into a neighboring pot, one hose is split between two pots, and two valves feed the same pot.",
    defaultPotCount: 24,
  },
  {
    id: "swapped-hoses",
    label: "Swapped hoses",
    description: "The recorded pairings are wrong for two pairs of pots because their hoses were swapped during installation.",
    defaultPotCount: 24,
  },
  {
    id: "difficult-soil",
    label: "Difficult soil",
    description: "One pot responds too slowly to settle in the observation window and one small pot overshoots.",
    defaultPotCount: 24,
  },
];

export type SensorFault = "none" | "dead" | "raw_counts" | "flatlined" | "noisy";
export type ValveFault = "none" | "stuck_closed" | "weak_flow" | "disconnected_hose";

export type SimPot = {
  index: number;
  label: string;
  baseVwc: number;
  saturationVwc: number;
  gainPerSecond: number;
  lagSeconds: number;
  tauSeconds: number;
  dryingPerMinute: number;
  erratic: boolean;
  overshootFraction: number;
};

export type SimSensor = {
  index: number;
  id: string;
  noiseSigma: number;
  fault: SensorFault;
};

export type SimHoseTarget = { potIndex: number; share: number };

export type SimValve = {
  index: number;
  id: string;
  fault: ValveFault;
  targets: SimHoseTarget[];
};

export type RecordedPairing = {
  valveId: string;
  sensorId: string;
  potLabel: string | null;
};

export type SimWorld = {
  seed: number;
  presetId: PresetId;
  source: "synthetic" | "mirror";
  pots: SimPot[];
  sensors: SimSensor[];
  valves: SimValve[];
  // What the configuration says today. Empty for a brand-new installation.
  recordedPairings: RecordedPairing[];
  // The simulator's hidden answer key: the sensor in the pot each valve mainly waters.
  truth: Array<number | null>;
  injectedFaults: string[];
};

export type MirrorPairing = { valveId: string; sensorId: string; potLabel: string | null };

export type BuildWorldOptions = {
  presetId: PresetId;
  seed: number;
  potCount?: number;
  // Read-only copy of the currently configured pairings. When supplied, the
  // simulated installation uses these identities and treats them as recorded.
  mirror?: readonly MirrorPairing[];
};

const serialAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function syntheticSensorId(rng: Rng, index: number) {
  let serial = "";
  for (let position = 0; position < 8; position += 1) {
    serial += serialAlphabet[rng.int(0, serialAlphabet.length - 1)];
  }
  return `${serial}:${"abcdefgh"[index % 8]}`;
}

function syntheticValveId(index: number) {
  const board = 0x20 + Math.floor(index / 16);
  return `0x${board.toString(16)}:${String((index % 16) + 1).padStart(2, "0")}`;
}

export function clampPotCount(value: number) {
  if (!Number.isFinite(value)) return 24;
  return Math.min(maxSimulatedPots, Math.max(minSimulatedPots, Math.round(value)));
}

function dedupeMirror(mirror: readonly MirrorPairing[]) {
  const sensors = new Set<string>();
  const valves = new Set<string>();
  const rows: MirrorPairing[] = [];
  for (const row of mirror) {
    if (!row.sensorId || !row.valveId) continue;
    if (sensors.has(row.sensorId) || valves.has(row.valveId)) continue;
    sensors.add(row.sensorId);
    valves.add(row.valveId);
    rows.push({ valveId: row.valveId, sensorId: row.sensorId, potLabel: row.potLabel });
    if (rows.length >= maxSimulatedPots) break;
  }
  return rows;
}

export function buildWorld(options: BuildWorldOptions): SimWorld {
  const rng = createRng(options.seed);
  const mirrorRows = options.mirror ? dedupeMirror(options.mirror) : [];
  const mirrored = mirrorRows.length >= minSimulatedPots;
  const preset = simPresets.find((item) => item.id === options.presetId) ?? simPresets[0];
  const potCount = mirrored ? mirrorRows.length : clampPotCount(options.potCount ?? preset.defaultPotCount);
  const noisyEverywhere = preset.id === "noisy";

  const pots: SimPot[] = [];
  const sensors: SimSensor[] = [];
  for (let index = 0; index < potCount; index += 1) {
    pots.push({
      index,
      label: mirrored ? mirrorRows[index].potLabel ?? `Pot ${index + 1}` : `Pot ${index + 1}`,
      baseVwc: rng.range(16, 31),
      saturationVwc: rng.range(44, 50),
      gainPerSecond: rng.range(0.5, 0.95),
      lagSeconds: rng.range(15, 50),
      tauSeconds: rng.range(30, 75),
      dryingPerMinute: -rng.range(0.001, 0.006),
      erratic: false,
      overshootFraction: 0,
    });
    sensors.push({
      index,
      id: mirrored ? mirrorRows[index].sensorId : syntheticSensorId(rng, index),
      noiseSigma: noisyEverywhere ? rng.range(0.18, 0.3) : rng.range(0.05, 0.12),
      fault: "none",
    });
  }

  // Hidden layout. A mirrored installation assumes the recorded pairings are
  // physically right (valve i waters sensor i) until a preset says otherwise.
  const permutation = mirrored
    ? Array.from({ length: potCount }, (_, index) => index)
    : rng.shuffle(Array.from({ length: potCount }, (_, index) => index));
  const valves: SimValve[] = permutation.map((potIndex, index) => ({
    index,
    id: mirrored ? mirrorRows[index].valveId : syntheticValveId(index),
    fault: "none",
    targets: [{ potIndex, share: 1 }],
  }));

  let recordedPairings: RecordedPairing[] = mirrored
    ? mirrorRows.map((row) => ({ ...row }))
    : [];

  // Faults land on distinct, seed-chosen valves so presets never overlap.
  const faultOrder = rng.shuffle(Array.from({ length: potCount }, (_, index) => index));
  let cursor = 0;
  const takeValve = () => valves[faultOrder[cursor++ % faultOrder.length]];
  const potOf = (valve: SimValve) => pots[valve.targets[0].potIndex];
  const sensorOf = (valve: SimValve) => sensors[valve.targets[0].potIndex];
  const injectedFaults: string[] = [];
  const note = (text: string) => injectedFaults.push(text);

  if (preset.id === "noisy") {
    for (let count = 0; count < 2; count += 1) {
      const valve = takeValve();
      sensorOf(valve).fault = "noisy";
      sensorOf(valve).noiseSigma = rng.range(1.1, 1.6);
      note(`Sensor ${sensorOf(valve).id} is excessively noisy.`);
    }
    const erratic = takeValve();
    potOf(erratic).erratic = true;
    note(`${potOf(erratic).label} responds erratically from pulse to pulse.`);
  }

  if (preset.id === "disconnected-hose") {
    const disconnected = takeValve();
    disconnected.fault = "disconnected_hose";
    note(`The hose on valve ${disconnected.id} is disconnected.`);
    const stuck = takeValve();
    stuck.fault = "stuck_closed";
    note(`Valve ${stuck.id} never opens.`);
    const weak = takeValve();
    weak.fault = "weak_flow";
    note(`Valve ${weak.id} delivers weak flow.`);
  }

  if (preset.id === "bad-sensor") {
    const faults: SensorFault[] = ["dead", "raw_counts", "flatlined"];
    for (const fault of faults) {
      const valve = takeValve();
      sensorOf(valve).fault = fault;
      note(`Sensor ${sensorOf(valve).id}: ${fault.replace("_", " ")}.`);
    }
    const saturated = takeValve();
    potOf(saturated).saturationVwc = Math.max(potOf(saturated).saturationVwc, 48.5);
    potOf(saturated).baseVwc = potOf(saturated).saturationVwc - 0.2;
    potOf(saturated).dryingPerMinute = -0.0005;
    note(`${potOf(saturated).label} is already saturated.`);
  }

  if (preset.id === "cross-talk") {
    for (let count = 0; count < 2; count += 1) {
      const valve = takeValve();
      const neighbor = takeValve();
      valve.targets = [
        { potIndex: valve.targets[0].potIndex, share: 0.68 },
        { potIndex: neighbor.targets[0].potIndex, share: 0.32 },
      ];
      note(`The hose on valve ${valve.id} leaks into ${potOf(neighbor).label}.`);
    }
    const split = takeValve();
    const splitNeighbor = takeValve();
    split.targets = [
      { potIndex: split.targets[0].potIndex, share: 0.52 },
      { potIndex: splitNeighbor.targets[0].potIndex, share: 0.48 },
    ];
    // Matching pots, so the split really is indistinguishable from the sensor side.
    pots[splitNeighbor.targets[0].potIndex].gainPerSecond = potOf(split).gainPerSecond;
    pots[splitNeighbor.targets[0].potIndex].saturationVwc = potOf(split).saturationVwc;
    pots[splitNeighbor.targets[0].potIndex].baseVwc = potOf(split).baseVwc;
    note(`The hose on valve ${split.id} is split almost evenly between two pots.`);
    const duplicate = takeValve();
    const shared = takeValve();
    duplicate.targets = [{ potIndex: shared.targets[0].potIndex, share: 1 }];
    note(`Valves ${duplicate.id} and ${shared.id} both water ${potOf(shared).label}.`);
  }

  if (preset.id === "swapped-hoses") {
    if (!mirrored) {
      recordedPairings = valves.map((valve) => ({
        valveId: valve.id,
        sensorId: sensorOf(valve).id,
        potLabel: potOf(valve).label,
      }));
    }
    for (let count = 0; count < 2; count += 1) {
      const first = takeValve();
      const second = takeValve();
      [first.targets, second.targets] = [second.targets, first.targets];
      note(`The hoses on valves ${first.id} and ${second.id} are swapped relative to the records.`);
    }
  }

  if (preset.id === "difficult-soil") {
    const slow = takeValve();
    potOf(slow).lagSeconds = 170;
    potOf(slow).tauSeconds = 320;
    note(`${potOf(slow).label} wets very slowly.`);
    const small = takeValve();
    potOf(small).gainPerSecond = 2.4;
    potOf(small).overshootFraction = 0.35;
    potOf(small).baseVwc = Math.min(potOf(small).baseVwc, 22);
    note(`${potOf(small).label} is small and overshoots.`);
  }

  const truth = valves.map((valve) => {
    if (valve.fault === "disconnected_hose" || valve.fault === "stuck_closed") return null;
    const main = valve.targets.reduce((best, target) => (target.share > best.share ? target : best));
    return main.potIndex;
  });

  return {
    seed: options.seed,
    presetId: preset.id,
    source: mirrored ? "mirror" : "synthetic",
    pots,
    sensors,
    valves,
    recordedPairings,
    truth,
    injectedFaults,
  };
}

type WaterEvent = { startSeconds: number; amplitude: number; overshoot: number };

export const nominalFlowMlPerSecond = 12;
const erraticFactors = [1.5, 0.35, 1.25, 0.5];

// Stateful bench. Time only moves when the engine samples or pulses.
export class SimulatedBench {
  readonly world: SimWorld;
  private readonly noise: Rng;
  private readonly hoses: SimHoseTarget[][];
  private readonly events: WaterEvent[][];
  private readonly stuckValues: Array<number | null>;
  private timeSeconds = 0;

  constructor(world: SimWorld) {
    this.world = world;
    this.noise = createRng(world.seed ^ 0x5bd1e995);
    this.hoses = world.valves.map((valve) => valve.targets.map((target) => ({ ...target })));
    this.events = world.pots.map(() => []);
    this.stuckValues = world.sensors.map(() => null);
  }

  get elapsedSeconds() {
    return this.timeSeconds;
  }

  // Demonstration hook for continuous verification: physically swap two hoses.
  swapHoses(firstValveIndex: number, secondValveIndex: number) {
    const first = this.hoses[firstValveIndex];
    this.hoses[firstValveIndex] = this.hoses[secondValveIndex];
    this.hoses[secondValveIndex] = first;
  }

  trueVwc(potIndex: number, atSeconds = this.timeSeconds) {
    const pot = this.world.pots[potIndex];
    let value = pot.baseVwc + (pot.dryingPerMinute * atSeconds) / 60;
    for (const event of this.events[potIndex]) {
      const since = atSeconds - event.startSeconds - pot.lagSeconds;
      if (since <= 0) continue;
      const progress = since / pot.tauSeconds;
      value += event.amplitude * (1 - Math.exp(-progress));
      if (event.overshoot > 0) value += event.overshoot * progress * Math.exp(1 - progress);
    }
    return Math.min(pot.saturationVwc + 1.5, Math.max(3, value));
  }

  // Opens one simulated valve for `seconds` and returns the simulated flow reading.
  pulse(valveIndex: number, seconds: number) {
    const valve = this.world.valves[valveIndex];
    const flowFactor = valve.fault === "stuck_closed" ? 0 : valve.fault === "weak_flow" ? 0.25 : 1;
    const flowMl = nominalFlowMlPerSecond * seconds * flowFactor * (1 + this.noise.normal() * 0.03);
    if (flowFactor > 0 && valve.fault !== "disconnected_hose") {
      for (const target of this.hoses[valveIndex]) {
        const pot = this.world.pots[target.potIndex];
        // Channeling soil: the same pulse lands very differently each time.
        const erratic = pot.erratic ? erraticFactors[this.events[target.potIndex].length % erraticFactors.length] : 1;
        const demand = pot.gainPerSecond * seconds * target.share * flowFactor * erratic;
        // Response saturates as the pot approaches field capacity: it is not linear.
        const headroom = Math.max(0, pot.saturationVwc - this.trueVwc(target.potIndex));
        const amplitude = headroom <= 0 ? 0 : headroom * (1 - Math.exp(-demand / headroom));
        this.events[target.potIndex].push({
          startSeconds: this.timeSeconds,
          amplitude,
          overshoot: amplitude * pot.overshootFraction,
        });
      }
    }
    this.timeSeconds += seconds;
    return { flowMl: Math.max(0, flowMl), expectedFlowMl: nominalFlowMlPerSecond * seconds };
  }

  // Advances the clock and polls every sensor once. `null` means no reply.
  sample(intervalSeconds: number): Array<number | null> {
    this.timeSeconds += intervalSeconds;
    return this.world.sensors.map((sensor) => {
      const noise = this.noise.normal() * sensor.noiseSigma;
      if (sensor.fault === "dead") return null;
      const vwc = this.trueVwc(sensor.index);
      if (sensor.fault === "flatlined") {
        if (this.stuckValues[sensor.index] == null) this.stuckValues[sensor.index] = Math.round(vwc * 100) / 100;
        return this.stuckValues[sensor.index];
      }
      if (sensor.fault === "raw_counts") return Math.round(1850 + vwc * 24 + noise * 20);
      return Math.round((vwc + noise) * 100) / 100;
    });
  }
}
