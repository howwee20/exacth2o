import { describe, expect, it } from "vitest";
import { alignPairingHistory } from "./pairingHistory";

describe("pairing history across controller renames", () => {
  const identities = [{ name: "Zone3-Pot16", sensor_key: "board-E:P", valve_key: "0x20:18" }];

  it("keeps old and new readings together without rewriting raw records", () => {
    const old = { pairing_name: "Zone1-Pot16", sensor_key: "board-E:P", value: 20.7 };
    const current = { ...old, pairing_name: "Zone3-Pot16", value: 20.8 };
    expect(alignPairingHistory([old, current], identities, "sensor_key")).toEqual([
      { ...old, pairing_name: "Zone3-Pot16" }, current,
    ]);
    expect(old.pairing_name).toBe("Zone1-Pot16");
  });

  it("rejects the same sensor letter on a different board even if its label matches", () => {
    expect(alignPairingHistory([
      { pairing_name: "Zone3-Pot16", sensor_key: "board-D:P" },
    ], identities, "sensor_key")).toEqual([]);
  });

  it("preserves historical valve activity under the corrected label", () => {
    expect(alignPairingHistory([
      { pairing_name: "Zone1-Pot16", valve_key: "0x20:18", action: "open" },
    ], identities, "valve_key")).toEqual([
      { pairing_name: "Zone3-Pot16", valve_key: "0x20:18", action: "open" },
    ]);
  });

  it("does not assign ambiguous shared-valve history to an arbitrary pot", () => {
    const shared = [...identities, { name: "Zone4-Pot26", valve_key: "0x20:18" }];
    expect(alignPairingHistory([
      { pairing_name: "Zone1-Pot16", valve_key: "0x20:18" },
      { pairing_name: "Zone3-Pot16", valve_key: "0x20:18" },
    ], shared, "valve_key")).toEqual([
      { pairing_name: "Zone3-Pot16", valve_key: "0x20:18" },
    ]);
  });

  it("retains name-based history for older catalogs without hardware snapshots", () => {
    const record = { pairing_name: "Old-Pot", sensor_key: "board-E:P" };
    expect(alignPairingHistory([record], [{ name: "Old-Pot" }], "sensor_key")).toEqual([record]);
  });
});
