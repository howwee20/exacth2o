import type { PairingRow } from "../types";
type CurveUse = { planned: number[]; reported: number[]; snapshot: number[] };
/** Which pots each curve covers: in the plan, on the controller now, and on the controller when the revision was saved. */
export function soilCurveUse(
  setup: string | null | undefined,
  assignments: readonly { pot_number: number; calibration_name_snapshot?: string | null }[],
  pairings: readonly Pick<PairingRow, "name" | "pot_number" | "calibration_name">[],
  names: ReadonlySet<string>,
) {
  const curves = new Map<string, CurveUse>();
  function add(name: string | null | undefined, field: keyof CurveUse, pot: number) {
    if (!name?.trim()) return;
    const entry = curves.get(name) ?? { planned: [], reported: [], snapshot: [] };
    entry[field].push(pot);
    curves.set(name, entry);
  }
  if (setup) curves.set(setup, { planned: [], reported: [], snapshot: [] });
  // The curve chosen in setup is the plan for every pot. Each assignment's calibration snapshot only records
  // which curve the controller had when the revision was saved, so it is shown as such, not as the plan.
  for (const assignment of assignments) {
    if (setup) {
      add(setup, "planned", assignment.pot_number);
      if (assignment.calibration_name_snapshot !== setup) add(assignment.calibration_name_snapshot, "snapshot", assignment.pot_number);
    } else add(assignment.calibration_name_snapshot, "planned", assignment.pot_number);
  }
  for (const p of pairings) {
    if (names.has(p.name)) add(p.calibration_name, "reported", p.pot_number);
  }
  return curves;
}
