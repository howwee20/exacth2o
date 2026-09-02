import { AlertTriangle, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  lightingMaxIntensity,
  lightingMinIntensity,
  lightingSourceLabel,
  normalizeLightingIntensity,
  type LightingNativeStatus,
} from "./lightingNative";
import {
  loadLightingNativeStatus,
  sendLightingIntensity,
} from "./lightingNativeClient";

type ControlPhase = "idle" | "sending" | "confirmed" | "failed";

export function LightingNativeControl() {
  const [status, setStatus] = useState<LightingNativeStatus | null>(null);
  const [draftIntensity, setDraftIntensity] = useState(0);
  const [phase, setPhase] = useState<ControlPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const dirty = useRef(false);
  const pendingCommand = useRef<string | null>(null);

  useEffect(() => {
    let active = true;
    const refresh = () => {
      loadLightingNativeStatus()
        .then((next) => {
          if (!active) return;
          setStatus(next);
          if (!dirty.current) setDraftIntensity(next.controller_intensity);

          if (next.last_command && pendingCommand.current === next.last_command.id) {
            if (next.last_command.status === "observed") {
              pendingCommand.current = null;
              dirty.current = false;
              setDraftIntensity(next.controller_intensity);
              setPhase("confirmed");
              setError(null);
            } else if (["failed", "expired"].includes(next.last_command.status)) {
              pendingCommand.current = null;
              dirty.current = false;
              setPhase("failed");
              setError(next.last_command.error_message ?? "The controller rejected that lighting value");
            }
          }
        })
        .catch((reason) => {
          if (!active) return;
          setError(reason instanceof Error ? reason.message : "Lighting state is unavailable");
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    };

    refresh();
    const timer = window.setInterval(refresh, 1_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  const ready = status?.bridge_ready === true && status.remote_control_allowed;
  const lightOn = (status?.controller_intensity ?? 0) > 0;

  const commit = async (rawIntensity: number) => {
    if (!status || !ready || pendingCommand.current) return;
    let intensity: number;
    try {
      intensity = normalizeLightingIntensity(rawIntensity);
    } catch (reason) {
      setPhase("failed");
      setError(reason instanceof Error ? reason.message : "Invalid light intensity");
      return;
    }

    dirty.current = true;
    setDraftIntensity(intensity);
    setPhase("sending");
    setError(null);
    try {
      const result = await sendLightingIntensity(intensity, status.state_revision);
      pendingCommand.current = result.command.id;
    } catch (reason) {
      dirty.current = false;
      setPhase("failed");
      setError(reason instanceof Error ? reason.message : "Unable to send the lighting value");
    }
  };

  const toggle = () => {
    if (!status) return;
    const next = lightOn
      ? 0
      : Math.min(lightingMaxIntensity, Math.max(lightingMinIntensity, status.last_nonzero_intensity));
    void commit(next);
  };

  return (
    <section className="chamber-module is-lighting">
      <header className="is-iconless">
        <div><h2>Lights</h2></div>
        <span className={`chamber-status ${ready ? "is-online" : "is-offline"}`}>
          {loading ? "Checking" : ready ? "Ready" : "Commissioning"}
        </span>
      </header>

      <div className="lighting-native-panel">
        <div className="lighting-native-form">
          <label className="lighting-native-switch">
            <span>Light</span>
            <input
              type="checkbox"
              aria-label="Turn chamber light on or off"
              checked={lightOn}
              disabled={!ready || pendingCommand.current !== null}
              onChange={toggle}
            />
            <strong>{lightOn ? "On" : "Off"}</strong>
          </label>

          <label className="lighting-native-intensity">
            <span>Intensity</span>
            <span className="lighting-native-number-wrap">
              <input
                className={`lighting-native-number is-${phase}`}
                type="number"
                min="0"
                max={lightingMaxIntensity}
                step="1"
                inputMode="numeric"
                value={draftIntensity}
                readOnly={!ready}
                aria-label="Chamber light intensity"
                onFocus={(event) => event.currentTarget.select()}
                onChange={(event) => {
                  dirty.current = true;
                  setDraftIntensity(Number(event.currentTarget.value));
                  setPhase("idle");
                  setError(null);
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  void commit(draftIntensity);
                  event.currentTarget.select();
                }}
              />
              <small>µmol m⁻² s⁻¹</small>
            </span>
            <em>Enter 0 for off, or {lightingMinIntensity}-{lightingMaxIntensity}, then press Enter.</em>
          </label>
        </div>

        <div className="lighting-native-state" aria-live="polite">
          <dl>
            <div><dt>Last changed by</dt><dd>{status ? lightingSourceLabel(status.last_source) : "Waiting"}</dd></div>
          </dl>
          <div className="lighting-native-receipt">
            {loading || phase === "sending" ? <Loader2 className="chart-loading-spinner" size={16} /> : null}
            {error ? <><AlertTriangle size={16} /><span>{error}</span></> : null}
            {!loading && !error ? (
              <span>{ready
                ? phase === "confirmed"
                  ? "Applied and observed in the Windows controller"
                  : "Synchronized with the Windows controller"
                : "Windows bridge pending"}</span>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}
