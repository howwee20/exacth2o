import { expect, it } from "vitest";
import { toggleTraceSelection } from "./traceSelection";

it("combines treatment selections without replacing the first selection", () => {
  const original = new Set(["maize-control", "maize-drought", "sorghum-control"]);
  const first = toggleTraceSelection(original, ["maize-control"]);
  const second = toggleTraceSelection(first, ["sorghum-control"]);
  expect([...second]).toEqual(["maize-drought"]);
  expect(original.size).toBe(3);
});
it("removes only the selected traces and allows an empty view", () => {
  const hidden = toggleTraceSelection(new Set<string>(), ["one"]);
  expect([...hidden]).toEqual(["one"]);
  expect([...toggleTraceSelection(hidden, ["one"])]).toEqual([]);
});
it("adds an entire partially selected treatment without hiding other treatments", () => {
  const hidden = toggleTraceSelection(new Set(["two", "four"]), ["one", "two"]);
  expect([...hidden]).toEqual(["four"]);
});
