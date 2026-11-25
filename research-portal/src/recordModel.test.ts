import { expect, it } from "vitest";
import { wateringItems } from "./recordModel";

it("restricts the daily watering total and duration to the selected pot", () => {
  const day = {dayStartMs: 0, pots: 11, openings: 74, commandedOpenMs: 74000, byPot: new Map([["Pan65", {openings: 6, commandedOpenMs: 6000}]])};
  expect(wateringItems([day])[0].value).toBe(74);
  expect(wateringItems([day],"Pan65")[0]).toMatchObject({value:6, pots:["Pan65"]});
  expect(wateringItems([day],"Pan75")).toEqual([]);
});
