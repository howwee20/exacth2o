import { beforeEach, describe, expect, it, vi } from "vitest";
const capture = vi.hoisted(() => ({ filters: [] as Array<[string, string[]]> }));
vi.mock("./supabase", () => ({ supabase: {from: () => {
  const query = {
    select: () => query, eq: () => query, gte: () => query, lt: () => query,
    order: () => query, limit: () => query,
    in: (column: string, values: string[]) => { capture.filters.push([column, values]); return query; },
  }; return query;
}}}));
vi.mock("./supabaseTimeout", () => ({ withSupabaseTimeout: async () => ({data: [], error: null}) }));
import { loadExportReadings } from "./experimentExportClient";
describe("measurement export identity query", () => {
  beforeEach(() => {capture.filters = [];});
  const input = {projectId:"project",deviceId:"device",pairingNames:["Zone3-Pot16"],startMs:0,endMs:1000};
  it("queries the full sensor key so older pairing labels remain in the export", async () => {
    await loadExportReadings({...input,sensorKeys:["board-E:P"]});
    expect(capture.filters).toEqual([["sensor_key",["board-E:P"]]]);
  });
  it("preserves legacy name-based exports when snapshots are unavailable", async () => {
    await loadExportReadings(input);
    expect(capture.filters).toEqual([["pairing_name",["Zone3-Pot16"]]]);
  });
});
