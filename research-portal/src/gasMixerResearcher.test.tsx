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
  it("includes native controls, the original live remote screen, and lighting in the same tile", () => {
    const html = renderToStaticMarkup(<GasMixerResearcherView onBack={() => {}} />);
    expect(html).toContain("Gas Mixer");
    expect(html).toContain("Gas Mixer V2");
    expect(html).toContain("Secure view");
    expect(html).toContain("Request control");
    expect(html).toContain("Lights");
    expect(html).toContain("Back");
    expect(html).not.toMatch(/New Experiment|Walker/);
  });
});
