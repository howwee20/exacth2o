import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { GasMixerResearcherHome, GasMixerResearcherView } from "./ChamberControlView";

vi.mock("./supabase", () => ({ supabase: {} }));

describe("mixer researcher screens", () => {
  it("shows exactly one mixer tile and no irrigation or administrative modules", () => {
    const html = renderToStaticMarkup(<GasMixerResearcherHome allowed onOpen={() => {}} />);
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).toContain("Gas Mixer");
    expect(html).not.toMatch(/Experiment|Walker|Lighting|Settings|Chamber Control/);
  });
  it("does not show a mixer launch button after access is denied", () => {
    const html = renderToStaticMarkup(<GasMixerResearcherHome allowed={false} onOpen={() => {}} />);
    expect(html).not.toContain("<button");
    expect(html).toContain("access is unavailable");
  });
  it("opens only the native form with no remote-screen or lighting controls", () => {
    const html = renderToStaticMarkup(<GasMixerResearcherView onBack={() => {}} />);
    expect(html).toContain("Gas Mixer");
    expect(html).toContain("Home");
    expect(html).not.toMatch(/Secure view|Request control|Lights|live image|Lighting/i);
  });
});
