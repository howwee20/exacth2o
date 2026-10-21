import { StatusChip } from "../SettingsChrome";
import { formatClock } from "./present";
import type { TrackedBatch } from "./sessionRecord";

const commandsText: Record<TrackedBatch["commands"], string> = {
  queued: "Queued; the controller applies it in order (stop, change, restart)",
  succeeded: "Every command completed",
  failed: "A command failed",
  unknown: "Waiting for the command queue",
};

/**
 * One queued change, reported as two separate facts: what the command queue says,
 * and what the controller's own configuration shows when it is read back.
 */
export function BatchStatus({ batch, readbackText, expired, onRecheck }: { batch: TrackedBatch; readbackText: string; expired: boolean; onRecheck: () => void }) {
  const tone = batch.readback === "verified" ? "ok" : batch.commands === "failed" || batch.readback === "mismatch" ? "bad" : "unknown";
  return (
    <div className="ac-batch" aria-live="polite">
      <div className="settings-card-head">
        <strong>{batch.summary}</strong>
        <StatusChip tone={tone}>
          {batch.readback === "verified" ? "Confirmed by controller readback" : batch.readback === "not_applied" ? "Not applied" : batch.readback === "mismatch" ? "Readback does not match" : "Waiting for the controller"}
        </StatusChip>
      </div>
      <ol className="ac-batch-steps">
        <li data-state={batch.commands === "queued" || batch.commands === "unknown" ? "current" : batch.commands === "failed" ? "bad" : "done"}>
          <span>Command queue</span><span>{commandsText[batch.commands]}{batch.commands === "queued" ? ` · queued ${formatClock(batch.queuedAt)}` : ""}</span>
        </li>
        <li data-state={batch.readback === "verified" ? "done" : batch.readback === "pending" ? (batch.commands === "queued" ? "waiting" : "current") : "bad"}>
          <span>Controller readback</span><span>{readbackText}{batch.verifiedAt ? ` · ${formatClock(batch.verifiedAt)}` : ""}</span>
        </li>
      </ol>
      {batch.error ? <p className="settings-error-line">{batch.error}</p> : null}
      {batch.commands === "failed" && batch.error && /restart|update_system_state|Stop or restart/i.test(batch.error) ? (
        <p className="ac-notice">The controller may have been left stopped. Check its state in Settings → Watering and restart it there once the change is understood.</p>
      ) : null}
      {expired ? (
        <p className="settings-muted">The controller has not reported this change yet. <button type="button" className="ac-link" onClick={onRecheck}>Check again</button></p>
      ) : null}
    </div>
  );
}
