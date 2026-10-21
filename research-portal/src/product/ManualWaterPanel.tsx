import { useEffect, useId, useMemo, useRef, useState } from "react";
import { HoldWaterControl } from "../HoldWaterControl";
import { boardLabel, ManualWaterClient, outputName, routeLabel, type Destination, type PotRoute, type RouteBook, type ValveOutput } from "../manualWaterApi";
import { RouteNeeded, routeSourceText } from "./FindPotDialog";

/**
 * Manual water / troubleshooting. Two ways to choose where water goes, one control:
 *  - By pot: a physical pot 1-100 through its recorded field route.
 *  - By solenoid: any configured valve output, directly, whether or not a sensor or a
 *    confirmed pot is associated with it. Testing an output never confirms a route or
 *    changes a pairing.
 */
export type ManualWaterTarget = { mode: "pot"; potNumber: number } | { mode: "solenoid"; relayAddress: number; channel: number } | null;

const potStatusText = { ready: "Ready", needs_confirmation: "Needs check", no_water_line: "No water line", unmapped: "No route", conflict: "Conflict" } as const;

export function ManualWaterPanel({
  open,
  onClose,
  projectId,
  deviceId,
  controllerName,
  initial = null,
}: {
  open: boolean;
  onClose: () => void;
  projectId: string;
  deviceId: string;
  controllerName: string;
  initial?: ManualWaterTarget;
}) {
  const [mode, setMode] = useState<"pot" | "solenoid">(initial?.mode ?? "solenoid");
  const [query, setQuery] = useState("");
  const [book, setBook] = useState<RouteBook | null>(null);
  const [bookError, setBookError] = useState("");
  const [selected, setSelected] = useState<ManualWaterTarget>(initial);
  const titleId = useId();
  const searchRef = useRef<HTMLInputElement | null>(null);
  const client = useMemo(() => new ManualWaterClient(projectId, deviceId), [projectId, deviceId]);

  useEffect(() => {
    if (!open) return undefined;
    setSelected(initial);
    if (initial) setMode(initial.mode);
    setQuery("");
    const previous = document.activeElement as HTMLElement | null;
    const timer = window.setTimeout(() => searchRef.current?.focus(), 0);
    let current = true;
    setBookError("");
    void client.inventory().then((result) => {
      if (!current || !result) return;
      if (result.ok) setBook(result.data); else setBookError(result.error);
    });
    return () => {
      current = false;
      window.clearTimeout(timer);
      previous?.focus?.();
    };
    // Re-open with a new initial target re-selects it.
  }, [open, client, initial?.mode, initial && "potNumber" in initial ? initial.potNumber : null, initial && "channel" in initial ? `${initial.relayAddress}:${initial.channel}` : null]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!open) return null;

  const q = query.trim().toLowerCase();
  const outputs = book?.outputs ?? [];
  const pots = book?.pots ?? [];
  const matchOutput = (output: ValveOutput) => !q
    || String(output.solenoidNumber ?? "") === q
    || (output.solenoidNumber != null && String(output.solenoidNumber).startsWith(q))
    || output.key.toLowerCase().includes(q.replace(/\s/g, ""))
    || output.pots.some((pot) => String(pot) === q)
    || (output.pairing?.name.toLowerCase().includes(q) ?? false);
  const matchPot = (route: PotRoute) => !q || String(route.pot) === q || String(route.pot).startsWith(q) || (route.pairing?.name.toLowerCase().includes(q) ?? false);
  const boards = Array.from(new Set(outputs.map((output) => output.relayAddress)));

  const chosenOutput = selected?.mode === "solenoid" ? outputs.find((output) => output.relayAddress === selected.relayAddress && output.channel === selected.channel) ?? null : null;
  const chosenPot = selected?.mode === "pot" ? pots.find((route) => route.pot === selected.potNumber) ?? null : null;

  return (
    <div className="px-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="px-dialog px-manual-water" role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={(event) => {
        if (event.key === "Escape" && !(event.target instanceof HTMLElement && event.target.classList.contains("px-hold"))) {
          event.preventDefault();
          if (selected) setSelected(null); else onClose();
        }
      }}>
        <div className="px-dialog-heading">
          {selected ? <button type="button" className="px-button is-small is-quiet" onClick={() => setSelected(null)}>← All {mode === "pot" ? "pots" : "solenoids"}</button> : <h2 id={titleId}>Manual water · Troubleshooting</h2>}
          <button type="button" className="px-button is-small" onClick={onClose}>Close</button>
        </div>
        {!selected ? (
          <>
            <div className="px-segmented" role="tablist" aria-label="Choose by">
              <button type="button" role="tab" aria-selected={mode === "solenoid"} onClick={() => setMode("solenoid")}>By solenoid</button>
              <button type="button" role="tab" aria-selected={mode === "pot"} onClick={() => setMode("pot")}>By pot</button>
            </div>
            <input
              ref={searchRef}
              className="px-manual-search"
              value={query}
              inputMode="search"
              aria-label={mode === "pot" ? "Pot number or pairing" : "Solenoid number, board:channel, pot or pairing"}
              placeholder={mode === "pot" ? "Pot number 1–100" : "Solenoid number, 0x20:26, pot or pairing"}
              onChange={(event) => setQuery(event.target.value)}
            />
            {bookError ? <p className="px-route-error" role="alert">Valve inventory unavailable: {bookError}</p> : !book ? <p className="px-muted">Loading the controller's valve inventory…</p> : null}
            {mode === "solenoid" && book ? (
              <div className="px-manual-list" aria-label="Configured valve outputs">
                <p className="px-muted px-small">{outputs.length} configured outputs on {boards.length} board{boards.length === 1 ? "" : "s"}. Solenoid numbers are the recorded output labels; the pot an output waters is shown only from a recorded field route.</p>
                {boards.map((relay) => {
                  const items = outputs.filter((output) => output.relayAddress === relay && matchOutput(output));
                  if (!items.length) return null;
                  return (
                    <section key={relay} aria-label={`Board ${boardLabel(relay)}`}>
                      <h3 className="px-manual-board">Board {boardLabel(relay)}</h3>
                      <ul className="px-output-grid">
                        {items.map((output) => (
                          <li key={output.key}>
                            <button type="button" className="px-output-choice" onClick={() => setSelected({ mode: "solenoid", relayAddress: output.relayAddress, channel: output.channel })}
                              aria-label={`${outputName(output)}, board ${boardLabel(output.relayAddress)} channel ${output.channel}${output.pots.length ? `, waters pot ${output.pots.join(", ")}` : ", physical pot unknown"}`}>
                              <b>{output.solenoidNumber ?? "—"}</b>
                              <span className="px-mono">{boardLabel(output.relayAddress)}:{output.channel}</span>
                              <span>{output.pots.length ? `Pot ${output.pots.join(", ")}` : output.candidatePots.length ? `Pot ${output.candidatePots.join(", ")}?` : "Pot unknown"}</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    </section>
                  );
                })}
              </div>
            ) : null}
            {mode === "pot" && book ? (
              <ul className="px-results px-manual-list" aria-label="Physical pots">
                {pots.filter(matchPot).map((route) => (
                  <li key={route.pot}>
                    <button type="button" className="px-pot-choice" onClick={() => setSelected({ mode: "pot", potNumber: route.pot })}>
                      <b>Pot {route.pot}</b>
                      <span>{route.relayAddress != null && route.channel != null ? routeLabel(route.relayAddress, route.channel) : route.reason ?? ""}</span>
                      <span className="px-route-badge" data-status={route.status}>{potStatusText[route.status]}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        ) : chosenOutput && selected?.mode === "solenoid" ? (
          <OutputPanel client={client} book={book!} output={chosenOutput} controllerName={controllerName} onBook={setBook} titleId={titleId} />
        ) : selected?.mode === "pot" ? (
          <PotWaterPanel client={client} book={book} route={chosenPot} potNumber={selected.potNumber} controllerName={controllerName} onBook={setBook} titleId={titleId} />
        ) : (
          <p className="px-muted">{book ? "That output is not configured on this controller." : "Loading…"}</p>
        )}
      </div>
    </div>
  );
}

function OutputPanel({ client, book, output, controllerName, onBook, titleId }: { client: ManualWaterClient; book: RouteBook; output: ValveOutput; controllerName: string; onBook: (book: RouteBook) => void; titleId: string }) {
  const destination: Destination = { kind: "solenoid", relayAddress: output.relayAddress, channel: output.channel };
  const name = outputName(output);
  return (
    <div className="px-pot-panel">
      <header>
        <h2 id={titleId}>{name}</h2>
        <p>Direct output test · {controllerName}</p>
      </header>
      <dl className="px-pot-facts">
        <div><dt>Output</dt><dd className="px-mono">Board {boardLabel(output.relayAddress)} · channel {output.channel}</dd></div>
        <div><dt>Solenoid label</dt><dd>{output.solenoidNumber == null ? <span className="px-muted">Not recorded</span> : output.labelStatus === "confirmed" ? `${output.solenoidNumber} · confirmed` : `${output.solenoidNumber} · from the board's printed numbering, not yet checked`}</dd></div>
        <div><dt>Physical pot</dt><dd>{output.pots.length ? `Pot ${output.pots.join(", ")} (confirmed field route)` : output.candidatePots.length ? <span>Pot {output.candidatePots.join(", ")} <span className="px-muted">(recorded, needs a physical check)</span></span> : <span className="px-muted">Unknown: no recorded route uses this output</span>}</dd></div>
        <div><dt>Sensor pairing</dt><dd>{output.pairing ? <span>{output.pairing.name}{output.pairing.sensorKey ? <span className="px-mono px-muted"> · {output.pairing.sensorKey}</span> : null}</span> : output.sharedPairings ? `Shared by ${output.sharedPairings.join(", ")}` : <span className="px-muted">None</span>}</dd></div>
      </dl>
      <HoldWaterControl key={`out:${output.key}`} client={client} destination={destination} label={name} renewMs={book.renewMs} leaseMs={book.leaseMs} canTakeover={book.canTakeover} />
      <p className="px-muted px-small">Holding this output does not confirm which pot it waters and does not change any route or pairing. Record a route from the pot's page after watching it water.</p>
      {book.canConfirm ? <OutputLabelForm client={client} output={output} onBook={onBook} /> : null}
    </div>
  );
}

function OutputLabelForm({ client, output, onBook }: { client: ManualWaterClient; output: ValveOutput; onBook: (book: RouteBook) => void }) {
  const [number, setNumber] = useState(output.solenoidNumber ?? 0);
  const [note, setNote] = useState("");
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <details className="px-details">
      <summary>Record the printed solenoid label (admin)</summary>
      <form className="px-route-form" onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true); setError("");
        const result = await client.labelOutput(number, output.relayAddress, output.channel, note);
        setBusy(false);
        if (result?.ok) onBook(result.data); else if (result) setError(result.error);
      }}>
        <label>Printed label
          <input type="number" min={1} max={1000} value={number || ""} onChange={(event) => setNumber(Number(event.target.value))} />
        </label>
        <label className="px-route-note"><span>Note <span className="px-muted">(optional)</span></span>
          <input value={note} maxLength={600} onChange={(event) => setNote(event.target.value)} placeholder="Who read the label, and when" />
        </label>
        <label className="px-route-check"><input type="checkbox" checked={checked} onChange={(event) => setChecked(event.target.checked)} /> I read this label on board {boardLabel(output.relayAddress)}, channel {output.channel}.</label>
        <button type="submit" className="px-button is-primary" disabled={busy || !checked || !(number >= 1)}>Record label</button>
        {error ? <p className="px-route-error" role="alert">{error}</p> : null}
      </form>
    </details>
  );
}

function PotWaterPanel({ client, book, route, potNumber, controllerName, onBook, titleId }: { client: ManualWaterClient; book: RouteBook | null; route: PotRoute | null; potNumber: number; controllerName: string; onBook: (book: RouteBook) => void; titleId: string }) {
  const valve = route?.relayAddress != null && route.channel != null ? routeLabel(route.relayAddress, route.channel) : null;
  const output = route?.relayAddress != null ? book?.outputs.find((item) => item.relayAddress === route.relayAddress && item.channel === route.channel) ?? null : null;
  return (
    <div className="px-pot-panel">
      <header>
        <h2 id={titleId}>Pot {potNumber}</h2>
        <p>{controllerName}</p>
      </header>
      <dl className="px-pot-facts">
        <div><dt>Valve</dt>{valve ? <dd className="px-mono">{valve}{output?.solenoidNumber != null ? ` · solenoid ${output.solenoidNumber}` : ""}</dd> : <dd className="px-muted">{route?.status === "no_water_line" ? "No water line" : "Not confirmed"}</dd>}</div>
        <div><dt>Sensor pairing</dt>{route?.pairing ? <dd><span>{route.pairing.name}</span>{route.pairing.sensorKey ? <span className="px-mono px-muted"> · {route.pairing.sensorKey}</span> : null}</dd> : <dd className="px-muted">None</dd>}</div>
        <div><dt>Route record</dt><dd>{route ? routeSourceText(route) : "Loading…"}</dd></div>
      </dl>
      {!route || !book ? <p className="px-muted px-small">Loading valve routes…</p>
        : route.status === "ready"
          ? <HoldWaterControl key={`pot:${potNumber}:${route.relayAddress}:${route.channel}`} client={client} destination={{ kind: "pot", potNumber }} label={`Pot ${potNumber}`} renewMs={book.renewMs} leaseMs={book.leaseMs} canTakeover={book.canTakeover} />
          : <RouteNeeded route={route} canConfirm={book.canConfirm} book={book} client={client} onBook={onBook} />}
    </div>
  );
}
