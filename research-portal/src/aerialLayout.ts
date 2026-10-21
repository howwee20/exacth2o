import { recordedLayout, schematicLayout, type BenchLayoutDocument } from "./benchLayout";
import type { PairingRow } from "./types";

/**
 * The overhead (aerial) view of the installation, shared by Settings → Autocalibrate
 * and every place that shows pots from above.
 *
 * Positions come from the recorded bench layout when one exists. Without one, the
 * pots are drawn in the overhead composition from the PicoGrid presentation: one
 * bench, four rows of 25, the four zones as interlocking blocks of 13 + 12, with
 * the modular controller beside it. That arrangement is SCHEMATIC: it orders pots
 * by zone and number and is labelled as such. It is never treated as a measured
 * position, and no hardware identity is ever derived from where a pot is drawn or
 * from its number: every pot carries its controller pairing's own sensor and valve.
 */

export type ZoneTone = "green" | "white" | "blue" | "red" | "neutral";

export type AerialPot = {
  pairingName: string;
  potNumber: number;
  zone: number;
  sensorKey: string;
  valveKey: string;
  bench: string;
  /** 1-based grid row and column within the bench. */
  row: number;
  column: number;
  tone: ZoneTone;
};

export type AerialNode = {
  zone: number;
  label: string;
  tone: ZoneTone;
  /** Where the node label sits around the bench, as in the presentation. */
  side: "top" | "bottom";
  /** First column of the zone's block, for placing its label. */
  column: number;
  pairingNames: string[];
};

export type AerialBench = {
  id: string;
  label: string;
  rows: number;
  columns: number;
  pots: AerialPot[];
};

export type AerialModel = {
  basis: "recorded" | "schematic";
  composition: "presentation" | "benches";
  benches: AerialBench[];
  nodes: AerialNode[];
  /** On the controller but without a recorded place (recorded basis), or beyond the composition. */
  unplaced: PairingRow[];
  unplacedReason: string | null;
  version: number | null;
};

const zoneTones: ZoneTone[] = ["green", "white", "blue", "red"];
const presentationColumns = 25;
const zoneBlockSize = 25;

export function toneForZone(zone: number, zones: readonly number[]): ZoneTone {
  const index = zones.indexOf(zone);
  return index >= 0 && index < zoneTones.length ? zoneTones[index] : "neutral";
}

function byPotNumber(a: PairingRow, b: PairingRow) {
  return a.pot_number - b.pot_number || a.name.localeCompare(b.name, undefined, { numeric: true });
}

/**
 * Slots of the presentation's overhead composition for zone block `block` (0-3):
 * blocks 0/1 share rows 1-2 (left/right), blocks 2/3 share rows 3-4. The left
 * block takes 13 columns in its first row and 12 in its second; the right block
 * takes the rest, exactly as the slide draws the four nodes.
 */
export function presentationSlots(block: number): Array<{ row: number; column: number }> {
  const topRow = block < 2 ? 1 : 3;
  const left = block % 2 === 0;
  const slots: Array<{ row: number; column: number }> = [];
  const rowSpans = left ? [[1, 13], [1, 12]] : [[14, 25], [13, 25]];
  rowSpans.forEach(([first, last], offset) => {
    for (let column = first; column <= last; column += 1) slots.push({ row: topRow + offset, column });
  });
  return slots;
}

function presentationModel(pairings: readonly PairingRow[], zones: number[]): AerialModel {
  const pots: AerialPot[] = [];
  const unplaced: PairingRow[] = [];
  const nodes: AerialNode[] = [];
  zones.forEach((zone, block) => {
    const zonePairings = pairings.filter((pairing) => pairing.zone === zone).slice().sort(byPotNumber);
    const slots = presentationSlots(block);
    const placed = zonePairings.slice(0, slots.length);
    unplaced.push(...zonePairings.slice(slots.length));
    const tone = toneForZone(zone, zones);
    placed.forEach((pairing, index) => pots.push({
      pairingName: pairing.name,
      potNumber: pairing.pot_number,
      zone,
      sensorKey: pairing.sensor_key,
      valveKey: pairing.valve_key,
      bench: "installation",
      row: slots[index].row,
      column: slots[index].column,
      tone,
    }));
    nodes.push({
      zone,
      label: `Zone ${zone}`,
      tone,
      side: block < 2 ? "top" : "bottom",
      column: block % 2 === 0 ? 1 : 14,
      pairingNames: placed.map((pairing) => pairing.name),
    });
  });
  return {
    basis: "schematic",
    composition: "presentation",
    benches: [{ id: "installation", label: "Installation (schematic)", rows: 4, columns: presentationColumns, pots }],
    nodes,
    unplaced,
    unplacedReason: unplaced.length ? "These pairings do not fit the four 25-pot zone blocks of the overhead view; no position is assumed for them." : null,
    version: null,
  };
}

/** Fits the presentation composition: at most four zones of at most 25 pots each. */
export function fitsPresentation(pairings: readonly PairingRow[]) {
  const zones = Array.from(new Set(pairings.map((pairing) => pairing.zone))).sort((a, b) => a - b);
  return zones.length > 0 && zones.length <= 4 && zones.every((zone) => pairings.filter((pairing) => pairing.zone === zone).length <= zoneBlockSize);
}

export function buildAerialModel(
  pairings: readonly PairingRow[],
  recorded: { layout: BenchLayoutDocument; version: number } | null,
): AerialModel {
  const zones = Array.from(new Set(pairings.map((pairing) => pairing.zone))).sort((a, b) => a - b);
  if (recorded) {
    try {
      const model = recordedLayout(recorded.layout, pairings);
      const byName = new Map(pairings.map((pairing) => [pairing.name, pairing]));
      return {
        basis: "recorded",
        composition: "benches",
        benches: model.benches.filter((bench) => bench.cells.length > 0).map((bench) => ({
          id: bench.id,
          label: bench.label,
          rows: bench.rows,
          columns: bench.columns,
          pots: bench.cells.map((cell) => {
            const pairing = byName.get(cell.pairingName)!;
            return {
              pairingName: cell.pairingName,
              potNumber: cell.potNumber,
              zone: cell.zone,
              sensorKey: pairing.sensor_key,
              valveKey: pairing.valve_key,
              bench: bench.id,
              row: cell.row,
              column: cell.column,
              tone: toneForZone(cell.zone, zones),
            };
          }),
        })),
        nodes: zones.map((zone) => ({
          zone, label: `Zone ${zone}`, tone: toneForZone(zone, zones), side: "top", column: 1,
          pairingNames: pairings.filter((pairing) => pairing.zone === zone).map((pairing) => pairing.name),
        })),
        unplaced: model.unplaced.map((name) => byName.get(name)!).filter(Boolean),
        unplacedReason: model.unplaced.length ? "On the controller but not in the recorded layout. Shown here without assuming where they stand." : null,
        version: recorded.version,
      };
    } catch {
      // An invalid recorded layout falls back to the schematic view below.
    }
  }
  if (fitsPresentation(pairings)) return presentationModel(pairings, zones);
  const schematic = schematicLayout(pairings);
  return {
    basis: "schematic",
    composition: "benches",
    benches: schematic.benches.map((bench) => ({
      id: bench.id,
      label: `${bench.label} (schematic)`,
      rows: bench.rows,
      columns: bench.columns,
      pots: bench.cells.map((cell) => {
        const pairing = pairings.find((item) => item.name === cell.pairingName)!;
        return { pairingName: cell.pairingName, potNumber: cell.potNumber, zone: cell.zone, sensorKey: pairing.sensor_key, valveKey: pairing.valve_key, bench: bench.id, row: cell.row, column: cell.column, tone: toneForZone(cell.zone, zones) };
      }),
    })),
    nodes: zones.map((zone) => ({ zone, label: `Zone ${zone}`, tone: toneForZone(zone, zones), side: "top", column: 1, pairingNames: pairings.filter((pairing) => pairing.zone === zone).map((pairing) => pairing.name) })),
    unplaced: [],
    unplacedReason: null,
    version: null,
  };
}

/** Every pot of the model in reading order (bench, row, column), for keyboard travel. */
export function readingOrder(model: AerialModel): AerialPot[] {
  return model.benches.flatMap((bench) => bench.pots.slice().sort((a, b) => a.row - b.row || a.column - b.column));
}

/** "Pots 1–12, 15, 20–22" for a selection summary. */
export function potRangeSummary(numbers: readonly number[]) {
  const sorted = Array.from(new Set(numbers)).sort((a, b) => a - b);
  const parts: string[] = [];
  for (let index = 0; index < sorted.length; index += 1) {
    const start = sorted[index];
    let end = start;
    while (index + 1 < sorted.length && sorted[index + 1] === end + 1) end = sorted[++index];
    parts.push(end > start + 1 ? `${start}–${end}` : end === start + 1 ? `${start}, ${end}` : String(start));
  }
  return parts.join(", ");
}
