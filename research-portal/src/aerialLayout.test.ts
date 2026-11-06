import { describe, expect, it } from "vitest";
import { buildAutocalibrationAerialModel, buildAerialModel, fitsPresentation, potRangeSummary, presentationSlots, readingOrder } from "./aerialLayout";
import type { PairingRow } from "./types";

function installation(count = 100, zones = 4): PairingRow[] {
  const perZone = Math.ceil(count / zones);
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    name: `Zone${Math.floor(index / perZone) + 1}-Pot${index + 1}`,
    zone: Math.floor(index / perZone) + 1,
    pot_number: index + 1,
    source_sensor_id: index + 1,
    sensor_key: `S${index}:1`,
    source_valve_id: index + 1,
    // Valve keys deliberately unrelated to pot numbers or positions.
    valve_key: `${32 + ((index * 7) % 3)}:${((index * 13) % 48) + 1}`,
    wtc_percent_limit: 20,
    valve_open_time_ms: 3000,
    measurement_interval_ms: 600_000,
  }));
}

describe("aerial view of the installation", () => {
  it("draws 100 pots as the presentation does: four rows of 25, zones as interlocking 13 + 12 blocks", () => {
    expect(presentationSlots(0).slice(0, 13).every((slot) => slot.row === 1)).toBe(true);
    expect(presentationSlots(0).filter((slot) => slot.row === 2)).toHaveLength(12);
    expect(presentationSlots(1).filter((slot) => slot.row === 1).map((slot) => slot.column)[0]).toBe(14);
    expect(presentationSlots(1).filter((slot) => slot.row === 2).map((slot) => slot.column)[0]).toBe(13);
    expect(presentationSlots(2)[0]).toEqual({ row: 3, column: 1 });
    const model = buildAerialModel(installation(), null);
    expect(model.basis).toBe("schematic");
    expect(model.composition).toBe("presentation");
    expect(model.benches[0].pots).toHaveLength(100);
    expect(model.unplaced).toEqual([]);
    const cells = new Set(model.benches[0].pots.map((pot) => `${pot.row}:${pot.column}`));
    expect(cells.size).toBe(100);
    expect(model.nodes.map((node) => [node.zone, node.side, node.tone])).toEqual([[1, "top", "green"], [2, "top", "white"], [3, "bottom", "blue"], [4, "bottom", "red"]]);
  });

  it("keeps every pot's own controller identities, whatever its drawn position", () => {
    const pairings = installation();
    const model = buildAerialModel(pairings, null);
    for (const pot of model.benches[0].pots) {
      const pairing = pairings.find((item) => item.name === pot.pairingName)!;
      expect(pot.valveKey).toBe(pairing.valve_key);
      expect(pot.sensorKey).toBe(pairing.sensor_key);
      expect(pot.potNumber).toBe(pairing.pot_number);
    }
  });

  it("lists pots that do not fit the composition as unplaced instead of guessing a position", () => {
    const pairings = installation(100);
    pairings.push({ ...pairings[0], id: 999, name: "Zone1-Pot101", pot_number: 101, sensor_key: "S999:1", valve_key: "34:48" });
    const model = buildAerialModel(pairings, null);
    expect(fitsPresentation(pairings)).toBe(false);
    // Falls back to the schematic bench layout rather than overflowing a zone block.
    expect(model.composition).toBe("benches");
    expect(model.benches.flatMap((bench) => bench.pots)).toHaveLength(101);
  });

  it("uses a recorded layout when one exists and lists controller pots it does not place", () => {
    const pairings = installation(6, 2);
    const layout = {
      benches: [{ id: "north", label: "North bench", rows: 1, columns: 5 }],
      positions: pairings.slice(0, 5).map((pairing, index) => ({ pairing_name: pairing.name, bench: "north", row: 1, column: index + 1 })),
    };
    const model = buildAerialModel(pairings, { layout, version: 3 });
    expect(model.basis).toBe("recorded");
    expect(model.version).toBe(3);
    expect(model.benches[0].pots).toHaveLength(5);
    expect(model.unplaced.map((pairing) => pairing.name)).toEqual([pairings[5].name]);
    expect(model.unplacedReason).toMatch(/without assuming where they stand/);
  });

  it("orders pots for keyboard travel and summarizes ranges", () => {
    const model = buildAerialModel(installation(), null);
    const order = readingOrder(model);
    expect(order[0].row).toBe(1);
    expect(order[order.length - 1].row).toBe(4);
    expect(potRangeSummary([5, 1, 2, 3, 9, 10, 12])).toBe("1–3, 5, 9, 10, 12");
    expect(potRangeSummary([])).toBe("");
  });
});


describe("live partial installation", () => {
  it("keeps all 100 numbered slots visible when a recorded layout uses obsolete pairing names", () => {
    const all = installation();
    const pairings = [all[64], all[99]];
    const model = buildAutocalibrationAerialModel(pairings, { version: 3, layout: {
      benches: [{ id: "old", label: "Old bench", rows: 1, columns: 1 }],
      positions: [{ pairing_name: "Obsolete-Pot65", bench: "old", row: 1, column: 1 }],
    } });
    expect(model.basis).toBe("schematic");
    expect(model.benches[0].pots).toHaveLength(100);
    expect(model.unplaced).toEqual([]);
    const configured = model.benches[0].pots.filter((pot) => !pot.unavailableReason);
    expect(configured.map((pot) => pot.pairingName)).toEqual(pairings.map((pot) => pot.name));
    expect(configured.map((pot) => pot.valveKey)).toEqual(pairings.map((pot) => pot.valve_key));
    expect(model.benches[0].pots[0]).toMatchObject({ sensorKey: "", valveKey: "", unavailableReason: expect.stringContaining("Not configured") });
    expect(model.nodes.flatMap((node) => node.pairingNames)).toEqual(pairings.map((pot) => pot.name));
  });

  it("preserves duplicate numbered controller pairings separately without inventing hardware routes", () => {
    const pairings = installation();
    const alias = { ...pairings[65], id: 999, name: "Other-Pot66", sensor_key: "OTHER:1", valve_key: "0x26:48" };
    const model = buildAutocalibrationAerialModel([...pairings, alias], null);
    expect(model.benches[0].pots).toHaveLength(100);
    expect(model.benches[1].pots).toHaveLength(1);
    expect(model.benches[1].pots[0]).toMatchObject({ pairingName: alias.name, sensorKey: alias.sensor_key, valveKey: alias.valve_key });
    expect(new Set(readingOrder(model).map((pot) => pot.pairingName)).size).toBe(101);
  });
});
