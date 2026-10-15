import { HoldWaterControl } from '../HoldWaterControl';
import { ManualWaterClient, routeLabel, type PotRoute, type RouteBook } from '../manualWaterApi';
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { PortalExperiment } from "../experimentRegistry";
import { navigatePortal, portalRouteHref, type PortalRoute } from "../portalRoute";
import { experimentsForPot, searchPots } from "../potIdentity";
import type { PairingRow } from "../types";

type ManualControl = { projectId: string; deviceId: string; controllerName: string };
/** A search result. With manual control, `pot` is the physical pot its valve waters. */
type Result = { key: string; pot: number | null; pairing: PairingRow | null; experiment: PortalExperiment | null; route: PotRoute | null };
const statusText = { ready: "Ready", needs_confirmation: "Needs check", no_water_line: "No water line", unmapped: "No route", conflict: "Conflict" } as const;

function sourceText(route: PotRoute) {
  if (!route.source) return "—";
  if (route.source === "admin") {
    const date = route.updatedAt ? new Date(route.updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "";
    return `Confirmed by an admin${date ? ` · ${date}` : ""}`;
  }
  const match = /^field_(record|test)_(\d{4}-\d{2}-\d{2})$/.exec(route.source);
  if (!match) return route.source;
  const date = new Date(`${match[2]}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  return `${match[1] === "test" ? "Field test" : "Field record"} · ${date}`;
}

/** Physical pots by number; pairings and experiments by name, shown at the pot their valve waters. */
function searchAllPots(query: string, pairings: readonly PairingRow[], experiments: readonly PortalExperiment[], book: RouteBook | null): Result[] {
  const q = query.trim();
  const named = searchPots(query, pairings, experiments);
  if (!book) {
    return named.map((match) => ({ key: match.pairing.name, pot: match.pairing.pot_number, pairing: match.pairing, experiment: match.experiment, route: null }));
  }
  const pairingFor = (route: PotRoute) => route.pairing ? pairings.find((item) => item.name === route.pairing?.name) ?? null : null;
  const scored: Array<{ result: Result; score: number }> = [];
  const seen = new Set<number>();
  if (/^\d{1,3}$/.test(q)) {
    for (const route of book.pots) {
      const text = String(route.pot);
      const score = text === String(Number(q)) ? 100 : text.startsWith(q) ? 60 - text.length : 0;
      if (!score) continue;
      const pairing = pairingFor(route);
      seen.add(route.pot);
      scored.push({ score, result: { key: `pot-${route.pot}`, pot: route.pot, pairing, route,
        experiment: pairing ? experimentsForPot(pairing.name, experiments)[0] ?? null : null } });
    }
  }
  for (const match of named) {
    const route = book.pots.find((entry) => entry.pairing?.name === match.pairing.name) ?? null;
    if (route && seen.has(route.pot)) continue;
    if (route) seen.add(route.pot);
    scored.push({ score: Math.min(match.score, 59), result: { key: `pairing-${match.pairing.name}`, pot: route?.pot ?? null, pairing: match.pairing, experiment: match.experiment, route } });
  }
  return scored.sort((a, b) => b.score - a.score || (a.result.pot ?? 999) - (b.result.pot ?? 999)).slice(0, 30).map((item) => item.result);
}

/** Global pot lookup: number, pairing name or experiment name; Enter opens the first match. */
export function FindPotDialog({
  open,
  onClose,
  pairings,
  experiments,
  routeFor,
  manualControl,
}: {
  manualControl?: ManualControl;
  open: boolean;
  onClose: () => void;
  pairings: readonly PairingRow[];
  experiments: readonly PortalExperiment[];
  routeFor: (pairingName: string) => PortalRoute;
}) {
  const [selected, setSelected] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [book, setBook] = useState<RouteBook | null>(null);
  const [bookError, setBookError] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const titleId = useId();
  const listId = useId();
  const client = useMemo(() => manualControl ? new ManualWaterClient(manualControl.projectId, manualControl.deviceId) : null,
    [manualControl?.projectId, manualControl?.deviceId]); // eslint-disable-line react-hooks/exhaustive-deps
  const results = useMemo(() => searchAllPots(query, pairings, experiments, book), [book, experiments, pairings, query]);

  useEffect(() => {
    if (!open) return undefined;
    setSelected(null);
    setQuery("");
    setActive(0);
    const timer = window.setTimeout(() => inputRef.current?.focus(), 0);
    const previous = document.activeElement as HTMLElement | null;
    return () => {
      window.clearTimeout(timer);
      previous?.focus?.();
    };
  }, [open]);

  useEffect(() => {
    if (!open || !client) return undefined;
    let current = true;
    setBookError("");
    void client.routes().then((result) => {
      if (!current || !result) return;
      if (result.ok) setBook(result.data); else setBookError(result.error);
    });
    return () => { current = false; };
  }, [client, open]);

  if (!open) return null;

  const choose = (result: Result) => {
    if (client && result.pot != null) { setSelected(result.pot); return; }
    if (!result.pairing) return;
    onClose();
    navigatePortal(routeFor(result.pairing.name));
  };
  const route = selected == null ? null : book?.pots.find((entry) => entry.pot === selected) ?? null;
  const valvePairing = route?.pairing ? pairings.find((pairing) => pairing.name === route.pairing?.name) ?? null : null;

  return (
    <div className="px-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className={`px-dialog${selected != null ? " is-pot" : ""}`} role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={(event) => {
        if (event.key === "Tab") {
          const nodes = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href]'));
          const first = nodes[0], last = nodes[nodes.length - 1];
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
        if (event.key === "Escape" && !(event.target instanceof HTMLElement && event.target.classList.contains("px-hold"))) {
          event.preventDefault();
          onClose();
        }
      }}>
        <div className="px-dialog-heading">
          {selected != null && client ? <button type="button" className="px-button is-small is-quiet" onClick={() => setSelected(null)}>← All pots</button> : <h2 id={titleId}>Find a pot</h2>}
          <button type="button" className="px-button is-small" onClick={onClose}>Close</button>
        </div>
        {selected != null && client && manualControl ? (
          <PotPanel
            titleId={titleId}
            pot={selected}
            route={route}
            experiment={valvePairing ? experimentsForPot(valvePairing.name, experiments)[0] ?? null : null}
            controllerName={manualControl.controllerName}
            client={client}
            book={book}
            onBook={setBook}
            recordHref={valvePairing ? portalRouteHref(routeFor(valvePairing.name)) : null}
            onClose={onClose}
          />
        ) : <>
        <input
          ref={inputRef}
          value={query}
          inputMode="search"
          role="combobox"
          aria-label="Pot number, pairing or experiment"
          aria-expanded={Boolean(query.trim() && results.length)}
          aria-autocomplete="list"
          placeholder={client ? "Pot number 1–100, pairing or experiment" : "Pot number, pairing or experiment"}
          aria-controls={listId}
          aria-activedescendant={results[active] ? `${listId}-${active}` : undefined}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setActive((value) => Math.min(results.length - 1, value + 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActive((value) => Math.max(0, value - 1));
            } else if (event.key === "Enter" && results[active]) {
              event.preventDefault();
              choose(results[active]);
            }
          }}
        />
        {query.trim() ? (
          results.length ? (
            <ul className="px-results" id={listId} role="listbox" aria-label="Matching pots">
              {results.map((result, index) => (
                <li key={result.key} role="presentation">
                  <a
                    id={`${listId}-${index}`}
                    role="option"
                    aria-selected={index === active}
                    href={result.pairing ? portalRouteHref(routeFor(result.pairing.name)) : "#"}
                    onClick={(event) => {
                      if (result.pairing && (event.metaKey || event.ctrlKey || event.shiftKey)) return;
                      event.preventDefault();
                      choose(result);
                    }}
                  >
                    <b>{result.pot != null ? `Pot ${result.pot}` : result.pairing?.name}</b>
                    <span>{result.experiment?.name ?? (result.pairing ? (client ? result.pairing.name : "Not in a current experiment") : "No sensor pairing")}</span>
                    {result.route
                      ? <span className="px-route-badge" data-status={result.route.status}>{statusText[result.route.status]}</span>
                      : client ? <span className="px-route-badge" data-status="unmapped">Valve not confirmed</span> : <span className="px-mono">{result.pairing?.name}</span>}
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-muted" role="status">No pot on this controller matches “{query.trim()}”.</p>
          )
        ) : (
          <p className="px-muted px-small">{bookError ? `Valve routes unavailable: ${bookError}` : client ? "Search any physical pot from 1 to 100." : "Search by pot number or name."}</p>
        )}
        </>}
      </div>
    </div>
  );
}

function PotPanel({ titleId, pot, route, experiment, controllerName, client, book, onBook, recordHref, onClose }: {
  titleId: string; pot: number; route: PotRoute | null; experiment: PortalExperiment | null; controllerName: string;
  client: ManualWaterClient; book: RouteBook | null; onBook: (book: RouteBook) => void; recordHref: string | null; onClose: () => void;
}) {
  const valve = route?.relayAddress != null && route.channel != null ? routeLabel(route.relayAddress, route.channel) : null;
  const renamed = route?.pairing && route.pairing.namedPot != null && route.pairing.namedPot !== pot;
  return (
    <div className="px-pot-panel">
      <header>
        <h2 id={titleId}>Pot {pot}</h2>
        <p>{experiment?.name ?? (route?.pairing ? "Not in a current experiment" : "No sensor pairing on this valve")}</p>
      </header>
      <dl className="px-pot-facts">
        <div><dt>Valve</dt>{valve ? <dd className="px-mono">{valve}</dd> : <dd className="px-muted">{route?.status === "no_water_line" ? "No water line" : "Not confirmed"}</dd>}</div>
        <div><dt>Sensor pairing</dt>{route?.pairing ? <dd><span>{route.pairing.name}</span>{route.pairing.sensorKey ? <span className="px-mono px-muted"> · {route.pairing.sensorKey}</span> : null}</dd> : <dd className="px-muted">None</dd>}</div>
        <div><dt>Route record</dt><dd>{route ? sourceText(route) : "Loading…"}</dd></div>
        <div><dt>Controller</dt><dd>{controllerName}</dd></div>
      </dl>
      {renamed ? <p className="px-pot-note">This valve's sensor pairing is named {route?.pairing?.name}. Pot numbers here are the physical bench numbers.</p> : null}
      {!route ? <p className="px-muted px-small">Loading valve routes…</p>
        : route.status === "ready" ? <HoldWaterControl key={`${pot}:${route.relayAddress}:${route.channel}`} client={client} pot={route} />
        : <RouteNeeded route={route} canConfirm={Boolean(book?.canConfirm)} book={book} client={client} onBook={onBook} />}
      {recordHref ? <a className="px-pot-record" href={recordHref} onClick={onClose}>Open sensor record <span aria-hidden="true">→</span></a> : null}
    </div>
  );
}

const neededCopy = {
  needs_confirmation: ["Needs a physical check", "The recorded route for this pot has not been confirmed since the bench changed. Watch the valve water this pot, then confirm it."],
  no_water_line: ["No water line", "Field records show no water line to this pot."],
  unmapped: ["No recorded valve route", "No field record shows which valve waters this pot. Routes are never guessed from pot or channel numbers."],
  conflict: ["Route conflict", ""],
  ready: ["", ""],
} as const;

function RouteNeeded({ route, canConfirm, book, client, onBook }: { route: PotRoute; canConfirm: boolean; book: RouteBook | null; client: ManualWaterClient; onBook: (book: RouteBook) => void }) {
  const start = route.candidate ?? (route.relayAddress != null && route.channel != null ? { relayAddress: route.relayAddress, channel: route.channel } : null);
  const [board, setBoard] = useState(start?.relayAddress ?? book?.boards[0] ?? 0);
  const [channel, setChannel] = useState(start?.channel ?? 0);
  const [note, setNote] = useState("");
  const [watched, setWatched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const used = useMemo(() => new Map((book?.pots ?? []).filter((entry) => entry.status === "ready" && entry.pot !== route.pot)
    .map((entry) => [`${entry.relayAddress}:${entry.channel}`, entry.pot])), [book, route.pot]);
  const submit = async (action: "confirm" | "remove") => {
    setBusy(true); setError("");
    const result = action === "confirm" ? await client.confirmRoute(route.pot, board, channel, note) : await client.removeRoute(route.pot);
    setBusy(false);
    if (!result) return;
    if (result.ok) onBook(result.data); else setError(result.error);
  };
  const [title, body] = neededCopy[route.status];
  return (
    <section className="px-route-needed" data-status={route.status}>
      <h3>{title}</h3>
      <p>{route.status === "conflict" ? route.reason : body}</p>
      {route.evidence ? <p className="px-route-evidence">{route.evidence}</p> : null}
      {route.candidate ? <p className="px-route-evidence">Recorded route: <span className="px-mono">{routeLabel(route.candidate.relayAddress, route.candidate.channel)}</span></p> : null}
      {canConfirm && route.status === "conflict" && route.source === "admin"
        ? <button type="button" className="px-button is-small" disabled={busy} onClick={() => void submit("remove")}>Remove confirmed route</button> : null}
      {canConfirm && route.status !== "conflict" ? (
        <form className="px-route-form" onSubmit={(event) => { event.preventDefault(); void submit("confirm"); }}>
          <label>Relay board
            <select value={board} onChange={(event) => { setBoard(Number(event.target.value)); setChannel(0); }}>
              {(book?.boards ?? []).map((address) => <option key={address} value={address}>0x{address.toString(16)}</option>)}
            </select>
          </label>
          <label>Channel
            <select value={channel} onChange={(event) => setChannel(Number(event.target.value))}>
              <option value={0} disabled>Select</option>
              {Array.from({ length: 48 }, (_, index) => index + 1).map((value) => {
                const owner = used.get(`${board}:${value}`);
                return <option key={value} value={value} disabled={owner != null}>{value}{owner != null ? ` · pot ${owner}` : ""}</option>;
              })}
            </select>
          </label>
          <label className="px-route-note"><span>Note <span className="px-muted">(optional)</span></span>
            <input value={note} maxLength={600} onChange={(event) => setNote(event.target.value)} placeholder="Who watched, and when" />
          </label>
          <label className="px-route-check"><input type="checkbox" checked={watched} onChange={(event) => setWatched(event.target.checked)} />
            I watched this valve water pot {route.pot}.</label>
          <button type="submit" className="px-button is-primary" disabled={busy || !watched || !channel}>Confirm route</button>
        </form>
      ) : route.status !== "conflict" ? <p className="px-muted px-small">A project admin confirms routes after watching the valve water the pot.</p> : null}
      {error ? <p className="px-route-error" role="alert">{error}</p> : null}
    </section>
  );
}
