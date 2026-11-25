import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { missingRouteText, PotRouteFacts } from "./FindPotDialog";
import type { RouteBook } from "../manualWaterApi";
import type { PotRoute } from "../manualWaterApi";

vi.mock("../supabase", () => ({ supabase: {} }));
const route: PotRoute = { pot: 78, status: "ready", relayAddress: 32, channel: 30, pairing: null };

describe("physical pot status", () => {
  it("does not mistake a verified watering route for a sensor link", () => {
    const html = renderToStaticMarkup(<PotRouteFacts route={route} admin={false} />);
    expect(html).toContain("Ready");
    expect(html).toContain("No sensor linked");
    expect(html).not.toMatch(/0x20|channel|Hardware details/);
  });
  it("keeps sensor addresses out of the researcher view", () => {
    const linked = { ...route, pairing: { name: "Zone6-Pot78", sensorKey: "BOARD:A", namedPot: 78 } };
    const html = renderToStaticMarkup(<PotRouteFacts route={linked} admin={false} />);
    expect(html).toContain("Linked");
    expect(html).not.toMatch(/BOARD:A|Zone6|0x20|channel/);
  });
  it("keeps admin hardware details collapsed and unresolved pots unavailable", () => {
    const html = renderToStaticMarkup(<PotRouteFacts route={{ ...route, status: "unmapped" }} admin />);
    expect(html).toContain("Needs setup");
    expect(html).toContain("Hardware details");
    expect(html).not.toMatch(/<details[^>]*open/);
  });
});

describe("pot panel without a valve route", () => {
  it("says watering is unavailable when the controller refuses, instead of loading forever", () => {
    // Audit 2026-11-25: manual-hold answered 409 "Hold-to-water is unavailable on this controller" and the panel kept saying "Loading valve routes…".
    expect(missingRouteText(null, "Hold-to-water is unavailable on this controller")).toBe("Watering is unavailable: Hold-to-water is unavailable on this controller");
    expect(missingRouteText(null, "")).toBe("Loading valve routes…");
    expect(missingRouteText({ pots: [] } as unknown as RouteBook, "")).toBe("This pot has no valve route on this controller.");
  });
});
