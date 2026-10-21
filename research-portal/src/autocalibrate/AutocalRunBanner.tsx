import { potName } from "./present";
import { useAutocalRun } from "./runStore";
import "./autocalibrate.css";

/**
 * Shown on every page while this tab drives an autocalibration run: what it is doing
 * and a Stop that works from anywhere. The run belongs to this tab; the banner says so.
 */
export function AutocalRunBanner({ onOpen }: { onOpen: () => void }) {
  const { live } = useAutocalRun();
  if (!live) return null;
  const progress = live.run.progress();
  const active = progress.activeValveKey ? live.potByValve.get(progress.activeValveKey) ?? null : null;
  return (
    <div className="ac-banner" role="region" aria-label="Autocalibration in progress">
      <span className="ac-banner-dot" aria-hidden="true" />
      <span className="ac-banner-text" aria-live="polite">
        <strong>{live.mode === "real" ? "Autocalibration running" : "Autocalibration rehearsal"}</strong>
        {" "}· {progress.completed} of {progress.total} valves measured
        {active ? ` · ${potName(active.potNumber, active.pairingName)}` : progress.phase === "baseline" ? " · reading baselines" : ""}
        {" "}· keep this tab open
      </span>
      <button type="button" className="ac-banner-open" onClick={onOpen}>Open</button>
      <button type="button" className="ac-banner-stop" onClick={() => live.run.abort("Stopped by the operator.")}>Stop</button>
    </div>
  );
}
