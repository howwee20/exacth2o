import { HoldWaterControl } from '../HoldWaterControl';
import { ManualWaterClient, routeLabel, type PotRoute, type RouteBook } from '../manualWaterApi';
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { PortalExperiment } from "../experimentRegistry";
import { navigatePortal, portalRouteHref, type PortalRoute } from "../portalRoute";
import { experimentsForPot, searchPots } from "../potIdentity";
import type { PairingRow } from "../types";

type ManualControl = { projectId: string; deviceId: string; controllerName: string };
type Result = { pot: number; pairing: PairingRow | null; experiment: PortalExperiment | null; route: PotRoute | null };
const statusText = { ready: "Ready", unmapped: "No route", conflict: "Conflict" } as const;

/** Every physical pot, matched by number; paired pots also by pairing or experiment name. */
function searchAllPots(query: string, pairings: readonly PairingRow[], experiments: readonly PortalExperiment[], book: RouteBook | null): Result[] {
  const routes = new Map((book?.pots ?? []).map((entry) => [entry.pot, entry]));
  const paired = searchPots(query, pairings, experiments).map((match) => ({ result: {
    pot: match.pairing.pot_number, pairing: match.pairing, experiment: match.experiment, route: routes.get(match.pairing.pot_number) ?? null,
  } as Result, score: match.score }));
  const q = query.trim();
  if (book && /^\d{1,3}$/.test(q)) {
    const seen = new Set(paired.map((item) => item.result.pot));
    for (const route of book.pots) {
      if (seen.has(route.pot)) continue;
      const text = String(route.pot);
      const score = text === String(Number(q)) ? 100 : text.startsWith(q) ? 50 - text.length : 0;
      if (score > 0) paired.push({ result: { pot: route.pot, pairing: null, experiment: null, route }, score });
    }
  }
  return paired.sort((a, b) => b.score - a.score || a.result.pot - b.result.pot).slice(0, 30).map((item) => item.result);
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
    if (client) { setSelected(result.pot); return; }
    if (!result.pairing) return;
    onClose();
    navigatePortal(routeFor(result.pairing.name));
  };
  const selectedPairing = selected == null ? null : pairings.find((pairing) => pairing.pot_number === selected) ?? null;

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
            pairing={selectedPairing}
            experiment={selectedPairing ? experimentsForPot(selectedPairing.name, experiments)[0] ?? null : null}
            controllerName={manualControl.controllerName}
            client={client}
            book={book}
            onBook={setBook}
            recordHref={selectedPairing ? portalRouteHref(routeFor(selectedPairing.name)) : null}
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
                <li key={result.pot} role="presentation">
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
                    <b>Pot {result.pot}</b>
                    <span>{result.experiment ? result.experiment.name : result.pairing ? "Not in a current experiment" : "No sensor pairing"}</span>
                    {result.route
                      ? <span className="px-route-badge" data-status={result.route.status}>{statusText[result.route.status]}</span>
                      : <span className="px-mono">{result.pairing?.name}</span>}
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-muted" role="status">No pot on this controller matches “{query.trim()}”.</p>
          )
        ) : (
          <p className="px-muted px-small">{bookError ? `Valve routes unavailable: ${bookError}` : client ? "Search any pot from 1 to 100." : "Search by pot number or name."}</p>
        )}
        </>}
      </div>
    </div>
  );
}

function PotPanel({ titleId, pot, pairing, experiment, controllerName, client, book, onBook, recordHref, onClose }: {
  titleId: string; pot: number; pairing: PairingRow | null; experiment: PortalExperiment | null; controllerName: string;
  client: ManualWaterClient; book: RouteBook | null; onBook: (book: RouteBook) => void; recordHref: string | null; onClose: () => void;
}) {
  const route = book?.pots.find((entry) => entry.pot === pot) ?? null;
  const confirmed = route?.kind === "manual" && route.confirmedAt ? new Date(route.confirmedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : null;
  return (
    <div className="px-pot-panel">
      <header>
        <h2 id={titleId}>Pot {pot}</h2>
        <p>{experiment?.name ?? (pairing ? "Not in a current experiment" : "No sensor pairing")}</p>
      </header>
      <dl className="px-pot-facts">
        <div><dt>Valve</dt>{route?.relayAddress != null && route.channel != null ? <dd className="px-mono">{routeLabel(route.relayAddress, route.channel)}</dd> : <dd className="px-muted">Not confirmed</dd>}</div>
        <div><dt>Sensor</dt>{pairing ? <dd className="px-mono">{pairing.sensor_key}</dd> : <dd className="px-muted">None</dd>}</div>
        <div><dt>Route</dt><dd>{!route ? "Loading…" : route.kind === "pairing" ? `Pairing ${route.pairingName}` : route.kind === "manual" ? `Confirmed by an admin${confirmed ? ` · ${confirmed}` : ""}` : "—"}</dd></div>
        <div><dt>Controller</dt><dd>{controllerName}</dd></div>
      </dl>
      {!route ? <p className="px-muted px-small">Loading valve routes…</p>
        : route.status === "ready" ? <HoldWaterControl key={`${pot}:${route.relayAddress}:${route.channel}`} client={client} pot={route} />
        : <RouteNeeded route={route} canConfirm={Boolean(book?.canConfirm)} book={book} client={client} onBook={onBook} />}
      {recordHref ? <a className="px-pot-record" href={recordHref} onClick={onClose}>Open pot record <span aria-hidden="true">→</span></a> : null}
    </div>
  );
}

function RouteNeeded({ route, canConfirm, book, client, onBook }: { route: PotRoute; canConfirm: boolean; book: RouteBook | null; client: ManualWaterClient; onBook: (book: RouteBook) => void }) {
  const [board, setBoard] = useState(book?.boards[0] ?? 0);
  const [channel, setChannel] = useState(0);
  const [note, setNote] = useState("");
  const [traced, setTraced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const used = useMemo(() => new Map((book?.pots ?? []).filter((entry) => entry.relayAddress != null && entry.pot !== route.pot)
    .map((entry) => [`${entry.relayAddress}:${entry.channel}`, entry.pot])), [book, route.pot]);
  const submit = async (action: "confirm" | "remove") => {
    setBusy(true); setError("");
    const result = action === "confirm" ? await client.confirmRoute(route.pot, board, channel, note) : await client.removeRoute(route.pot);
    setBusy(false);
    if (!result) return;
    if (result.ok) onBook(result.data); else setError(result.error);
  };
  return (
    <section className="px-route-needed" data-status={route.status}>
      <h3>{route.status === "conflict" ? "Route conflict" : "No confirmed valve route"}</h3>
      <p>{route.status === "conflict" ? route.reason : "This pot has no sensor pairing, so its valve must be confirmed before it can be watered from here. Routes are never guessed from pot numbers."}</p>
      {canConfirm && route.status === "conflict" && route.kind === "manual"
        ? <button type="button" className="px-button is-small" disabled={busy} onClick={() => void submit("remove")}>Remove confirmed route</button> : null}
      {canConfirm && route.status === "unmapped" ? (
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
            <input value={note} maxLength={280} onChange={(event) => setNote(event.target.value)} placeholder="How the tubing was traced" />
          </label>
          <label className="px-route-check"><input type="checkbox" checked={traced} onChange={(event) => setTraced(event.target.checked)} />
            I traced this channel's tubing to pot {route.pot}.</label>
          <button type="submit" className="px-button is-primary" disabled={busy || !traced || !channel}>Confirm route</button>
        </form>
      ) : route.status === "unmapped" ? <p className="px-muted px-small">A project admin can confirm this pot's valve after tracing its tubing.</p> : null}
      {error ? <p className="px-route-error" role="alert">{error}</p> : null}
    </section>
  );
}
