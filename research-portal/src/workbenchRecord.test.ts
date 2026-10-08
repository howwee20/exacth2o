import { describe, expect, it, vi } from "vitest";
vi.mock("./supabase", () => ({ supabase: {} }));
import { readRecordPages } from "./recordClient";
import type { PortalExperiment } from "./experimentRegistry";
import {
  calibrationStep,
  calibrationSegments,
  gapItems,
  newSince,
  planItems,
  settingsItems,
  type AssignmentRow,
  type CommandRow,
} from "./recordModel";
import type { PairingRow } from "./types";
import {
  bucketRequestPlan,
  comparisonCsv,
  csvCell,
  comparisonGroups,
  comparisonSidecar,
  comparisonSvg,
  computeComparison,
  defaultDefinition,
  eventDayTicks,
  exclusionRanges,
  offsetLabel,
  parseDefinition,
  resolveWindow,
  type ComparisonDefinition,
  type Exclusion,
  type PotBucket,
} from "./workbenchModel";

const hour = 3_600_000;
const day = 24 * hour;

function assignment(pot: number, treatment: string) {
  return {
    pairing_name: `Zone1-Pot${pot}`, zone: 1, pot_number: pot, crop: "maize", treatment, block: null, substrate: null,
    target_vwc_percent: treatment === "deficit" ? 22 : 34, measurement_interval_minutes: 10,
  };
}

const experiment = {
  id: "trial",
  databaseId: "e-1",
  name: "Trial",
  shortDescription: "",
  mode: "controlled",
  groupNames: [],
  pairingNames: ["Zone1-Pot1", "Zone1-Pot2", "Zone1-Pot3", "Zone1-Pot4"],
  assignments: [assignment(1, "control"), assignment(2, "control"), assignment(3, "deficit"), assignment(4, "deficit")],
} as unknown as PortalExperiment;

function bucket(pot: number, startMs: number, vwc: number | null, readings = 6, excluded = 0): PotBucket {
  return { pairingName: `Zone1-Pot${pot}`, startMs, readings, excluded, values: { vwc, raw: vwc == null ? null : vwc * 15, temperature: null, ec: null } };
}

describe("workbench windows and requests", () => {
  const now = Date.parse("2026-10-08T15:00:00Z");

  it("aligns buckets to an event when the comparison is aligned", () => {
    const definition: ComparisonDefinition = {
      ...defaultDefinition(experiment),
      alignment: { kind: "event", eventKey: "revision:2", label: "Plan version 2", atIso: "2026-10-02T13:47:00Z" },
      window: { kind: "around", beforeDays: 2, afterDays: 3 },
      bucketMinutes: 60,
    };
    const window = resolveWindow(definition, now);
    const event = Date.parse("2026-10-02T13:47:00Z");
    expect(window.originMs).toBe(event);
    expect((event - window.queryStartMs) % hour).toBe(0);
    expect(window.queryStartMs).toBeLessThanOrEqual(event - 2 * day);
    expect(window.endMs).toBe(event + 3 * day);
    expect(offsetLabel(2 * day)).toBe("day +2");
    expect(offsetLabel(-day)).toBe("day −1");
    expect(offsetLabel(0)).toBe("day 0");
    expect(eventDayTicks({ startMs: window.queryStartMs, endMs: window.endMs }, event, 900).map((tick) => tick.label)).toContain("day 0");
  });

  it("never asks for more than 120 days, and splits requests at the API's 1000-row page", () => {
    const clipped = resolveWindow({ ...defaultDefinition(experiment), window: { kind: "range", startIso: "2026-01-01T00:00:00Z", endIso: "2026-10-08T00:00:00Z" } }, now);
    expect(clipped.clipped).toBe(true);
    expect(clipped.endMs - clipped.queryStartMs).toBeLessThanOrEqual(120 * day + clipped.bucketMs);
    const pots = Array.from({ length: 24 }, (_, index) => `Zone1-Pot${index + 1}`);
    const window = { queryStartMs: 0, endMs: 30 * day, bucketMs: hour };
    const plan = bucketRequestPlan(pots, window);
    for (const call of plan) expect(Math.ceil((call.endMs - call.startMs) / hour) * call.pairingNames.length).toBeLessThanOrEqual(1000);
    // Every pot-bucket is requested exactly once.
    const covered = plan.reduce((sum, call) => sum + Math.ceil((call.endMs - call.startMs) / hour) * call.pairingNames.length, 0);
    expect(covered).toBe(24 * 30 * 24);
  });

  it("keeps only well-formed stored definitions", () => {
    expect(parseDefinition({ version: 1, experimentId: "trial" })).toBeNull();
    expect(parseDefinition(defaultDefinition(experiment))).toEqual(defaultDefinition(experiment));
    expect(parseDefinition({ ...defaultDefinition(experiment), window: { kind: "last", days: 999 } })).toBeNull();
  });
});

describe("workbench statistics and exports agree", () => {
  const window = { queryStartMs: 0, endMs: 3 * hour, bucketMs: hour, originMs: 0, aligned: false, clipped: false };
  const groups = comparisonGroups(experiment, "treatment");
  // Pot 1 has many readings, pot 2 few: each pot still counts once. Pot 4 is silent in the last bucket.
  const buckets = [
    bucket(1, 0, 30, 60), bucket(2, 0, 32, 2), bucket(3, 0, 25), bucket(4, 0, 27),
    bucket(1, hour, 31, 60), bucket(2, hour, 33, 2), bucket(3, hour, 24), bucket(4, hour, 26, 6, 3),
    bucket(1, 2 * hour, 32, 60), bucket(2, 2 * hour, 34, 2), bucket(3, 2 * hour, 23),
  ];

  it("weights pots equally and treats a half-silent group as a gap", () => {
    const result = computeComparison({ groups, buckets, measure: "vwc", window });
    const control = result.series.find(({ group }) => group.id === "control");
    const deficit = result.series.find(({ group }) => group.id === "deficit");
    expect(control?.buckets.map((item) => item.median)).toEqual([31, 32, 33]);
    // One of two deficit pots in the last hour is not fewer than half: still drawn.
    expect(deficit?.buckets[2]).toMatchObject({ gap: false, reporting: 1, median: 23 });
    const summary = result.summaries.find((item) => item.groupId === "control");
    expect(summary).toMatchObject({ contributing: 2, windowMedian: 32, windowLow: 31, windowHigh: 33, readings: 186 });
    expect(result.summaries.find((item) => item.groupId === "deficit")?.excluded).toBe(3);
  });

  it("hiding a group changes only the figure", () => {
    const shown = computeComparison({ groups, buckets, measure: "vwc", window });
    const hidden = computeComparison({ groups, buckets, measure: "vwc", window, hiddenGroups: ["deficit"] });
    const withoutFlag = (list: typeof shown.summaries) => list.map((summary) => ({ ...summary, hidden: false }));
    expect(withoutFlag(hidden.summaries)).toEqual(withoutFlag(shown.summaries));
    expect(hidden.summaries.find((summary) => summary.groupId === "deficit")?.hidden).toBe(true);
    expect(comparisonCsv(hidden, "vwc", window)).toBe(comparisonCsv(shown, "vwc", window));
    const svg = comparisonSvg({ question: "Did <deficit> pots dry faster?", subtitle: "", result: hidden, window, measure: "vwc", hiddenGroups: ["deficit"], xTicks: [], footer: [] });
    expect(svg).toContain("Did &lt;deficit&gt; pots dry faster?");
    expect(svg).toContain(">Control<");
    expect(svg).not.toContain(">Deficit<");
  });

  it("the CSV carries exactly the values behind the statistics", () => {
    const result = computeComparison({ groups, buckets, measure: "vwc", window });
    const lines = comparisonCsv(result, "vwc", window).trim().split("\n");
    const header = lines[0].split(",");
    const rows = lines.slice(1).map((line) => Object.fromEntries(line.split(",").map((cell, index) => [header[index], cell])));
    const potRows = rows.filter((row) => row.row_type === "pot");
    expect(potRows.reduce((sum, row) => sum + Number(row.readings), 0)).toBe(result.totals.readings);
    expect(potRows.reduce((sum, row) => sum + Number(row.excluded_readings), 0)).toBe(result.totals.excluded);
    const groupRows = rows.filter((row) => row.row_type === "group" && row.group_id === "control");
    expect(groupRows.map((row) => Number(row.value))).toEqual([31, 32, 33]);
    // Recompute a group median from the CSV's own pot rows.
    const firstBucket = potRows.filter((row) => row.group_id === "control" && row.bucket_start_utc === new Date(0).toISOString()).map((row) => Number(row.value));
    expect((firstBucket[0] + firstBucket[1]) / 2).toBe(Number(groupRows[0].value));
  });

  it("the methods sidecar records exclusions, revocations and the hidden groups", () => {
    const exclusions: Exclusion[] = [
      { id: "x1", pairingName: "Zone1-Pot4", startsAt: new Date(hour).toISOString(), endsAt: new Date(2 * hour).toISOString(), reason: "Sensor reseated", authorLabel: "a@x", createdAt: "2026-10-08T10:00:00Z", revokedAt: null, revokedByLabel: null, revokeReason: null },
      { id: "x2", pairingName: null, startsAt: null, endsAt: null, reason: "Mistake", authorLabel: "a@x", createdAt: "2026-10-08T10:00:00Z", revokedAt: "2026-10-08T11:00:00Z", revokedByLabel: "a@x", revokeReason: "Added by mistake" },
    ];
    expect(exclusionRanges(exclusions)).toEqual([{ pairing_name: "Zone1-Pot4", starts_at: new Date(hour).toISOString(), ends_at: new Date(2 * hour).toISOString() }]);
    const definition = { ...defaultDefinition(experiment), hiddenGroups: ["deficit"] };
    const sidecar = comparisonSidecar({
      question: "Q?", comparisonId: "c1", sharing: "project", authorLabel: "a@x", generatedAtIso: "2026-10-08T12:00:00Z", build: "test",
      projectId: "p", deviceId: "d", experiment: { id: "trial", databaseId: "e-1", name: "Trial", revision: 2 }, pots: [],
      definition, window: { ...window }, exclusions, result: computeComparison({ groups, buckets, measure: "vwc", window }),
      calibrationEvents: [], query: { requests: 1, rows: 11, bytes: 900, failed: 0 },
    });
    expect(sidecar.exclusions.applied.map((item) => item.id)).toEqual(["x1"]);
    expect(sidecar.exclusions.revoked[0]).toMatchObject({ id: "x2", revoke_reason: "Added by mistake" });
    expect(sidecar.presentation.hidden_groups).toEqual(["deficit"]);
    expect(sidecar.method.significance).toMatch(/No significance test/);
    expect(sidecar.method.band).toMatch(/not a confidence interval/);
  });
});

describe("record lane", () => {
  const rows = (revision: string, overrides: Partial<AssignmentRow>[]): AssignmentRow[] => overrides.map((item, index) => ({
    revision_id: revision, pairing_name: `Zone1-Pot${index + 1}`, pot_number: index + 1, treatment: "control", target_vwc_percent: 34, calibration_name_snapshot: "Substrate v1", ...item,
  }));

  it("describes what a plan version changed, pot by pot", () => {
    const items = planItems(
      [{ id: "r1", version: 1, source: "manual", created_at: "2026-09-28T09:00:00Z", created_by: null }, { id: "r2", version: 2, source: "manual", created_at: "2026-10-02T09:14:00Z", created_by: null }],
      [{ id: "a1", event_type: "revision_created", revision_id: "r2", details: { summary: "Deficit pots: target 22%" }, created_at: "2026-10-02T09:14:00Z", actor_id: null }],
      [...rows("r1", [{}, {}, {}]), ...rows("r2", [{ calibration_name_snapshot: "Substrate v2" }, { target_vwc_percent: 22 }, {}])],
    );
    const second = items.find((item) => item.id === "revision:r2");
    expect(second?.title).toBe("Plan version 2: Deficit pots: target 22%");
    expect(second?.detail).toContain("Planned target 34% → 22% for Pot 2");
    expect(second?.detail).toContain("Calibration in the plan Substrate v1 → Substrate v2 for Pot 1");
    expect(second?.pots.sort()).toEqual(["Zone1-Pot1", "Zone1-Pot2"]);
  });

  it("keeps when a command was requested apart from when the controller confirmed it", () => {
    const base: CommandRow = { id: "c", command_type: "apply_calibration", payload: { calibration_name: "Substrate v2", pairing_names: ["Zone1-Pot1", "Zone9-Pot99"] }, status: "succeeded", requested_at: "2026-10-06T09:10:00Z", confirmed_at: null, started_at: null, completed_at: "2026-10-06T09:14:00Z", error: null, experiment_id: null, requested_by: null };
    const [calibration] = settingsItems([base], ["Zone1-Pot1"], "e-1");
    expect(calibration).toMatchObject({ kind: "calibration", pots: ["Zone1-Pot1"], happenedAt: Date.parse("2026-10-06T09:14:00Z"), recordedAt: Date.parse("2026-10-06T09:10:00Z") });
    expect(calibration.calibration?.name).toBe("Substrate v2");
    const failed = settingsItems([{ ...base, id: "f", command_type: "update_board_config", payload: { board: "B5" }, status: "failed", error: "No ack" }], ["Zone1-Pot1"], "e-1");
    expect(failed[0].title).toMatch(/did not complete/);
    expect(settingsItems([{ ...base, id: "o", command_type: "update_pairing", payload: { pairing_name: "Zone9-Pot99" } }], ["Zone1-Pot1"], "e-1")).toEqual([]);
  });

  it("reports pots that went silent together on one board as one gap", () => {
    const pairing = (pot: number, board: string) => ({ name: `Zone1-Pot${pot}`, sensor_key: `${board}:${pot}` }) as PairingRow;
    const gaps = gapItems([
      { pairingName: "Zone1-Pot1", startMs: 0, endMs: 3 * hour, ongoing: true },
      { pairingName: "Zone1-Pot2", startMs: 0, endMs: 3 * hour, ongoing: true },
      { pairingName: "Zone1-Pot3", startMs: hour, endMs: 3 * hour, ongoing: false },
    ], [pairing(1, "B3"), pairing(2, "B3"), pairing(3, "B4")]);
    expect(gaps).toHaveLength(2);
    expect(gaps.find((item) => item.pots.length === 2)?.title).toMatch(/Pots 1 and 2 \(sensor board B3\) since then/);
    expect(gaps.every((item) => item.basis === "derived")).toBe(true);
  });

  it("counts only recorded rows by other people as new since the last look", () => {
    const items = [
      { id: "n", kind: "note" as const, happenedAt: 10, recordedAt: 50, title: "", pots: [], basis: "recorded" as const, source: "" },
      { id: "g", kind: "gap" as const, happenedAt: 60, recordedAt: null, title: "", pots: [], basis: "derived" as const, source: "" },
      { id: "o", kind: "plan" as const, happenedAt: 20, recordedAt: null, title: "", pots: [], basis: "recorded" as const, source: "" },
    ];
    expect([...newSince(items, 30)]).toEqual(["n"]);
    expect(newSince(items, null).size).toBe(0);
    expect(newSince([{ ...items[0], actorId: "me" }], 30, "me").size).toBe(0);
  });

  it("explains a calibration step with the raw output", () => {
    const at = 10 * hour;
    const series = (scale: number, rawShift = 0) => Array.from({ length: 12 }, (_, index) => {
      const startMs = at - 6 * 600_000 + index * 600_000;
      const raw = 500 + (startMs >= at ? rawShift : 0);
      const factor = startMs >= at ? scale : 0.065;
      return { pairingName: "Zone1-Pot1", startMs, readings: 1, excluded: 0, values: { vwc: raw * factor, raw, temperature: null, ec: null } };
    });
    expect(calibrationStep(series(0.065 * 1.07), at)?.conclusion).toBe("calibration");
    expect(calibrationStep(series(0.065 * 1.07, 40), at)?.conclusion).toBe("physical-too");
    expect(calibrationStep(series(0.065), at)?.conclusion).toBe("unclear");
    expect(calibrationStep([], at)).toBeNull();
  });
});


describe("record completeness", () => {
  it("reads histories beyond the server's first thousand rows", async () => {
    const rows = Array.from({ length: 1001 }, (_, id) => ({ id }));
    const result = await readRecordPages(async (from, to) => rows.slice(from, to + 1));
    expect(result).toEqual(rows);
  });
  it("fails explicitly when a history exceeds the bounded review limit", async () => {
    const rows = [1, 2, 3];
    await expect(readRecordPages(async (from, to) => rows.slice(from, to + 1), 2)).rejects.toThrow("review limit");
    expect(await readRecordPages(async (from, to) => [1, 2].slice(from, to + 1), 2)).toEqual([1, 2]);
  });
  it("rejects malformed saved windows and bucket sizes", () => {
    const base = defaultDefinition(experiment);
    expect(parseDefinition({ ...base, window: { kind: "range", startIso: "2026-10-08", endIso: "2026-10-07" } })).toBeNull();
    expect(parseDefinition({ ...base, window: { kind: "around", beforeDays: -2, afterDays: 3 } })).toBeNull();
    expect(parseDefinition({ ...base, bucketMinutes: Infinity })).toBeNull();
    expect(parseDefinition({ ...base, bucketMinutes: 60 })).not.toBeNull();
  });
});


describe("scientific export and calibration safeguards", () => {
  it("neutralizes spreadsheet formulas in text while preserving numeric measurements", () => {
    for (const text of ["=1+1", "+SUM(A1)", "-1+1", "@SUM(A1)", "\t=1+1", " =1+1"]) {
      expect(csvCell(text).startsWith("'")).toBe(true);
    }
    expect(csvCell(-1.5)).toBe("-1.5");
    expect(csvCell("Control")).toBe("Control");
  });
  it("does not join readings across missing calibration buckets", () => {
    const rows = [bucket(1, 0, 30), bucket(1, 600000, 31), bucket(1, 1800000, 33), bucket(1, 2400000, null), bucket(1, 3000000, 35)];
    expect(calibrationSegments(rows, "vwc").map((segment) => segment.length)).toEqual([2, 1, 1]);
  });
  it("requires paired raw/calibrated observations and never reports an infinite ratio", () => {
    const at = 3600000;
    const rows = [-2, -1, 0, 1].map((index) => bucket(1, at + index * 600000, index < 0 ? 0 : 30));
    rows.forEach((row) => { row.values.raw = 500; });
    expect(calibrationStep(rows, at)).toBeNull();
    rows[0].values.vwc = 30;
    rows[1].values.vwc = 30;
    rows[1].values.raw = null;
    expect(calibrationStep(rows, at)).toBeNull();
  });
});
