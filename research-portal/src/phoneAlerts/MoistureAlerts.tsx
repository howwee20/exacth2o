import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { supabase } from "../supabase";
import { PhoneSetup } from "./PhoneSetup";
import "./moisture.css";

type Rule = { min: number; max: number; enabled: boolean; version: string };
type Settings = { rule: Rule | null; following: boolean };
export type AlertEditor = {
  validate: () => string | null;
  save: (id: string) => Promise<void>;
};
type Props = {
  projectId: string;
  deviceId: string;
  experimentId?: string;
  targets: number[];
};
const fresh: Settings = { rule: null, following: false };

export const MoistureAlerts = forwardRef<AlertEditor, Props>(
  function MoistureAlerts({ projectId, deviceId, experimentId, targets }, ref) {
    const setupLink =
      new URLSearchParams(location.search).get("phoneSetup") === "1";
    const [saved, setSaved] = useState<Settings>(fresh);
    const [ready, setReady] = useState(!experimentId);
    const [failed, setFailed] = useState(false);
    const [revision, setRevision] = useState(0);
    const [enabled, setEnabled] = useState(false);
    const [following, setFollowing] = useState(false);
    const [connected, setConnected] = useState<boolean | null>(null);
    const [bounds, setBounds] = useState<{ min: string; max: string } | null>(
      null,
    );
    const [setup, setSetup] = useState(setupLink);
    const [busy, setBusy] = useState(false);
    const [feedback, setFeedback] = useState("");
    const section = useRef<HTMLElement>(null);
    const low = targets.length ? Math.max(0, Math.min(...targets) - 5) : 20;
    const high = targets.length ? Math.min(100, Math.max(...targets) + 5) : 40;
    const values = bounds ?? { min: String(low), max: String(high) };
    useEffect(() => {
      if (setupLink) section.current?.scrollIntoView({ block: "center" });
    }, [setupLink]);
    useEffect(() => {
      if (!experimentId) return;
      let active = true;
      setReady(false);
      setFailed(false);
      void supabase
        .rpc("experiment_moisture_alerts", { eid: experimentId })
        .then(({ data, error }) => {
          if (!active) return;
          if (error) {
            setFailed(true);
            return;
          }
          const result = data as Settings;
          setSaved(result);
          setEnabled(result.rule?.enabled ?? false);
          setFollowing(result.following);
          if (result.rule)
            setBounds({
              min: String(result.rule.min),
              max: String(result.rule.max),
            });
          setReady(true);
        });
      return () => {
        active = false;
      };
    }, [experimentId, revision]);
    const connectedChanged = useCallback((v: boolean) => setConnected(v), []);
    const ruleChanged =
      enabled !== Boolean(saved.rule?.enabled) ||
      (enabled &&
        (Number(values.min) !== saved.rule?.min ||
          Number(values.max) !== saved.rule?.max));
    const changed = ruleChanged || following !== saved.following;
    function validate() {
      if (
        enabled &&
        (!values.min.trim() ||
          !values.max.trim() ||
          !Number.isFinite(Number(values.min)) ||
          !Number.isFinite(Number(values.max)) ||
          Number(values.min) < 0 ||
          Number(values.max) > 100 ||
          Number(values.min) >= Number(values.max))
      )
        return "Enter a minimum below the maximum, from 0 to 100% VWC.";
      if (following !== saved.following && following && !connected)
        return "Connect a device first or turn off Notify me.";
      return null;
    }
    async function save(id: string) {
      if (!changed) return;
      const invalid = validate();
      if (invalid) throw new Error(invalid);
      const { data, error } = await supabase.rpc(
        "save_experiment_moisture_alerts",
        {
          eid: id,
          device: deviceId,
          write_rule: ruleChanged,
          active: enabled,
          low: enabled ? Number(values.min) : (saved.rule?.min ?? low),
          high: enabled ? Number(values.max) : (saved.rule?.max ?? high),
          expected_version: saved.rule?.version ?? null,
          follow: following !== saved.following ? following : null,
        },
      );
      if (error) throw new Error(error.message);
      const result = data as Settings;
      setSaved(result);
      setFeedback("Alert settings saved.");
    }
    useImperativeHandle(ref, () => ({ validate, save }));
    return (
      <section
        ref={section}
        className="xb-section moisture-alerts"
        aria-label="Moisture alerts"
      >
        <div className="xb-heading">
          <h3>Moisture alerts</h3>
        </div>
        {failed ? (
          <p role="alert">
            Alert settings could not be loaded.{" "}
            <button type="button" onClick={() => setRevision((x) => x + 1)}>
              Reload alerts
            </button>
          </p>
        ) : null}
        <fieldset disabled={!ready || busy}>
          <label className="moisture-check">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => {
                setEnabled(e.target.checked);
                setFeedback("");
              }}
            />
            Monitor pots in this experiment
          </label>
          {enabled && (
            <>
              <div className="moisture-bounds">
                {(["min", "max"] as const).map((key) => (
                  <label key={key}>
                    {key === "min" ? "Min" : "Max"} VWC (%)
                    <input
                      type="number"
                      step="any"
                      min="0"
                      max="100"
                      value={values[key]}
                      onChange={(e) => {
                        setBounds({ ...values, [key]: e.target.value });
                        setFeedback("");
                      }}
                    />
                  </label>
                ))}
              </div>
              <p>
                One alert when any pot drops below the minimum or rises above
                the maximum.{" "}
                {bounds === null ? "Suggested limits are editable." : null}
              </p>
            </>
          )}
          {(enabled || following) && (
            <>
              <label className="moisture-check">
                <input
                  type="checkbox"
                  checked={following}
                  onChange={(e) => {
                    setFollowing(e.target.checked);
                    setFeedback("");
                    if (e.target.checked) setSetup(true);
                  }}
                />
                Notify me on my phone
              </label>
              {following && (
                <p>Up to 10 phone alerts per day across your experiments.</p>
              )}
            </>
          )}
          {(enabled || following || setupLink) && (
            <button
              type="button"
              aria-expanded={setup}
              onClick={() => setSetup((v) => !v)}
            >
              {setup ? "Hide phone setup" : "Phone setup"}
            </button>
          )}
          {setup && (enabled || following || setupLink) && (
            <PhoneSetup projectId={projectId} onConnected={connectedChanged} />
          )}
          {experimentId && changed && (
            <button
              type="button"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await save(experimentId);
                } catch (e) {
                  setFeedback(
                    e instanceof Error ? e.message : "Could not save alerts.",
                  );
                } finally {
                  setBusy(false);
                }
              }}
            >
              Save alert settings
            </button>
          )}
          {feedback && <p role="status">{feedback}</p>}
        </fieldset>
      </section>
    );
  },
);
