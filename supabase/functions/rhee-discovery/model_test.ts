import { clearResponse, rankResponses, type Sample } from "./model.ts";
const readings = (values: number[]): Sample[] =>
  values.map((raw, t) => ({
    raw,
    t,
    v: 100.68 - .1289 * raw + .00004 * raw * raw,
  }));
Deno.test("Rhee dry probes retain small sustained responses above their own noise", () => {
  const before = {
    I: readings([1818.09, 1818.57, 1818.66]),
    H: readings([1834.42, 1834.48, 1834.38]),
  };
  const after = {
    I: readings([1832.39, 1831.57, 1831.48]),
    H: readings([1837.9, 1838.41, 1839.36]),
  };
  const ranked = rankResponses(before, after, ["H", "I"]);
  if (
    clearResponse(ranked, true)?.key !== "I" || ranked[0].delta >= .5 ||
    before.I.some((s) => s.v >= 0)
  ) throw Error("Small dry-probe response should match");
  if (clearResponse(ranked, false)) {
    throw Error("Coverage gap cannot confirm the leading probe");
  }
});
Deno.test("small ambiguous and transient rises are visible and remain unresolved", () => {
  const before = {
    A: readings([1800, 1800.1, 1799.9]),
    B: readings([1800, 1800.1, 1799.9]),
  };
  const tied = rankResponses(before, {
    A: readings([1801, 1801, 1801]),
    B: readings([1800.9, 1800.9, 1800.9]),
  }, ["A", "B"]);
  if (tied.length !== 2 || clearResponse(tied, true)) {
    throw Error("Similar small rises must remain visible and unresolved");
  }
  const transient = rankResponses(before, { A: readings([1830, 1830, 1800]) }, [
    "A",
  ]);
  if (clearResponse(transient, true)) {
    throw Error("A transient rise cannot confirm a pairing");
  }
});
