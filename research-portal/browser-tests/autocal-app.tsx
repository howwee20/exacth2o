// LOCAL PREVIEW AND BROWSER TESTS ONLY. Settings → Autocalibrate and manual watering
// against the simulated 100-pot controller in fake-backend.ts. No network, no hardware.
import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { Droplets } from "lucide-react";
import { AutocalibrateWorkspace } from "../src/autocalibrate/AutocalibrateWorkspace";
import { AutocalRunBanner } from "../src/autocalibrate/AutocalRunBanner";
import type { PortalExperiment } from "../src/experimentRegistry";
import type { PortalRole } from "../src/portalAccess";
import { ManualWaterPanel } from "../src/product/ManualWaterPanel";
import { supabase } from "../src/supabase";
import { FakeBackend, harnessIds } from "./fake-backend";
import { clockSpeed } from "./virtual-clock";
import "../src/styles.css";
import "../src/product/product.css";

const params = new URLSearchParams(location.search);
const fake = new FakeBackend({ preset: params.get("preset") === "issues" ? "issues" : "clean" });
fake.install(supabase);
(window as unknown as { __preview: FakeBackend }).__preview = fake;

const role = (params.get("role") ?? "researcher") as PortalRole;
const scope = params.get("scope") === "experiment" ? "experiment" : "installation";
const experiment: PortalExperiment = {
  id: "zone-2-drydown",
  name: "Zone 2 dry-down (simulated)",
  shortDescription: "Preview experiment on the simulated controller",
  mode: "controlled",
  groupNames: [],
  pairingNames: Array.from({ length: 25 }, (_, index) => `Zone2-Pot${index + 26}`),
};

function Preview() {
  const [version, setVersion] = useState(0);
  const [manual, setManual] = useState(false);
  const [speed, setSpeed] = useState(clockSpeed());
  useEffect(() => {
    const update = () => setSpeed(clockSpeed());
    window.addEventListener("preview-clock", update);
    return () => window.removeEventListener("preview-clock", update);
  }, []);
  useEffect(() => {
    let frame = 0;
    return fake.subscribe(() => {
      if (frame) return;
      frame = requestAnimationFrame(() => { frame = 0; setVersion((value) => value + 1); });
    });
  }, []);
  const hash = fake.hash;
  const pairings = useMemo(() => fake.portalPairings(), [hash]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <main className="px-shell ac-preview" data-version={version}>
      <header className="px-header">
        <strong className="ac-preview-title">ExactH2O · Autocalibrate preview</strong>
        <span className="ac-preview-note">Simulated 100-pot controller · no hardware · simulated clock ×{speed}</span>
        <div className="px-header-actions">
          <span className="ac-preview-speed" role="group" aria-label="Simulated clock speed">
            {[1, 60, 600].map((value) => (
              <button key={value} type="button" aria-pressed={speed === value} onClick={() => (window as unknown as { __setClockSpeed: (next: number) => void }).__setClockSpeed(value)}>×{value}</button>
            ))}
          </span>
          <button type="button" className="px-header-button" onClick={() => setManual(true)} aria-label="Manual water">
            <Droplets size={14} aria-hidden="true" /> <span className="px-label-wide">Manual water</span>
          </button>
        </div>
      </header>
      <AutocalRunBanner onOpen={() => document.getElementById("ac-root")?.scrollIntoView()} />
      <section className="settings-content is-autocalibrate ac-preview-body">
        <div className="settings-section-body" id="ac-root">
          <AutocalibrateWorkspace
            projectId={harnessIds.project}
            deviceId={harnessIds.device}
            operator="preview.researcher"
            portalRole={role}
            scope={scope}
            experiment={experiment}
            experiments={[experiment]}
            pairings={pairings}
            configHash={hash}
            controllerState={fake.state}
            controllerOnline
            controlBusy={false}
            onQueueSettingsPlan={async (plan, configHash) => fake.queueSettingsPlan(plan, configHash)}
          />
        </div>
      </section>
      <ManualWaterPanel open={manual} onClose={() => setManual(false)} projectId={harnessIds.project} deviceId={harnessIds.device} controllerName="Simulated controller" />
    </main>
  );
}

const style = document.createElement("style");
style.textContent = `
  .ac-preview { --settings-action: #356b8c; --settings-action-hover: #285874; min-height: 100vh; background: #f4f6f5; }
  .ac-preview .settings-content.ac-preview-body { height: auto; overflow: visible; }
  .ac-preview .px-header { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; padding: 10px 16px; }
  .ac-preview-title { font-size: 15px; }
  .ac-preview-note { color: #56645c; font-size: 12.5px; flex: 1 1 auto; }
  .ac-preview-body { max-width: 1240px; margin: 0 auto; padding: 16px; }
  .ac-preview-speed { display: inline-flex; gap: 4px; }
  .ac-preview-speed button { min-height: 32px; padding: 0 8px; border: 1px solid rgba(255,255,255,.4); border-radius: 6px; background: transparent; color: inherit; font: 600 12px var(--px-mono, monospace); cursor: pointer; }
  .ac-preview-speed button[aria-pressed="true"] { background: #fff; color: #0e1a14; }
`;
document.head.appendChild(style);
createRoot(document.getElementById("root")!).render(<Preview />);
