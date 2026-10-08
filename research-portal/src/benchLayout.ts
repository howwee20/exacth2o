import type { PairingRow } from "./types";

/**
 * Bench layout model. A recorded layout says where a person recorded each pot standing (bench,
 * row, column). Without one, the bench is a schematic numbered layout — one block per zone,
 * pots in number order — and it says so; it never implies measured positions.
 */

export type BenchSpec = { id: string; label: string; rows: number; columns: number };
export type BenchPosition = { pairing_name: string; bench: string; row: number; column: number };
export type BenchLayoutDocument = { benches: BenchSpec[]; positions: BenchPosition[] };

export type BenchCell = {
  pairingName: string;
  potNumber: number;
  zone: number;
  bench: string;
  row: number;
  column: number;
  sensorBoard: string | null;
};

export type BenchModel = {
  basis: "recorded" | "schematic";
  benches: (BenchSpec & { cells: BenchCell[] })[];
  /** Pots on the controller with no recorded place (recorded layouts only). */
  unplaced: string[];
};

export function sensorBoard(sensorKey: string | null | undefined) {
  const board = typeof sensorKey === "string" ? sensorKey.split(":")[0]?.trim() : "";
  return board || null;
}

const schematicColumns = 8;

export function schematicLayout(pairings: readonly PairingRow[]): BenchModel {
  const byZone = new Map<number, PairingRow[]>();
  for (const pairing of pairings) byZone.set(pairing.zone, [...(byZone.get(pairing.zone) ?? []), pairing]);
  const benches = Array.from(byZone.entries())
    .sort(([a], [b]) => a - b)
    .map(([zone, zonePairings]) => {
      const ordered = zonePairings.slice().sort((a, b) => a.pot_number - b.pot_number);
      const columns = Math.min(schematicColumns, Math.max(1, ordered.length));
      const rows = Math.max(1, Math.ceil(ordered.length / columns));
      return {
        id: `zone-${zone}`,
        label: `Zone ${zone}`,
        rows,
        columns,
        cells: ordered.map((pairing, index) => ({
          pairingName: pairing.name,
          potNumber: pairing.pot_number,
          zone,
          bench: `zone-${zone}`,
          row: Math.floor(index / columns) + 1,
          column: (index % columns) + 1,
          sensorBoard: sensorBoard(pairing.sensor_key),
        })),
      };
    });
  return { basis: "schematic", benches, unplaced: [] };
}

export function recordedLayout(document: BenchLayoutDocument, pairings: readonly PairingRow[]): BenchModel {
  const validated = parseBenchLayout(document);
  if (!validated) throw new Error("The recorded bench layout is invalid. An administrator must record a corrected version.");
  document = validated;
  const byName = new Map(pairings.map((pairing) => [pairing.name, pairing]));
  const placed = new Set<string>();
  const benches = document.benches.map((bench) => ({
    ...bench,
    cells: document.positions
      .filter((position) => position.bench === bench.id && byName.has(position.pairing_name))
      .map((position) => {
        const pairing = byName.get(position.pairing_name) as PairingRow;
        placed.add(pairing.name);
        return {
          pairingName: pairing.name,
          potNumber: pairing.pot_number,
          zone: pairing.zone,
          bench: bench.id,
          row: position.row,
          column: position.column,
          sensorBoard: sensorBoard(pairing.sensor_key),
        };
      }),
  }));
  const unplaced = pairings.filter((pairing) => !placed.has(pairing.name)).map((pairing) => pairing.name);
  return { basis: "recorded", benches, unplaced };
}

/** The same checks the database applies, so the editor can explain a refusal before saving. */
export function layoutProblems(document: BenchLayoutDocument): string[] {
  const problems: string[] = [];
  if (!document.benches.length || document.benches.length > 50) problems.push("A layout needs 1–50 benches.");
  const benchIds = new Set<string>();
  for (const bench of document.benches) {
    if (!bench.id || bench.id.length > 40 || benchIds.has(bench.id)) problems.push(`Bench “${bench.label || bench.id}” needs a unique short id.`);
    if (!bench.label?.trim() || bench.label.length > 200) problems.push("Each bench needs a label of 1–200 characters.");
    if (!Number.isInteger(bench.rows) || bench.rows < 1 || bench.rows > 100 || !Number.isInteger(bench.columns) || bench.columns < 1 || bench.columns > 100) {
      problems.push(`${bench.label || bench.id}: rows and columns must be whole numbers from 1 to 100.`);
    }
    benchIds.add(bench.id);
  }
  const pots = new Set<string>();
  const cells = new Set<string>();
  if (document.positions.length > 2000) problems.push("A layout can hold at most 2000 positions.");
  for (const position of document.positions) {
    if (!position.pairing_name || position.pairing_name.length > 120) problems.push("Each position needs a pot pairing name of 1–120 characters.");
    const bench = document.benches.find((item) => item.id === position.bench);
    if (!bench) {
      problems.push(`${position.pairing_name} is on a bench that does not exist.`);
      continue;
    }
    if (!Number.isInteger(position.row) || !Number.isInteger(position.column) || position.row < 1 || position.row > bench.rows || position.column < 1 || position.column > bench.columns) {
      problems.push(`${position.pairing_name} is outside ${bench.label}.`);
    }
    if (pots.has(position.pairing_name)) problems.push(`${position.pairing_name} is placed twice.`);
    const cell = `${position.bench}:${position.row}:${position.column}`;
    if (cells.has(cell)) problems.push(`Two pots share ${bench.label} row ${position.row}, column ${position.column}.`);
    pots.add(position.pairing_name);
    cells.add(cell);
  }
  return problems;
}

/** Rows returned by REST are untrusted JSON even when their table has a shape constraint. */
export function parseBenchLayout(value: unknown): BenchLayoutDocument | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<BenchLayoutDocument>;
  if (!Array.isArray(candidate.benches) || !Array.isArray(candidate.positions)) return null;
  if (candidate.benches.some((bench) => !bench || typeof bench !== "object" || typeof bench.id !== "string" || typeof bench.label !== "string" || typeof bench.rows !== "number" || typeof bench.columns !== "number")) return null;
  if (candidate.positions.some((position) => !position || typeof position !== "object" || typeof position.pairing_name !== "string" || typeof position.bench !== "string" || typeof position.row !== "number" || typeof position.column !== "number")) return null;
  const document = candidate as BenchLayoutDocument;
  return layoutProblems(document).length ? null : document;
}

/** A starting point for recording: the pots of each zone on one bench, in number order. */
export function draftFromSchematic(pairings: readonly PairingRow[]): BenchLayoutDocument {
  const model = schematicLayout(pairings);
  return {
    benches: model.benches.map(({ id, label, rows, columns }) => ({ id: id.replace(/^zone-/, "B"), label: label.replace(/^Zone/, "Bench"), rows, columns })),
    positions: model.benches.flatMap((bench) => bench.cells.map((cell) => ({
      pairing_name: cell.pairingName,
      bench: bench.id.replace(/^zone-/, "B"),
      row: cell.row,
      column: cell.column,
    }))),
  };
}

/** Pots grouped by sensor board (from the controller's sensor keys). */
export function boardGroups(pairings: readonly PairingRow[]) {
  const groups = new Map<string, PairingRow[]>();
  for (const pairing of pairings) {
    const board = sensorBoard(pairing.sensor_key) ?? "Unknown board";
    groups.set(board, [...(groups.get(board) ?? []), pairing]);
  }
  return Array.from(groups.entries())
    .map(([board, items]) => ({ board, pairings: items.slice().sort((a, b) => a.pot_number - b.pot_number) }))
    .sort((a, b) => a.board.localeCompare(b.board, undefined, { numeric: true }));
}
