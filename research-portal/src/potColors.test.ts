import { describe, expect, it } from "vitest";

import { colorForPotNumber } from "./potColors";

const experimentPots = [
  41, 42, 43, 44, 45, 46, 47, 48, 49, 50,
  91, 92, 93, 94, 95, 96, 97, 98, 99, 100,
  15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26,
  65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76,
  2, 4, 6, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62,
];

describe("physical pot chart colors", () => {
  it("assigns a distinct color to every pot across all three experiments", () => {
    const colors = experimentPots.map(colorForPotNumber);

    expect(new Set(colors).size).toBe(experimentPots.length);
  });

  it("keeps a pot color stable wherever the pot is displayed", () => {
    expect(colorForPotNumber(41)).toBe(colorForPotNumber(41));
    expect(colorForPotNumber(76)).toBe(colorForPotNumber(76));
  });
});
