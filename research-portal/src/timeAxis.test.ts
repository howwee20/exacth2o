import { afterAll, describe, expect, it } from "vitest";
import { timeTicks, timeZoneLabel } from "./timeAxis";
const original = process.env.TZ;
afterAll(() => { process.env.TZ = original; });
describe("calendar time axis", () => {
  it.each(["2026-10-31", "2027-03-13"])("keeps six-hour ticks on clock boundaries across %s", (date) => {
    process.env.TZ = "America/Detroit";
    const start = new Date(`${date}T00:00:00`).getTime();
    const end = start + 3 * 86400000;
    const ticks = timeTicks({ startMs: start, endMs: end }, 1000);
    expect(ticks.length).toBeGreaterThan(5);
    expect(ticks.every((tick) => new Date(tick.at).getHours() % 6 === 0)).toBe(true);
    expect(ticks.every((tick, i) => i === 0 || tick.at > ticks[i - 1].at)).toBe(true);
    expect(timeZoneLabel(start, end)).toMatch(/EDT.*EST|EST.*EDT/);
  });
});
