import type { ExperimentBuilderMode, ExperimentDraftAssignment } from "./experimentSpec";

/** A treatment group on the experiment setup screen: a name, a moisture target and a colour for its pots.
 *  A group with no target does not water. `base` carries the other settings of an experiment being copied. */
export type ExperimentGroup = {
  id: string;
  name: string;
  target: number | null;
  tone: number;
  base?: ExperimentDraftAssignment;
};

export const groupTones = ["#1a6b4a", "#b7791f", "#2f6fb5", "#7a5aa6", "#b94b45", "#2f8a8a"] as const;

/** A new experiment starts with the two groups most trials use. An empty group is simply left out. */
export function defaultGroups(): ExperimentGroup[] {
  return [
    { id: "g1", name: "Control", target: 30, tone: 0 },
    { id: "g2", name: "Drought", target: 10, tone: 1 },
  ];
}

/** The groups already in a set of assignments: pots that share a treatment and a target form one group. */
export function groupsFromAssignments(assignments: readonly ExperimentDraftAssignment[]) {
  const groups: ExperimentGroup[] = [];
  const groupByPot: Record<string, string> = {};
  const idByKey = new Map<string, string>();
  for (const assignment of assignments) {
    const target = assignment.watering_enabled ? assignment.target_vwc_percent : null;
    const key = JSON.stringify([assignment.treatment ?? "", target]);
    let id = idByKey.get(key);
    if (!id) {
      id = `g${groups.length + 1}`;
      idByKey.set(key, id);
      groups.push({ id, name: assignment.treatment ?? "", target, tone: groups.length % groupTones.length, base: assignment });
    }
    groupByPot[assignment.pairing_name] = id;
  }
  return groups.length ? { groups, groupByPot } : { groups: defaultGroups(), groupByPot };
}

/** A group to add beside the existing ones, with an id and a colour none of them uses. */
export function nextGroup(groups: readonly ExperimentGroup[]): ExperimentGroup {
  const number = Math.max(0, ...groups.map((group) => Number(group.id.slice(1)) || 0)) + 1;
  const used = new Set(groups.map((group) => group.tone));
  const free = groupTones.findIndex((_, tone) => !used.has(tone));
  return { id: `g${number}`, name: "", target: null, tone: free >= 0 ? free : groups.length % groupTones.length };
}

/** The assignment as it is once its pot belongs to the group: the group names the treatment and sets the watering.
 *  An observation experiment never waters, whatever the group's target. */
export function assignmentInGroup(
  assignment: ExperimentDraftAssignment,
  group: ExperimentGroup,
  mode: ExperimentBuilderMode,
  fallbackValveSeconds: number,
): ExperimentDraftAssignment {
  const observing = mode === "observation";
  return {
    ...assignment,
    treatment: group.name.trim() || null,
    watering_enabled: !observing && group.target !== null,
    target_vwc_percent: observing ? null : group.target,
    valve_open_seconds: observing ? null : assignment.valve_open_seconds ?? fallbackValveSeconds,
  };
}
