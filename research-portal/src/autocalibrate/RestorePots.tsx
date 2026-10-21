import { useCallback, useMemo, useState } from "react";
import { buildRestorePlan, planRestoreScope, type PotSettingsSnapshot } from "../commissioning/topologyPlan";
import { StatusChip } from "../SettingsChrome";
import type { PairingRow } from "../types";
import { BatchStatus } from "./BatchStatus";
import { potName } from "./present";
import { latestBatch, replaceBatch, withEvent, type TrackedBatch } from "./sessionRecord";
import { currentValveKeys, restoreReadback, reviewCycles } from "./sessionReview";
import { useBatchTracker } from "./useBatchTracker";
import type { WorkspaceContext } from "./workspaceContext";

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

function settingsText(pot: PotSettingsSnapshot) {
  const target = pot.wtcPercentLimit >= 0 && pot.wtcPercentLimit <= 100 && pot.valveOpenTimeMs > 0 ? `target ${pot.wtcPercentLimit}%, ${Math.round(pot.valveOpenTimeMs / 100) / 10} s pulses` : "automatic watering off";
  return `${target}, every ${Math.round(pot.measurementIntervalMs / 1000)} s`;
}

/** Final step: return the pots to their own recorded settings, holding back the ones that are not resolved. */
export function RestoreStep({ ctx, onBack }: { ctx: WorkspaceContext; onBack: (() => void) | null }) {
  const result = ctx.result;
  const complete = Boolean(result && (result.outcome === "completed" || result.outcome === "completed_with_findings"));
  const applyBatch = latestBatch(ctx.record, "apply");
  const rollbackBatch = latestBatch(ctx.record, "rollback");
  const restoreBatch = latestBatch(ctx.record, "restore");
  const [released, setReleased] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const scope = useMemo(() => {
    const cycles = complete && result ? reviewCycles(result, ctx.snapshot).cycles : [];
    const inForce = applyBatch?.readback === "verified" && rollbackBatch?.readback !== "verified" ? applyBatch.changes ?? [] : [];
    const pending = cycles.flatMap((cycle) => cycle.changes).filter((change) => !inForce.some((item) => item.pairingName === change.pairingName));
    const unverified = applyBatch && applyBatch.readback !== "verified" && applyBatch.readback !== "not_applied" ? applyBatch.changes ?? [] : [];
    return planRestoreScope({
      snapshot: ctx.snapshot,
      currentPairings: ctx.pairings,
      unresolved: complete && result ? result.unresolved : [],
      unclaimed: complete && result ? result.unclaimed : [],
      pendingChanges: pending,
      unverifiedChanges: unverified,
      releasedAnyway: released,
    });
  }, [applyBatch, complete, ctx.pairings, ctx.snapshot, released, result, rollbackBatch]);

  const restoringNames = restoreBatch?.pairingNames ?? scope.restore.map((pot) => pot.pairingName);
  const restoring = ctx.snapshot.filter((pot) => restoringNames.includes(pot.pairingName));
  const evaluate = useCallback((current: PairingRow[]) => restoreReadback(restoring, current) as TrackedBatch["readback"], [restoring]);
  const tracker = useBatchTracker({
    store: ctx.store,
    batch: restoreBatch,
    evaluate,
    onChange: (next) => void ctx.update((record) => {
      const heldBack = ctx.snapshot.filter((pot) => !(next.pairingNames ?? []).includes(pot.pairingName))
        .map((pot) => scope.heldBack.find((item) => item.pairingName === pot.pairingName) ?? { pairingName: pot.pairingName, reason: "Held back at restore" });
      const done = next.readback === "verified";
      return {
        record: withEvent({ ...replaceBatch(record, next), ...(done ? { heldBack } : {}) }, null, done
          ? `Restore confirmed by controller readback: ${next.pairingNames?.length ?? 0} pots back on their recorded settings; ${heldBack.length} left sensing-only.`
          : next.commands === "failed" ? `Restore did not complete: ${next.error ?? "failed"}.` : `Restore: commands ${next.commands}.`),
        ...(done ? { status: "restored" as const, active: false } : {}),
      };
    }),
  });

  const queue = async () => {
    setBusy(true);
    setError(null);
    try {
      if (!scope.restore.length) {
        await ctx.update((record) => ({
          status: "restored",
          active: false,
          record: withEvent({ ...record, heldBack: scope.heldBack }, ctx.operator, `Session closed with all ${scope.heldBack.length} pots left sensing-only.`),
        }));
        return;
      }
      const plan = buildRestorePlan(scope.restore, currentValveKeys(ctx.pairings));
      const queued = await ctx.queuePlan("restore", plan, { pairingNames: scope.restore.map((pot) => pot.pairingName) }, "restoring");
      if (!queued) setError("The restore was not queued. See the message at the top of Settings, then try again.");
    } catch (nextError) {
      setError(messageOf(nextError));
    } finally {
      setBusy(false);
    }
  };

  const pot = (name: string) => potName(ctx.byName.get(name)?.pot_number, name);

  return (
    <section className="settings-card ac-step" aria-labelledby="ac-restore-title">
      <div className="settings-card-head">
        <h3 id="ac-restore-title">Restore and finish</h3>
        <StatusChip tone={restoreBatch?.readback === "verified" ? "ok" : scope.heldBack.length ? "warning" : "info"}>
          {scope.restore.length} to restore · {scope.heldBack.length} held back
        </StatusChip>
      </div>
      {!complete ? (
        <p className="settings-muted">
          {result ? "The run did not finish, so no valve change is proposed." : "No run took place."} Every pot returns to its recorded settings and its pairing stays as it was.
        </p>
      ) : null}
      <p className="settings-muted">
        Each pot gets back its own target, pulse length and measurement interval exactly as recorded at {new Date(ctx.session.started_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })},
        on the valve the controller now reports for it. One controller command restores them all; the controller's readback confirms each value.
      </p>
      {scope.heldBack.length ? (
        <div className="ac-findings">
          <h4>Held back: stays sensing-only ({scope.heldBack.length})</h4>
          <p className="settings-muted">These pots keep automatic watering off, so the controller cannot water a pot whose valve is in doubt. Their original settings stay recorded and are carried into the next run.</p>
          <ul className="ac-held">
            {scope.heldBack.map((item) => (
              <li key={item.pairingName}>
                <span><strong>{pot(item.pairingName)}</strong> · {item.reason}</span>
                {!restoreBatch ? (
                  <label className="settings-check">
                    <input type="checkbox" checked={released.has(item.pairingName)} onChange={(event) => setReleased((current) => {
                      const next = new Set(current);
                      if (event.target.checked) next.add(item.pairingName); else next.delete(item.pairingName);
                      return next;
                    })} />
                    <span>Restore anyway: I checked this pot at the bench</span>
                  </label>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <details className="ac-advanced">
        <summary>Recorded settings for the {scope.restore.length} pots being restored</summary>
        <ul className="commission-plain">
          {scope.restore.map((item) => <li key={item.pairingName}><span>{pot(item.pairingName)}: {settingsText(item)}</span></li>)}
        </ul>
      </details>
      {!restoreBatch || restoreBatch.readback === "not_applied" ? (
        <div className="ac-actions">
          <button type="button" className="settings-primary-button" disabled={busy || ctx.controlBusy || (!ctx.configHash && scope.restore.length > 0)} onClick={() => void queue()}>
            {busy ? "Queuing…" : scope.restore.length ? `Queue the restore: ${scope.restore.length} pots` : "Close the session"}
          </button>
          {onBack ? <button type="button" className="settings-secondary-button" onClick={onBack}>Back</button> : null}
        </div>
      ) : null}
      {restoreBatch ? (
        <BatchStatus batch={restoreBatch} expired={tracker.expired} onRecheck={() => void tracker.recheck()}
          readbackText={restoreBatch.readback === "verified" ? `The controller reports all ${restoring.length} pots on their recorded settings.` : restoreBatch.readback === "mismatch" ? "Some pots report values that match neither the recorded settings nor the prepared state." : "Waiting for the controller to report its settings."} />
      ) : null}
      {error ? <p className="settings-error-line" role="alert">{error}</p> : null}
    </section>
  );
}
