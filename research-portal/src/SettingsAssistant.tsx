import { useState } from "react";
import { AlertTriangle, Check, Loader2, Send, Sparkles } from "lucide-react";
import { draftSettings } from "./experimentClient";
import {
  settingsCommandLabel,
  type SettingsPlan,
} from "./settingsSpec";

type SettingsAssistantProps = {
  projectId: string;
  controlBusy: boolean;
  onApply: (plan: SettingsPlan, configHash: string) => Promise<void>;
};

export function SettingsAssistant({
  projectId,
  controlBusy,
  onApply,
}: SettingsAssistantProps) {
  const [prompt, setPrompt] = useState("");
  const [revision, setRevision] = useState("");
  const [plan, setPlan] = useState<SettingsPlan | null>(null);
  const [configHash, setConfigHash] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const requestPlan = async (request: string, currentPlan?: SettingsPlan) => {
    if (!request.trim()) {
      setError("Describe the setting change.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await draftSettings(projectId, request.trim(), currentPlan);
      setPlan(result.plan);
      setConfigHash(result.config_hash);
      setConfirmed(false);
      setRevision("");
      if (result.validation_messages.length) {
        setError(result.validation_messages.join(" "));
      }
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Could not review the request.");
    } finally {
      setBusy(false);
    }
  };

  const applyPlan = async () => {
    if (!plan || !configHash || !confirmed || plan.questions.length) return;
    setError(null);
    try {
      await onApply(plan, configHash);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Could not apply the request.");
    }
  };

  return (
    <div className="settings-assistant">
      <section className="settings-card settings-assistant-request">
        <div className="settings-assistant-title">
          <Sparkles size={17} />
          <h3>Assistant</h3>
        </div>
        <textarea
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          maxLength={4_000}
          placeholder="Set pots 15–26 to 30%, open 5 seconds, measure every 10 minutes."
        />
        <button
          type="button"
          className="settings-primary-button"
          onClick={() => void requestPlan(prompt)}
          disabled={busy || controlBusy || !prompt.trim()}
        >
          {busy ? <Loader2 className="chart-loading-spinner" size={15} /> : <Send size={15} />}
          Review
        </button>
      </section>

      {plan ? (
        <section className="settings-card settings-assistant-review">
          <h3>{plan.summary}</h3>
          <div className="settings-assistant-command-list">
            {plan.commands.map((command, index) => (
              <div key={`${command.command_type}-${index}`}>
                <strong>{settingsCommandLabel(command.command_type)}</strong>
                <div className="settings-assistant-command-copy">
                  <span>{command.effect}</span>
                  <code>{JSON.stringify(command.payload)}</code>
                </div>
              </div>
            ))}
          </div>
          {plan.questions.length ? (
            <div className="settings-callout is-error">
              <AlertTriangle size={17} />
              <div>{plan.questions.map((question) => <p key={question}>{question}</p>)}</div>
            </div>
          ) : null}
          <div className="settings-assistant-revise">
            <input
              value={revision}
              onChange={(event) => setRevision(event.target.value)}
              placeholder="Change this plan"
            />
            <button
              type="button"
              className="settings-secondary-button"
              onClick={() => void requestPlan(revision, plan)}
              disabled={busy || controlBusy || !revision.trim()}
            >
              Revise
            </button>
          </div>
          <label className="settings-assistant-confirm">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            I reviewed these changes.
          </label>
          <button
            type="button"
            className="settings-primary-button"
            onClick={() => void applyPlan()}
            disabled={
              busy ||
              controlBusy ||
              !confirmed ||
              plan.commands.length === 0 ||
              plan.questions.length > 0
            }
          >
            {controlBusy ? <Loader2 className="chart-loading-spinner" size={15} /> : <Check size={15} />}
            Apply
          </button>
        </section>
      ) : null}
      {error ? <p className="settings-error-line" role="alert">{error}</p> : null}
      <p className="settings-muted">
        Manual water and sensor initialization stay locked.
      </p>
    </div>
  );
}
