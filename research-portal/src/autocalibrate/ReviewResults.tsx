import { useCallback, useMemo, useState } from "react";
import { Download, Undo2 } from "lucide-react";
import { buildRemapPlan, invertChanges, type ValveChange } from "../commissioning/topologyPlan";
import type { CommissioningResult } from "../commissioning/types";
import { AerialBench } from "../product/AerialBench";
import { StatusChip } from "../SettingsChrome";
import { confidenceLevel } from "../topology/confidence";
import type { PairingRow } from "../types";
import { BatchStatus } from "./BatchStatus";
import { EvidenceTable } from "./EvidenceTable";
import { faultAdvice, faultText, formatWhen, outcomeText, potName, resultCounts, resultStates } from "./present";
import { latestBatch, replaceBatch, withEvent, type TrackedBatch } from "./sessionRecord";
import { applyPreconditions, referenceChecks, remapReadback, reviewCycles, type ChangeCycle } from "./sessionReview";
import { useBatchTracker } from "./useBatchTracker";
import { valveLabel, type WorkspaceContext } from "./workspaceContext";

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function downloadJson(name: string, value: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function cycleText(cycle: ChangeCycle, ctx: WorkspaceContext) {
  const number = (name: string) => ctx.byName.get(name)?.pot_number ?? Number.POSITIVE_INFINITY;
  const pot = (name: string) => potName(ctx.byName.get(name)?.pot_number, name);
  if (cycle.changes.length === 2) {
    const [a, b] = cycle.changes.map((change) => change.pairingName).sort((x, y) => number(x) - number(y));
    return `Swap: ${pot(a)} ↔ ${pot(b)}`;
  }
  // Start the cycle at its lowest-numbered pot, keeping the direction water moves.
  const start = cycle.changes.reduce((best, change, index) => (number(change.pairingName) < number(cycle.changes[best].pairingName) ? index : best), 0);
  const ordered = [...cycle.changes.slice(start), ...cycle.changes.slice(0, start)];
  return `Cycle of ${ordered.length}: ${ordered.slice(0, 6).map((change) => pot(change.pairingName)).join(" → ")}${ordered.length > 6 ? " → …" : ""} → ${pot(ordered[0].pairingName)}`;
}

/** Steps 5 and 6: what the run found, the reviewed change, and its verification. */
export function ReviewStep({ ctx }: { ctx: WorkspaceContext }) {
  if (!ctx.result) {
    return (
      <section className="settings-card ac-step">
        <h3>Results</h3>
        {ctx.resultLoading ? <p className="settings-muted">Loading the run's evidence…</p> : (
          <>
            <p className="settings-error-line">{ctx.resultError ?? "This session's evidence could not be loaded."}</p>
            <button type="button" className="settings-secondary-button" onClick={() => void ctx.loadResult()}>Try again</button>
          </>
        )}
      </section>
    );
  }
  return <Review ctx={ctx} result={ctx.result} />;
}

function Review({ ctx, result }: { ctx: WorkspaceContext; result: CommissioningResult }) {
  const counts = resultCounts(result);
  const { cycles, incomplete, confirmed } = useMemo(() => reviewCycles(result, ctx.snapshot), [result, ctx.snapshot]);
  const weak = confirmed.filter((proposal) => proposal.status === "needs_review");
  const references = referenceChecks(result);
  const referenceTrouble = references.filter((item) => item.outcome !== "matched");
  const states = useMemo(() => resultStates(result, ctx.potForSensor), [result, ctx.potForSensor]);
  const selected = useMemo(() => new Set(result.pots.map((pot) => pot.pairingName)), [result.pots]);
  const potByValve = useMemo(() => new Map(result.pots.map((pot) => [pot.valveKey, { pairingName: pot.pairingName, potNumber: pot.potNumber }])), [result.pots]);
  const applyBatch = latestBatch(ctx.record, "apply");
  const rollbackBatch = latestBatch(ctx.record, "rollback");
  const applied = applyBatch && applyBatch.readback !== "not_applied";
  const [approved, setApproved] = useState<Set<string>>(() => new Set(ctx.record.approvedCycles));
  const [acknowledged, setAcknowledged] = useState<Set<string>>(new Set());
  const [referencesAcknowledged, setReferencesAcknowledged] = useState(false);
  const [phrase, setPhrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const blockedCycle = (cycle: ChangeCycle) => cycle.touchesReference
    ? "Involves a known-correct reference pot that came out differently. It is not applied from this run: check it at the bench and run again."
    : null;
  const canApprove = (cycle: ChangeCycle) => !blockedCycle(cycle) && (cycle.clean || acknowledged.has(cycle.id)) && (!referenceTrouble.length || referencesAcknowledged);
  const chosen = cycles.filter((cycle) => approved.has(cycle.id) && canApprove(cycle));
  const changes: ValveChange[] = chosen.flatMap((cycle) => cycle.changes);
  const preconditions = changes.length ? applyPreconditions(changes, ctx.pairings) : [];
  const remapId = `${ctx.session.run_id}-apply-${ctx.record.batches.filter((batch) => batch.kind === "apply").length + 1}`;
  const built = changes.length ? buildRemapPlan(changes, ctx.snapshot, "apply", remapId) : { plan: null, problems: [] as string[] };
  const applyPhrase = `APPLY ${changes.length} VALVE ${changes.length === 1 ? "CHANGE" : "CHANGES"}`;

  const rollbackChanges = applyBatch?.changes ? invertChanges(applyBatch.changes) : [];
  const rollbackPhrase = `ROLL BACK ${rollbackChanges.length} VALVE ${rollbackChanges.length === 1 ? "CHANGE" : "CHANGES"}`;
  const [rollbackText, setRollbackText] = useState("");

  const reconcile = useCallback(async (next: TrackedBatch) => {
    if (next.readback !== "verified" || next.reconciled || !next.changes?.length) return next;
    try {
      const proposals = new Map(result.proposals.map((proposal) => [proposal.valveKey, proposal]));
      const outcome = await ctx.store.reconcileBindings(ctx.session.run_id, next.changes.map((change) => {
        const proposal = proposals.get(change.toValveKey);
        return {
          pairing_name: change.pairingName,
          sensor_key: change.sensorKey,
          valve_key: change.toValveKey,
          evidence: next.kind === "apply" && proposal
            ? { run_id: ctx.session.run_id, confidence: proposal.confidence, delta_vwc: proposal.deltaVwc, z: proposal.z, command_id: proposal.commandId }
            : { run_id: ctx.session.run_id, rollback: true },
        };
      }));
      return { ...next, reconciled: { count: outcome.reconciled, skipped: outcome.skipped } };
    } catch (reconcileError) {
      return { ...next, error: `Controller readback confirmed the change, but the pot records could not be updated yet: ${messageOf(reconcileError)}` };
    }
  }, [ctx.session.run_id, ctx.store, result.proposals]);

  const track = (batch: TrackedBatch | null, verifiedStatus: "verified" | "rolled_back") => ({
    store: ctx.store,
    batch,
    evaluate: (current: PairingRow[]) => batch?.changes ? remapReadback(batch.changes, current, ctx.snapshot) : "pending" as const,
    onChange: (next: TrackedBatch) => void reconcile(next).then((final) => ctx.update((record) => ({
      record: withEvent(replaceBatch(record, final), null, final.readback === "verified"
        ? `${final.kind === "apply" ? "Change" : "Rollback"} confirmed by controller readback: ${final.changes?.length ?? 0} pots${final.reconciled ? `; ${final.reconciled.count} pot records updated` : ""}.`
        : final.commands === "failed" ? `${final.kind === "apply" ? "Change" : "Rollback"} did not complete (${final.error ?? "failed"}); readback: ${final.readback.replace("_", " ")}.`
          : `${final.kind === "apply" ? "Change" : "Rollback"}: commands ${final.commands}.`),
      status: final.readback === "verified" ? verifiedStatus : final.readback === "not_applied" ? (final.kind === "apply" ? "analyzed" : "verified") : final.commands === "succeeded" || final.readback === "mismatch" ? "applied" : undefined,
    }))),
  });
  const applyTracker = useBatchTracker(track(applyBatch, "verified"));
  const rollbackTracker = useBatchTracker(track(rollbackBatch, "rolled_back"));

  const queueApply = async () => {
    if (!built.plan) return;
    setBusy(true);
    setError(null);
    try {
      await ctx.update((record) => ({ record: withEvent({ ...record, approvedCycles: chosen.map((cycle) => cycle.id) }, ctx.operator, `Approved ${chosen.length} change group(s) covering ${changes.length} pots.`) }));
      const queued = await ctx.queuePlan("apply", built.plan, { changes }, "applying");
      if (!queued) setError("The change was not queued. See the message at the top of Settings, then try again.");
      setPhrase("");
    } catch (nextError) {
      setError(messageOf(nextError));
    } finally {
      setBusy(false);
    }
  };

  const queueRollback = async () => {
    const plan = buildRemapPlan(rollbackChanges, ctx.snapshot, "rollback", `${ctx.session.run_id}-rollback-${ctx.record.batches.filter((batch) => batch.kind === "rollback").length + 1}`);
    if (!plan.plan) {
      setError(plan.problems.join(" "));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const queued = await ctx.queuePlan("rollback", plan.plan, { changes: rollbackChanges }, "applying");
      if (!queued) setError("The rollback was not queued. See the message at the top of Settings, then try again.");
      setRollbackText("");
    } catch (nextError) {
      setError(messageOf(nextError));
    } finally {
      setBusy(false);
    }
  };

  const outcome = outcomeText[result.outcome];
  const rollbackProblems = rollbackChanges.length ? applyPreconditions(rollbackChanges, ctx.pairings) : [];

  return (
    <>
      <section className="settings-card ac-step" aria-labelledby="ac-results-title">
        <div className="settings-card-head">
          <h3 id="ac-results-title">Results · {formatWhen(result.endedAt)}</h3>
          <StatusChip tone={outcome.tone}>{outcome.label}</StatusChip>
        </div>
        <dl className="ac-stats is-results">
          <div><dt>Valves tested</dt><dd>{counts.tested} of {counts.total}</dd></div>
          <div><dt>Match the record</dt><dd>{counts.matched}</dd></div>
          <div><dt>Water a different pot</dt><dd>{counts.different}{cycles.length ? ` (${cycles.length} group${cycles.length === 1 ? "" : "s"})` : ""}</dd></div>
          <div><dt>Need review</dt><dd>{counts.review}</dd></div>
          <div><dt>Unresolved valves</dt><dd>{counts.unresolved}</dd></div>
          <div><dt>Pots no valve reached</dt><dd>{counts.unclaimed}</dd></div>
        </dl>
        <p className="settings-muted">
          A result means a sensor rose after a valve was commanded and the controller acknowledged it. Nothing has changed on the controller yet: the pairings stay as
          they are until you approve and apply a change below, and even then physical delivery is confirmed only at the bench.
        </p>
        {references.length ? (
          referenceTrouble.length ? (
            <div className="ac-interruption" role="alert">
              <strong>{referenceTrouble.length} of {references.length} known-correct reference pot{references.length === 1 ? "" : "s"} did not come out as expected</strong>
              <p>{referenceTrouble.map((item) => `${potName(ctx.byName.get(item.pairingName)?.pot_number, item.pairingName)} (${item.outcome === "conflict" ? "measured on a different valve" : "unresolved"})`).join(", ")}. {faultAdvice.reference_conflict}</p>
              <label className="settings-check">
                <input type="checkbox" checked={referencesAcknowledged} onChange={(event) => setReferencesAcknowledged(event.target.checked)} />
                <span>I have checked the reference pots at the bench and still want to review other changes from this run</span>
              </label>
            </div>
          ) : <p className="ac-notice is-ok">All {references.length} known-correct reference pots matched their recorded valves: the run's positive controls passed.</p>
        ) : null}
        <AerialBench model={ctx.model} states={states} selected={selected} selectable={false} onInspect={ctx.inspect} label={`Results: ${counts.matched} match, ${counts.different} different, ${counts.unresolved} unresolved`} />
        <ul className="ac-legend" aria-label="Legend">
          <li><span className="ac-key is-matched" aria-hidden="true" />✓ Its recorded valve waters it</li>
          <li><span className="ac-key is-changed" aria-hidden="true" />↔ A different valve waters it</li>
          <li><span className="ac-key is-unresolved" aria-hidden="true" />? Unresolved or not reached</li>
          <li><span className="ac-key is-failed" aria-hidden="true" />! Controller did not confirm the pulse</li>
          <li>Select a pot for its evidence.</li>
        </ul>
      </section>

      <section className="settings-card ac-step" aria-labelledby="ac-changes-title">
        <div className="settings-card-head">
          <h3 id="ac-changes-title">Measured changes</h3>
          <StatusChip tone={cycles.length ? "warning" : "ok"}>{cycles.length ? `${counts.different} pots in ${cycles.length} group${cycles.length === 1 ? "" : "s"}` : "None"}</StatusChip>
        </div>
        {!cycles.length && !incomplete.length ? <p className="settings-muted">Every measured valve waters the pot it is recorded for. There is nothing to change.</p> : null}
        {cycles.length ? (
          <ul className="ac-cycles">
            {cycles.map((cycle) => {
              const blocked = blockedCycle(cycle);
              const checked = approved.has(cycle.id);
              return (
                <li key={cycle.id} className={cycle.clean ? "" : "needs-review"}>
                  <label className="ac-cycle-head">
                    <input type="checkbox" checked={checked && canApprove(cycle)} disabled={Boolean(blocked) || !canApprove(cycle) || Boolean(applied && applyBatch?.readback !== "not_applied")}
                      onChange={(event) => setApproved((current) => {
                        const next = new Set(current);
                        if (event.target.checked) next.add(cycle.id); else next.delete(cycle.id);
                        return next;
                      })} />
                    <span>
                      <strong>{cycleText(cycle, ctx)}</strong>
                      <span className="commission-subtle">
                        Lowest confidence {Math.round(cycle.minConfidence * 100)}% ({confidenceLevel(cycle.minConfidence)}){cycle.faults.length ? ` · ${cycle.faults.map((fault) => faultText[fault] ?? fault).join(", ")}` : " · no findings"}
                      </span>
                    </span>
                  </label>
                  {blocked ? <p className="settings-error-line">{blocked}</p> : null}
                  {!cycle.clean && !blocked ? (
                    <label className="settings-check">
                      <input type="checkbox" checked={acknowledged.has(cycle.id)} onChange={(event) => setAcknowledged((current) => {
                        const next = new Set(current);
                        if (event.target.checked) next.add(cycle.id); else { next.delete(cycle.id); setApproved((items) => { const copy = new Set(items); copy.delete(cycle.id); return copy; }); }
                        return next;
                      })} />
                      <span>I checked {cycle.changes.length === 2 ? "both pots" : "these pots"} at the bench: {cycle.faults.map((fault) => faultAdvice[fault] ?? fault).join(" ")}</span>
                    </label>
                  ) : null}
                  <details>
                    <summary>What moves</summary>
                    <ul className="commission-plain">
                      {cycle.changes.map((change) => (
                        <li key={change.pairingName}>
                          <span>{potName(ctx.byName.get(change.pairingName)?.pot_number, change.pairingName)} (sensor <code className="settings-identity">{change.sensorKey}</code>):
                            {" "}valve <code className="settings-identity">{valveLabel(change.fromValveKey)}</code> → <code className="settings-identity">{valveLabel(change.toValveKey)}</code></span>
                        </li>
                      ))}
                    </ul>
                  </details>
                </li>
              );
            })}
          </ul>
        ) : null}
        {incomplete.length ? (
          <div className="ac-findings">
            <h4>Measured only in part ({incomplete.reduce((sum, chain) => sum + chain.length, 0)} pots)</h4>
            <p className="settings-muted">These changes do not close into complete swaps or cycles: a valve they need was unresolved or is outside the selection, so applying them would leave a valve without a pot or give one valve to two pots. They are never applied in part. Include the missing pots and run again.</p>
            <ul className="commission-plain">
              {incomplete.flat().map((change) => (
                <li key={change.pairingName}><span>{potName(ctx.byName.get(change.pairingName)?.pot_number, change.pairingName)}: measured on valve <code className="settings-identity">{valveLabel(change.toValveKey)}</code> (recorded <code className="settings-identity">{valveLabel(change.fromValveKey)}</code>)</span></li>
              ))}
            </ul>
          </div>
        ) : null}
        {result.unresolved.length ? (
          <div className="ac-findings">
            <h4>Unresolved valves ({result.unresolved.length})</h4>
            {Array.from(counts.byReason.entries()).map(([reason, count]) => (
              <details key={reason}>
                <summary><strong>{faultText[reason] ?? reason}</strong> · {count}</summary>
                <p className="settings-muted">{faultAdvice[reason] ?? ""}</p>
                <ul className="commission-plain">
                  {result.unresolved.filter((item) => item.reason === reason).map((item) => (
                    <li key={item.valveKey}>
                      <button type="button" className="ac-link" onClick={() => ctx.inspect(item.pairingName)}>{potName(ctx.byName.get(item.pairingName)?.pot_number, item.pairingName)}</button>
                      <span> valve <code className="settings-identity">{valveLabel(item.valveKey)}</code>: {item.detail}</span>
                    </li>
                  ))}
                </ul>
              </details>
            ))}
          </div>
        ) : null}
        {result.unclaimed.length ? (
          <details className="ac-findings">
            <summary><strong>Pots no selected valve reached</strong> · {result.unclaimed.length}</summary>
            <p className="settings-muted">{result.unclaimed[0].detail}</p>
            <ul className="commission-plain">
              {result.unclaimed.map((item) => <li key={item.sensorKey}><button type="button" className="ac-link" onClick={() => ctx.inspect(item.pairingName)}>{potName(ctx.byName.get(item.pairingName)?.pot_number, item.pairingName)}</button></li>)}
            </ul>
          </details>
        ) : null}
        {confirmed.length ? (
          <details className="ac-findings" open={weak.length > 0 && weak.length <= 20}>
            <summary><strong>Measured on their recorded valve</strong> · {confirmed.length}{weak.length ? ` (${weak.length} with weak or mixed evidence)` : ""}</summary>
            <p className="settings-muted">These need no change. Their recorded pairing is consistent with the measurement; physical delivery is still confirmed at the bench.</p>
            {weak.length ? (
              <>
                <p className="settings-muted">The evidence for these was weaker or mixed. Their pairings are not changed either way; check them at the bench before relying on them.</p>
                <ul className="commission-plain">
                  {weak.map((proposal) => (
                    <li key={proposal.valveKey}>
                      <span>
                        <button type="button" className="ac-link" onClick={() => ctx.inspect(proposal.pairingName)}>{potName(ctx.byName.get(proposal.pairingName)?.pot_number, proposal.pairingName)}</button>
                        {" "}· {proposal.faults.map((fault) => faultText[fault] ?? fault).join(", ")} · +{proposal.deltaVwc.toFixed(1)}% VWC, confidence {Math.round(proposal.confidence * 100)}%
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </details>
        ) : null}
      </section>

      {cycles.length || applyBatch ? (
        <section className="settings-card ac-step ac-apply" aria-labelledby="ac-apply-title">
          <div className="settings-card-head">
            <h3 id="ac-apply-title">Apply the reviewed change</h3>
            <StatusChip tone={applyBatch?.readback === "verified" ? "ok" : applyBatch ? "unknown" : "info"}>
              {applyBatch?.readback === "verified" ? "Controller-verified" : applyBatch ? "In progress" : `${changes.length} approved`}
            </StatusChip>
          </div>
          <ol className="ac-facts">
            <li data-state={cycles.length ? "done" : "waiting"}><strong>Proposed</strong><span>measured by this run</span></li>
            <li data-state={applyBatch || changes.length ? "done" : "waiting"}><strong>Approved</strong><span>{applyBatch ? `${applyBatch.changes?.length ?? 0} pots` : `${changes.length} pots selected above`}</span></li>
            <li data-state={applyBatch?.readback === "verified" ? "done" : applyBatch ? "current" : "waiting"}><strong>Controller-verified</strong><span>the controller's own configuration read back</span></li>
            <li data-state="waiting"><strong>Delivery confirmed</strong><span>an operator watches water reach each pot</span></li>
          </ol>
          {!applyBatch || applyBatch.readback === "not_applied" ? (
            changes.length ? (
              <>
                <p className="settings-muted">
                  One controller command moves all {changes.length} pots to their measured valves in a single transaction, so a swap or a cycle never half-applies. Each pot keeps its name,
                  group, settings and calibration; only its valve changes. The controller stops briefly, checks that its configuration still matches what you reviewed, applies
                  the change and restarts. The previous valves are kept for rollback.
                </p>
                {[...preconditions, ...built.problems].map((problem) => <p className="settings-error-line" key={problem}>{problem}</p>)}
                {built.plan && !preconditions.length ? (
                  <>
                    <label className="commission-confirm">
                      <span>Type <code>{applyPhrase}</code> to confirm</span>
                      <input value={phrase} onChange={(event) => setPhrase(event.target.value)} autoComplete="off" autoCapitalize="characters" spellCheck={false} />
                    </label>
                    <div className="ac-actions">
                      <button type="button" className="settings-danger-button" disabled={phrase !== applyPhrase || busy || ctx.controlBusy || !ctx.configHash} onClick={() => void queueApply()}>
                        {busy ? "Queuing…" : `Queue the change: ${changes.length} pots`}
                      </button>
                    </div>
                  </>
                ) : null}
              </>
            ) : <p className="settings-muted">{cycles.length ? "Approve one or more groups above to build the change." : "Nothing to apply."}</p>
          ) : null}
          {applyBatch ? (
            <BatchStatus batch={applyBatch} expired={applyTracker.expired} onRecheck={() => void applyTracker.recheck()}
              readbackText={applyBatch.readback === "verified" ? `The controller reports all ${applyBatch.changes?.length ?? 0} pots on their measured valves.`
                : applyBatch.readback === "not_applied" ? "The controller still reports the previous valves: nothing changed."
                  : applyBatch.readback === "mismatch" ? "The controller reports a configuration that matches neither the old nor the new valves. Do not rely on these pots; check the pairings."
                    : "Waiting for the controller to report its configuration."} />
          ) : null}
          {applyBatch?.reconciled ? (
            <p className="settings-muted">
              {applyBatch.reconciled.count} pot record{applyBatch.reconciled.count === 1 ? "" : "s"} now point to the measured valves, marked software-only until confirmed at the bench.
              {applyBatch.reconciled.skipped.length ? ` Not updated: ${applyBatch.reconciled.skipped.map((item) => `${item.pairing_name} (${item.reason})`).join(", ")}.` : ""}
            </p>
          ) : null}
          {applyBatch?.readback === "verified" && (!rollbackBatch || rollbackBatch.readback === "not_applied") ? (
            <details className="ac-rollback">
              <summary><Undo2 size={14} aria-hidden="true" /> Roll back to the previous valves</summary>
              <p className="settings-muted">Returns the {rollbackChanges.length} pots to the valves recorded before this session, in one controller transaction, verified the same way.</p>
              {rollbackProblems.map((problem) => <p className="settings-error-line" key={problem}>{problem}</p>)}
              <label className="commission-confirm">
                <span>Type <code>{rollbackPhrase}</code> to confirm</span>
                <input value={rollbackText} onChange={(event) => setRollbackText(event.target.value)} autoComplete="off" spellCheck={false} />
              </label>
              <button type="button" className="settings-secondary-button" disabled={rollbackText !== rollbackPhrase || busy || ctx.controlBusy || !ctx.configHash || rollbackProblems.length > 0} onClick={() => void queueRollback()}>
                Queue the rollback
              </button>
            </details>
          ) : null}
          {rollbackBatch ? (
            <BatchStatus batch={rollbackBatch} expired={rollbackTracker.expired} onRecheck={() => void rollbackTracker.recheck()}
              readbackText={rollbackBatch.readback === "verified" ? "The controller reports every pot back on its previous valve." : rollbackBatch.readback === "not_applied" ? "The controller still reports the measured valves." : "Waiting for the controller to report its configuration."} />
          ) : null}
          {error ? <p className="settings-error-line" role="alert">{error}</p> : null}
        </section>
      ) : null}

      <BenchConfirmation ctx={ctx} result={result} />

      <section className="settings-card ac-step">
        <div className="settings-card-head">
          <h3>Finish</h3>
        </div>
        <p className="settings-muted">
          Restoring returns every selected pot to its own recorded target, pulse length and interval. Pots with an unresolved valve or an unapplied change stay sensing-only, and are listed with the reason.
        </p>
        <div className="ac-actions">
          <button type="button" className="settings-primary-button" onClick={ctx.showRestore} disabled={applyBatch != null && applyBatch.readback === "pending"}>Continue to restore</button>
          <button type="button" className="settings-secondary-button" onClick={() => downloadJson(`exacth2o-autocalibration-${ctx.session.run_id}.json`, { session: { ...ctx.session, run_token: undefined }, record: ctx.record, originalSettings: ctx.snapshot, result })}>
            <Download size={14} aria-hidden="true" /> Download the full record
          </button>
        </div>
      </section>

      <details className="settings-card ac-evidence">
        <summary>Technical evidence: {result.evidence.length} pulses, {result.log.length} log entries</summary>
        <EvidenceTable evidence={result.evidence} potForSensor={ctx.potForSensor} potByValve={potByValve} />
        <details>
          <summary>Run log</summary>
          <ol className="commission-log">
            {result.log.slice(-300).map((entry) => <li key={entry.seq}><time>{new Date(entry.at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" })}</time><em>{entry.kind.replace(/_/g, " ")}</em><span>{entry.message}</span></li>)}
          </ol>
        </details>
      </details>
    </>
  );
}

/** Step 7 (at the bench): record that water from each valve reached its pot. */
function BenchConfirmation({ ctx, result }: { ctx: WorkspaceContext; result: CommissioningResult }) {
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const bindings = new Map(ctx.bindings.map((binding) => [binding.pairingName, binding]));
  const pots = result.pots.filter((pot) => {
    const pairing = ctx.byName.get(pot.pairingName);
    const binding = bindings.get(pot.pairingName);
    return pairing && binding && binding.physicalStatus === "software_only" && binding.valveKey === pairing.valve_key && binding.sensorKey === pairing.sensor_key;
  });
  const confirmedCount = result.pots.filter((pot) => bindings.get(pot.pairingName)?.physicalStatus === "researcher_confirmed" || bindings.get(pot.pairingName)?.physicalStatus === "delivery_verified").length;
  if (!pots.length && !confirmedCount) return null;
  return (
    <details className="settings-card ac-step ac-bench">
      <summary><strong>Confirm delivery at the bench</strong> · {confirmedCount} of {result.pots.length} confirmed</summary>
      <p className="settings-muted">
        Open each valve by hand (Manual water → By solenoid, or a pot's details here) and watch the water reach the pot. Then tick the pots you watched. This records an operator's
        bench confirmation, kept apart from the measurement and the controller readback.
      </p>
      <div className="ac-chip-grid">
        {pots.map((pot) => (
          <button key={pot.pairingName} type="button" className={`ac-pot-chip${chosen.has(pot.pairingName) ? " is-selected" : ""}`} aria-pressed={chosen.has(pot.pairingName)}
            onClick={() => setChosen((current) => { const next = new Set(current); if (next.has(pot.pairingName)) next.delete(pot.pairingName); else next.add(pot.pairingName); return next; })}>
            {potName(pot.potNumber, pot.pairingName)}
          </button>
        ))}
      </div>
      <label className="ac-note">Note <span className="settings-muted">(optional)</span>
        <input value={note} maxLength={600} onChange={(event) => setNote(event.target.value)} placeholder="Who watched, and how" />
      </label>
      <button type="button" className="settings-secondary-button" disabled={!chosen.size || busy} onClick={async () => {
        setBusy(true);
        setMessage(null);
        try {
          const outcome = await ctx.store.confirmDelivery(ctx.session.run_id, [...chosen], note);
          setMessage(`${outcome.confirmed} pot(s) recorded as confirmed at the bench.${outcome.skipped.length ? ` Not recorded: ${outcome.skipped.map((item) => `${item.pairing_name} (${item.reason})`).join(", ")}.` : ""}`);
          setChosen(new Set());
          await ctx.refresh();
        } catch (error) {
          setMessage(messageOf(error));
        } finally {
          setBusy(false);
        }
      }}>
        Record {chosen.size || ""} bench confirmation{chosen.size === 1 ? "" : "s"}
      </button>
      {message ? <p className="settings-muted" role="status">{message}</p> : null}
    </details>
  );
}
