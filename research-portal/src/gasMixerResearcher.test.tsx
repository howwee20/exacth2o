import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { GasMixerResearcherHome, GasMixerResearcherView } from "./ChamberControlView";

vi.mock("./supabase", () => ({ supabase: {} }));

describe("mixer researcher screens", () => {
  it("shows one chamber tile with its footer actions", () => {
    const html = renderToStaticMarkup(<GasMixerResearcherHome allowed onOpen={() => {}} />);
    expect(html.match(/<button/g)).toHaveLength(2);
    expect(html).toContain("Chamber");
    expect(html).toContain("Active experiment");
    expect(html).toContain("System health");
    expect(html).not.toMatch(/Walker|Lighting|Sales &amp; Support|Chamber Control/);
  });
  it("does not show a mixer launch button after access is denied", () => {
    const html = renderToStaticMarkup(<GasMixerResearcherHome allowed={false} onOpen={() => {}} />);
    expect(html).not.toContain("<button");
    expect(html).toContain("access is unavailable");
  });
  it("includes native controls, the original live remote screen, and lighting in the same tile", () => {
    const html = renderToStaticMarkup(<GasMixerResearcherView onBack={() => {}} />);
    expect(html).toContain("Gas mixer");
    expect(html).toContain("Remote touchscreen");
    expect(html).toContain("Secure view");
    expect(html).toContain("Request control");
    expect(html).toContain("Lights");
    expect(html).toMatch(/<button\b[^>]*class="px-home-button"[^>]*>[\s\S]*?Home<\/button>/);
    expect(html).not.toMatch(/New Experiment|Walker/);
  });
});
