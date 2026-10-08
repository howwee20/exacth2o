import { useEffect, useMemo, useState } from "react";
import type { PotBinding } from "../benchClient";
import { sensorBoard } from "../benchLayout";
import { defaultGrouping, experimentFactors, potGroups, potRangeText } from "../experimentFactors";
import { experimentIsCompleted } from "../experimentMeasurement";
import { isObservationOnlyExperiment, type PortalExperiment } from "../experimentRegistry";
import { silentExperimentPots } from "../homeExceptions";
import { formatMeasurementTime, measurementFreshness } from "../measurementFreshness";
import { navigatePortal, portalRouteUrl, setPortalQuery, usePortalQueryValue } from "../portalRoute";
import { isResearchPotId, resolvePot } from "../potIdentity";
import type { PotNote } from "../potNotesClient";
import { decimateForDisplay } from "../seriesStatistics";
import { pairingWateringDisabled } from "../targetPresentation";
import type { PairingRow, SensorReading } from "../types";
import { potTraces } from "../waterline";
import { NoteComposer, PotNotesList, usePotNotes } from "./PotNotes";
import { PortalLink } from "./PortalLink";
import { TimeSeriesChart } from "./TimeSeriesChart";
import type { useNoteOutbox } from "./useNoteOutbox";
import "./product.css";

type Outbox = ReturnType<typeof useNoteOutbox>;

const recentKey = (userId: string, projectId: string) => `exacth2o.portal.recentPots.v1:${userId}:${projectId}`;

export function recentPots(userId: string, projectId: string): string[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(recentKey(userId, projectId)) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string").slice(0, 6) : [];
  } catch {
    return [];
  }
}

export function rememberPot(userId: string, projectId: string, pairingName: string) {
  try {
    const next = [pairingName, ...recentPots(userId, projectId).filter((name) => name !== pairingName)].slice(0, 6);
    window.localStorage.setItem(recentKey(userId, projectId), JSON.stringify(next));
  } catch {
    // Recent pots are a convenience; nothing depends on them.
  }
}

function NetworkChip({ online, waiting, failed, needsSignIn, syncing }: { online: boolean; waiting: number; failed: number; needsSignIn: boolean; syncing: boolean }) {
  const count = (n: number) => `${n} ${n === 1 ? "note" : "notes"}`;
  const text = !online
    ? `Offline${waiting ? ` · ${waiting} waiting` : ""}`
    : needsSignIn
      ? "Sign in to send notes"
      : failed
        ? `${count(failed)} not accepted`
        : syncing && waiting
          ? "Sending…"
          : waiting
            ? `${count(waiting)} waiting`
            : null;
  if (!text) return null;
  return (
    <PortalLink to={{ view: "pocket", pot: null, note: false }} extra={{ screen: "outbox" }} className={`px-pocket-net ${!online ? "is-offline" : needsSignIn || failed ? "is-bad" : ""}`} role="status">
      {text}
    </PortalLink>
  );
}

export function PocketView({
  potKey,
  writing,
  userId,
  projectId,
  deviceId,
  canWrite,
  pairings,
  experiments,
  readings,
  bindings,
  nowMs,
  asOfMs,
  online,
  refreshFailed,
  outbox,
  onLeave,
}: {
  potKey: string | null;
  writing: boolean;
  userId: string;
  projectId: string;
  deviceId: string;
  canWrite: boolean;
  pairings: readonly PairingRow[];
  experiments: readonly PortalExperiment[];
  readings: readonly SensorReading[];
  bindings: readonly PotBinding[];
  nowMs: number;
  asOfMs: number | null;
  online: boolean;
  refreshFailed: boolean;
  outbox: Outbox;
  onLeave: () => void;
}) {
  const screen = usePortalQueryValue("screen");
  const [entry, setEntry] = useState("");
  const [correcting, setCorrecting] = useState<PotNote | null>(null);
  const boundName = potKey && isResearchPotId(potKey) ? bindings.find((binding) => binding.researchPotId === potKey)?.pairingName ?? null : null;
  const match = potKey ? resolvePot(potKey, pairings, experiments, { boundPairingName: boundName, nowMs }) : null;
  const pairingName = match?.pairing.name ?? null;
  // Any pot opened here (number pad, neighbour, label link) counts as recent.
  useEffect(() => {
    if (pairingName) rememberPot(userId, projectId, pairingName);
  }, [pairingName, projectId, userId]);
  const notes = usePotNotes(projectId, deviceId, pairingName, outbox.entries.filter((item) => item.state === "sent").length, userId);
  useEffect(() => setCorrecting(null), [userId, projectId, deviceId, pairingName]);
  const ordered = useMemo(() => pairings.slice().sort((a, b) => a.zone - b.zone || a.pot_number - b.pot_number), [pairings]);
  const latest = useMemo(() => {
    const map = new Map<string, number>();
    for (const reading of readings) {
      const at = Date.parse(reading.device_recorded_at);
      if (Number.isFinite(at) && at > (map.get(reading.pairing_name) ?? -Infinity)) map.set(reading.pairing_name, at);
    }
    return map;
  }, [readings]);
  const running = experiments.filter((experiment) => !experimentIsCompleted(experiment, nowMs));
  const silent = useMemo(() => {
    if (asOfMs == null) return [];
    const names = new Set<string>();
    for (const experiment of running) for (const pot of silentExperimentPots(experiment, pairings, latest, asOfMs)) names.add(pot.name);
    return ordered.filter((pairing) => names.has(pairing.name));
  }, [asOfMs, latest, ordered, pairings, running]);
  const silentByBoard = useMemo(() => {
    const map = new Map<string, PairingRow[]>();
    for (const pairing of silent) {
      const board = sensorBoard(pairing.sensor_key) ?? "?";
      map.set(board, [...(map.get(board) ?? []), pairing]);
    }
    return Array.from(map.entries());
  }, [silent]);
  const recent = recentPots(userId, projectId).map((name) => pairings.find((pairing) => pairing.name === name)).filter((pairing): pairing is PairingRow => Boolean(pairing));
  const numberMatch = /^\d+$/.test(entry) ? pairings.filter((pairing) => pairing.pot_number === Number(entry)) : [];
  const potCount = pairings.length;
  const openPot = (name: string) => {
    rememberPot(userId, projectId, name);
    setEntry("");
    navigatePortal({ view: "pocket", pot: name, note: false });
  };

  const top = (
    <header className="px-pocket-top">
      <b>At the bench</b>
      <NetworkChip online={online} waiting={outbox.waiting.length} failed={outbox.failed.length} needsSignIn={outbox.needsSignIn} syncing={outbox.syncing} />
      <button type="button" className="px-pocket-leave" onClick={onLeave}>Full portal</button>
    </header>
  );

  if (screen === "outbox") {
    return (
      <section className="px-pocket" aria-label="Notes on this device">
        {top}
        <main className="px-pocket-main">
          <PortalLink className="px-crumb" to={{ view: "pocket", pot: null, note: false }}>← Find pot</PortalLink>
          <h1 className="px-pocket-title">Notes on this device</h1>
          <p className="px-muted">{!online ? "Offline: notes wait here and are sent when the phone reconnects." : outbox.failed.length ? "Online. Notes the server did not accept wait for you to try again or discard them; the rest are sent automatically." : "Online: waiting notes are sent within seconds."}</p>
          {outbox.needsSignIn ? <p className="px-notice is-bad">Your session ended. Sign in again on this phone to send the waiting notes; they are kept until then.</p> : null}
          {outbox.waiting.length ? (
            <ol className="px-notes">
              {outbox.waiting.map((item) => (
                <li key={item.id} className={`px-note is-${item.state}`}>
                  <p className="px-note-body">{item.body}</p>
                  <p className="px-note-meta"><b>{item.state === "failed" ? "Not accepted" : item.state === "sending" ? "Sending…" : "Waiting"}</b> · {pairings.find((pairing) => pairing.name === item.pairingName)?.pot_number ? `Pot ${pairings.find((pairing) => pairing.name === item.pairingName)?.pot_number}` : item.pairingName} · written {formatMeasurementTime(item.observedAt)}{item.lastError && item.state === "failed" ? ` · ${item.lastError}` : ""}</p>
                  {item.state === "failed" ? (
                    <div className="px-note-actions">
                      <button type="button" className="px-button is-small" onClick={() => void outbox.retry(item.id)}>Try again</button>
                      <button type="button" className="px-button is-small is-quiet" onClick={() => { if (window.confirm("Discard this note? It has not reached the record.")) void outbox.discard(item.id); }}>Discard</button>
                    </div>
                  ) : null}
                </li>
              ))}
            </ol>
          ) : <p className="px-empty">Nothing waiting. Every note written on this device has reached the record.</p>}
          {outbox.entries.some((item) => item.state === "sent") ? (
            <>
              <h2 className="px-section-label">Sent from this device</h2>
              <ol className="px-notes">
                {outbox.entries.filter((item) => item.state === "sent").slice(0, 20).map((item) => (
                  <li key={item.id} className="px-note">
                    <p className="px-note-body">{item.body}</p>
                    <p className="px-note-meta">Sent {formatMeasurementTime(item.sentAt)} · written {formatMeasurementTime(item.observedAt)}</p>
                  </li>
                ))}
              </ol>
            </>
          ) : null}
        </main>
      </section>
    );
  }

  if (potKey && !match) {
    return (
      <section className="px-pocket">
        {top}
        <main className="px-pocket-main">
          <PortalLink className="px-crumb" to={{ view: "pocket", pot: null, note: false }}>← Find pot</PortalLink>
          <p className="px-empty" role="alert">{pairings.length ? `No pot “${potKey}” on this project's controller.` : "Loading pots…"}</p>
        </main>
      </section>
    );
  }

  if (match && pairingName) {
    const { pairing, current: experiment, assignment } = match;
    const trace = potTraces(readings.filter((reading) => reading.pairing_name === pairingName), [pairing], "vwc").get(pairingName);
    const last = trace?.points.length ? trace.points[trace.points.length - 1] : null;
    const completed = experiment ? experimentIsCompleted(experiment, nowMs) : false;
    const freshness = measurementFreshness({ measuredAt: last?.timestampMs, expectedIntervalMs: pairing.measurement_interval_ms, completed, nowMs: asOfMs ?? nowMs });
    const stale = !last || freshness.state === "stale" || freshness.state === "unknown";
    const cached = !online || refreshFailed;
    const sensing = experiment ? isObservationOnlyExperiment(experiment) : true;
    const target = experiment && sensing
      ? "Sensing only"
      : pairingWateringDisabled(pairing)
        ? "Watering disabled on the controller"
        : experiment ? `Target ${pairing.wtc_percent_limit}%` : `Controller target ${pairing.wtc_percent_limit}%`;
    const group = experiment ? potGroups(experiment, defaultGrouping(experimentFactors(experiment))).find((item) => item.pairingNames.includes(pairingName)) : null;
    const window = { startMs: nowMs - 6 * 3_600_000, endMs: nowMs };
    const points = (trace?.points ?? []).filter((point) => point.timestampMs >= window.startMs);
    const values = points.map((point) => point.value);
    const index = ordered.findIndex((item) => item.name === pairingName);
    const previous = index > 0 ? ordered[index - 1] : null;
    const next = index >= 0 && index < ordered.length - 1 ? ordered[index + 1] : null;
    const pending = outbox.entries.filter((item) => item.deviceId === deviceId && item.pairingName === pairingName);
    const binding = bindings.find((item) => item.pairingName === pairingName) ?? null;
    const labelRoute = { view: "pocket" as const, pot: binding?.researchPotId ?? pairingName, note: false };
    const summary = last
      ? `Pot ${pairing.pot_number}: ${last.value.toFixed(1)}% VWC measured at ${formatMeasurementTime(last.timestampMs)}${stale ? ", no newer reading" : ""}${cached ? ", shown from the last successful load" : ""}. ${target}.`
      : `Pot ${pairing.pot_number} has no reading in the loaded window. ${target}.`;

    if (writing && canWrite) {
      return (
        <section className="px-pocket" aria-label={`Note for pot ${pairing.pot_number}`}>
          {top}
          <main className="px-pocket-main">
            <PortalLink className="px-crumb" to={{ view: "pocket", pot: pairingName, note: false }}>← Pot {pairing.pot_number}</PortalLink>
            <NoteComposer
              large
              userId={userId}
              projectId={projectId}
              deviceId={deviceId}
              pairingName={pairingName}
              potLabel={`Pot ${pairing.pot_number}`}
              supersedes={correcting}
              onCancel={() => {
                setCorrecting(null);
                navigatePortal({ view: "pocket", pot: pairingName, note: false });
              }}
              onSave={async (body, tags) => {
                await outbox.add({
                  deviceId,
                  pairingName,
                  researchPotId: binding?.researchPotId ?? null,
                  experimentId: experiment?.databaseId ?? null,
                  body,
                  tags,
                  supersedesId: correcting?.id ?? null,
                });
                setCorrecting(null);
                navigatePortal({ view: "pocket", pot: pairingName, note: false }, { replace: true });
              }}
            />
          </main>
        </section>
      );
    }

    return (
      <section className="px-pocket" aria-label={`Pot ${pairing.pot_number}`}>
        {top}
        <main className="px-pocket-main is-sheet">
          <PortalLink className="px-crumb" to={{ view: "pocket", pot: null, note: false }}>← Find pot</PortalLink>
          <p className="px-sr-only" role="status">{summary}</p>
          <div className="px-pocket-head">
            <h1 className="px-pocket-title">Pot {pairing.pot_number}</h1>
            <p className="px-muted">{experiment ? experiment.name : "No running experiment visible to this account"}{group && group.label !== "All pots" ? ` · ${group.label}` : ""}</p>
          </div>
          <div className={`px-pocket-reading ${stale ? "is-silent" : ""}`} aria-hidden="true">
            {last && !stale ? <strong>{last.value.toFixed(1)}<small>% VWC</small></strong> : <strong className="is-text">{last ? "No current reading" : "No reading loaded"}</strong>}
            <span>{last ? `${stale ? "Last reading" : "Measured"} ${formatMeasurementTime(last.timestampMs)}` : "Nothing in the last 72 hours"}{last && stale ? ` · ${last.value.toFixed(1)}%` : ""}</span>
            <span>{target}{assignment?.target_vwc_percent != null && !sensing && Math.abs(assignment.target_vwc_percent - pairing.wtc_percent_limit) > 0.001 ? ` · plan ${assignment.target_vwc_percent}%` : ""}</span>
          </div>
          {cached ? (
            <p className="px-notice" role="status">{online ? "The portal could not check for new readings." : "This phone is offline."} The reading above is from the last successful load, not a new one.</p>
          ) : null}
          <div className="px-card" style={{ padding: 8 }}>
            <TimeSeriesChart
              compact
              lines={[{ id: pairingName, label: `Pot ${pairing.pot_number}`, color: "#1a6b4a", width: 2, segments: decimateForDisplay(points, { startMs: window.startMs, endMs: window.endMs, buckets: 300, gapMs: trace?.gapMs ?? 30 * 60_000 }) }]}
              targets={!sensing && !pairingWateringDisabled(pairing) && !completed ? [{ value: pairing.wtc_percent_limit, label: target, color: "#0e1a14" }] : []}
              domain={window}
              yDomain={values.length ? [Math.floor(Math.min(...values, sensing ? Infinity : pairing.wtc_percent_limit) - 1), Math.ceil(Math.max(...values, sensing ? -Infinity : pairing.wtc_percent_limit) + 1)] : [0, 50]}
              height={120}
              ariaLabel={`Pot ${pairing.pot_number}, last 6 hours.`}
            />
          </div>
          <section aria-label="Notes" className="px-pocket-notes">
            <h2 className="px-section-label">Notes</h2>
            <PotNotesList
              notes={notes.notes}
              waiting={pending}
              loading={notes.loading}
              error={notes.error}
              canWrite={canWrite}
              onRetry={(id) => void outbox.retry(id)}
              onDiscard={(id) => void outbox.discard(id)}
              onCorrect={(note) => {
                setCorrecting(note);
                navigatePortal({ view: "pocket", pot: pairingName, note: true });
              }}
            />
          </section>
          <button type="button" className="px-link-button" onClick={() => void navigator.clipboard?.writeText(portalRouteUrl(labelRoute)).catch(() => undefined)}>
            Copy label link
          </button>
          <p className="px-muted px-small">For a printed label: {portalRouteUrl(labelRoute)}{binding ? " (follows the physical pot)" : ""}</p>
        </main>
        <nav className="px-pocket-bar" aria-label="Pot actions">
          {previous ? <PortalLink className="px-pocket-step" to={{ view: "pocket", pot: previous.name, note: false }} aria-label={`Previous pot, ${previous.pot_number}`}>‹ {previous.pot_number}</PortalLink> : <span className="px-pocket-step is-empty" />}
          {canWrite ? (
            <PortalLink className="px-pocket-primary" to={{ view: "pocket", pot: pairingName, note: true }}>Add note</PortalLink>
          ) : <span className="px-pocket-primary is-disabled">Viewing only</span>}
          {next ? <PortalLink className="px-pocket-step" to={{ view: "pocket", pot: next.name, note: false }} aria-label={`Next pot, ${next.pot_number}`}>{next.pot_number} ›</PortalLink> : <span className="px-pocket-step is-empty" />}
        </nav>
      </section>
    );
  }

  return (
    <section className="px-pocket" aria-label="Find pot">
      {top}
      <main className="px-pocket-main">
        <form className="px-pocket-finder" onSubmit={(event) => {
          event.preventDefault();
          if (numberMatch.length === 1) openPot(numberMatch[0].name);
        }}>
          <label htmlFor="pocket-pot" className="px-section-label">Find pot</label>
          <input id="pocket-pot" className="px-pocket-display" inputMode="numeric" autoComplete="off" value={entry} placeholder="—" onChange={(event) => setEntry(event.target.value.replace(/\D/g, "").slice(0, 5))} />
          <p className={`px-pocket-help ${entry && !numberMatch.length ? "is-error" : ""}`} role="status">
            {entry && !numberMatch.length ? `No pot ${entry} on this controller` : potCount ? `Pots ${Math.min(...pairings.map((pairing) => pairing.pot_number))}–${Math.max(...pairings.map((pairing) => pairing.pot_number))} on this controller` : "Loading pots…"}
          </p>
          {numberMatch.length > 1 ? (
            <div className="px-pocket-chips">{numberMatch.map((pairing) => <button key={pairing.name} type="button" className="px-pocket-chip" onClick={() => openPot(pairing.name)}>{pairing.name}</button>)}</div>
          ) : null}
          <div className="px-pocket-pad" role="group" aria-label="Number pad">
            {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((digit) => (
              <button key={digit} type="button" onClick={() => setEntry((value) => (value + digit).slice(0, 5))}>{digit}</button>
            ))}
            <button type="button" className="is-back" aria-label="Delete last digit" onClick={() => setEntry((value) => value.slice(0, -1))}>⌫</button>
            <button type="button" onClick={() => setEntry((value) => (value + "0").slice(0, 5))}>0</button>
            <button type="submit" className="is-go" disabled={numberMatch.length !== 1}>Go</button>
          </div>
        </form>
        {recent.length ? (
          <section aria-label="Recent pots">
            <h2 className="px-section-label">Recent</h2>
            <div className="px-pocket-chips">{recent.map((pairing) => <button key={pairing.name} type="button" className="px-pocket-chip" onClick={() => openPot(pairing.name)}>Pot {pairing.pot_number}</button>)}</div>
          </section>
        ) : null}
        {silentByBoard.length ? (
          <section aria-label="Not reporting">
            <h2 className="px-section-label">Not reporting</h2>
            {silentByBoard.map(([board, items]) => (
              <button key={board} type="button" className="px-pocket-silent" onClick={() => openPot(items[0].name)}>
                <b>{potRangeText(items.map((pairing) => pairing.pot_number))}</b>
                <span>board {board}{latest.get(items[0].name) ? ` · since ${formatMeasurementTime(Math.max(...items.map((pairing) => latest.get(pairing.name) ?? 0)))}` : ""}</span>
              </button>
            ))}
          </section>
        ) : null}
        <button type="button" className="px-pocket-secondary" onClick={() => setPortalQuery({ screen: "outbox" }, { push: true })}>
          Notes on this device{outbox.waiting.length ? ` · ${outbox.waiting.length} waiting` : ""}
        </button>
      </main>
    </section>
  );
}
