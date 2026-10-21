import { useCallback, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { readingOrder, type AerialModel, type AerialPot } from "../aerialLayout";
import "./aerial.css";

/** What one pot looks like on the aerial view. Shape and glyph carry meaning, not colour alone. */
export type AerialPotStatus =
  | "idle"
  | "queued"
  | "active"
  | "matched"
  | "changed"
  | "unresolved"
  | "unclaimed"
  | "failed"
  | "interrupted";

export type AerialPotState = {
  /** False when the pot cannot take part now; `reason` says why. */
  available: boolean;
  reason?: string;
  status?: AerialPotStatus;
  /** A researcher-confirmed pairing used as a positive control. */
  reference?: boolean;
  /** Extra words for the accessible name and tooltip. */
  detail?: string;
};

const statusGlyph: Record<AerialPotStatus, string> = {
  idle: "",
  queued: "",
  active: "",
  matched: "✓",
  changed: "↔",
  unresolved: "?",
  unclaimed: "?",
  failed: "!",
  interrupted: "‖",
};

export const statusWords: Record<AerialPotStatus, string> = {
  idle: "",
  queued: "queued",
  active: "being tested now",
  matched: "matches its recorded valve",
  changed: "a different valve waters it",
  unresolved: "unresolved",
  unclaimed: "no selected valve reached it",
  failed: "failed",
  interrupted: "interrupted",
};

type Props = {
  model: AerialModel;
  states: ReadonlyMap<string, AerialPotState>;
  selected: ReadonlySet<string>;
  /** When false the view is read-only (progress and results). */
  selectable: boolean;
  onToggle?: (pairingName: string) => void;
  onToggleZone?: (zone: number) => void;
  onInspect?: (pairingName: string) => void;
  /** Accessible name for the whole view. */
  label: string;
};

function potName(pot: AerialPot, state: AerialPotState | undefined, selected: boolean, selectable: boolean) {
  const parts = [`Pot ${pot.potNumber}`, `zone ${pot.zone}`];
  if (pot.unavailableReason) parts.push(`unavailable: ${pot.unavailableReason}`);
  else parts.push(pot.pairingName);
  if (state?.reference) parts.push("known-correct reference");
  if (selectable) parts.push(selected ? "selected" : "not selected");
  if (state && !state.available) parts.push(`unavailable: ${state.reason ?? "cannot take part"}`);
  if (state?.status && state.status !== "idle") parts.push(statusWords[state.status]);
  if (state?.detail) parts.push(state.detail);
  return parts.join(", ");
}

/**
 * The installation seen from above: zones as the presentation's nodes, every pot a
 * numbered circle. Click, tap, Space or Enter toggles a pot; arrow keys move between
 * pots; each zone's chip selects or clears that zone.
 */
export function AerialBench({ model, states, selected, selectable, onToggle, onToggleZone, onInspect, label }: Props) {
  const order = useMemo(() => readingOrder(model), [model]);
  const [focusName, setFocusName] = useState<string | null>(null);
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const tabbable = focusName && order.some((pot) => pot.pairingName === focusName) ? focusName : order[0]?.pairingName ?? null;

  const move = useCallback((from: AerialPot, rowDelta: number, columnDelta: number) => {
    const bench = model.benches.find((item) => item.id === from.bench);
    if (!bench) return;
    let next: AerialPot | undefined;
    if (rowDelta === 0) {
      const index = order.indexOf(from) + columnDelta;
      next = order[Math.max(0, Math.min(order.length - 1, index))];
    } else {
      // Nearest pot in the next row with pots, keeping the column where possible.
      for (let row = from.row + rowDelta; row >= 1 && row <= bench.rows && !next; row += rowDelta) {
        const candidates = bench.pots.filter((pot) => pot.row === row);
        next = candidates.sort((a, b) => Math.abs(a.column - from.column) - Math.abs(b.column - from.column))[0];
      }
    }
    if (next) {
      setFocusName(next.pairingName);
      refs.current.get(next.pairingName)?.focus();
    }
  }, [model.benches, order]);

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, pot: AerialPot) => {
    const deltas: Record<string, [number, number]> = { ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [-1, 0], ArrowDown: [1, 0] };
    const delta = deltas[event.key];
    if (delta) {
      event.preventDefault();
      move(pot, delta[0], delta[1]);
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const target = event.key === "Home" ? order[0] : order[order.length - 1];
      if (target) {
        setFocusName(target.pairingName);
        refs.current.get(target.pairingName)?.focus();
      }
    } else if ((event.key === "i" || event.key === "I") && onInspect && !pot.unavailableReason) {
      event.preventDefault();
      onInspect(pot.pairingName);
    }
  };

  const renderPot = (pot: AerialPot, style?: CSSProperties) => {
    const state = states.get(pot.pairingName);
    const isSelected = selected.has(pot.pairingName);
    const available = !pot.unavailableReason && state?.available !== false;
    const status = state?.status ?? "idle";
    const classes = [
      "ax-pot",
      `is-tone-${pot.tone}`,
      isSelected ? "is-selected" : "",
      available ? "" : "is-unavailable",
      status !== "idle" ? `is-${status}` : "",
      state?.reference ? "is-reference" : "",
    ].filter(Boolean).join(" ");
    const name = potName(pot, state, isSelected, selectable);
    return (
      <button
        key={pot.pairingName}
        ref={(node) => { if (node) refs.current.set(pot.pairingName, node); else refs.current.delete(pot.pairingName); }}
        type="button"
        className={classes}
        style={style}
        tabIndex={pot.pairingName === tabbable ? 0 : -1}
        aria-pressed={selectable ? isSelected : undefined}
        aria-disabled={selectable && !available ? true : undefined}
        aria-label={name}
        title={name}
        data-pot={pot.potNumber}
        data-pairing={pot.pairingName}
        onFocus={() => setFocusName(pot.pairingName)}
        onClick={() => {
          if (selectable) {
            if (available) onToggle?.(pot.pairingName);
          } else if (!pot.unavailableReason) onInspect?.(pot.pairingName);
        }}
        onKeyDown={(event) => onKeyDown(event, pot)}
      >
        <span className="ax-pot-number">{pot.potNumber}</span>
        {statusGlyph[status] ? <span className="ax-pot-glyph" aria-hidden="true">{statusGlyph[status]}</span> : null}
        {state?.reference ? <span className="ax-pot-star" aria-hidden="true">★</span> : null}
      </button>
    );
  };

  const zoneChip = (node: AerialModel["nodes"][number]) => {
    const names = node.pairingNames;
    const eligible = names.filter((name) => states.get(name)?.available !== false);
    const chosen = names.filter((name) => selected.has(name)).length;
    const all = eligible.length > 0 && eligible.every((name) => selected.has(name));
    return (
      <button
        key={node.zone}
        type="button"
        className={`ax-node is-tone-${node.tone}${all ? " is-all" : ""}`}
        disabled={!selectable || eligible.length === 0}
        aria-pressed={selectable ? all : undefined}
        onClick={() => onToggleZone?.(node.zone)}
        aria-label={`${node.label}: ${chosen} of ${names.length} selected. ${all ? "Clear" : "Select"} this zone.`}
      >
        <span className="ax-node-dot" aria-hidden="true" />
        <span className="ax-node-label">{node.label}</span>
        <span className="ax-node-count">{chosen}/{names.length}</span>
      </button>
    );
  };

  const presentation = model.composition === "presentation";
  const top = model.nodes.filter((node) => node.side === "top");
  const bottom = model.nodes.filter((node) => node.side === "bottom");

  return (
    <div className={`ax-aerial${presentation ? " is-presentation" : ""}`} role="group" aria-label={label}>
      {presentation ? (
        <>
          <div className="ax-overhead">
            <div className="ax-nodes is-top">{top.map(zoneChip)}</div>
            <div className="ax-installation">
              <div className="ax-bench" aria-label="Bench, seen from above">
                {model.benches[0].pots.map((pot) => renderPot(pot, { gridRow: pot.row, gridColumn: pot.column }))}
              </div>
              <div className="ax-controller" aria-hidden="true">Modular<br />controller</div>
            </div>
            <div className="ax-nodes is-bottom">{bottom.map(zoneChip)}</div>
          </div>
          {/* Phones: the same pots, one zone at a time, with full-size touch targets. */}
          <div className="ax-compact">
            {model.nodes.map((node) => (
              <section key={node.zone} className={`ax-compact-zone is-tone-${node.tone}`} aria-label={node.label}>
                <div className="ax-compact-head">{zoneChip(node)}</div>
                <div className="ax-compact-grid">
                  {model.benches[0].pots.filter((pot) => pot.zone === node.zone).map((pot) => renderCompact(pot))}
                </div>
              </section>
            ))}
          </div>
          {model.benches.slice(1).map((bench) => (
            <section key={bench.id} className="ax-bench-card" aria-label={bench.label}>
              <h4>{bench.label}</h4>
              <div className="ax-compact-grid">
                {bench.pots.map((pot) => renderCompact(pot))}
              </div>
            </section>
          ))}
        </>
      ) : (
        <div className="ax-benches">
          {model.nodes.length > 1 ? <div className="ax-nodes is-top">{model.nodes.map(zoneChip)}</div> : null}
          {model.benches.map((bench) => (
            <section key={bench.id} className="ax-bench-card" aria-label={bench.label}>
              <h4>{bench.label}</h4>
              <div className="ax-bench is-recorded" style={{ gridTemplateColumns: `repeat(${bench.columns}, var(--ax-pot))` }}>
                {bench.pots.map((pot) => renderPot(pot, { gridRow: pot.row, gridColumn: pot.column }))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );

  // The compact copy shares state with the overhead grid but is a separate set of buttons.
  function renderCompact(pot: AerialPot) {
    const state = states.get(pot.pairingName);
    const isSelected = selected.has(pot.pairingName);
    const available = !pot.unavailableReason && state?.available !== false;
    const status = state?.status ?? "idle";
    const name = potName(pot, state, isSelected, selectable);
    return (
      <button
        key={`compact-${pot.pairingName}`}
        type="button"
        className={["ax-pot", "is-compact", `is-tone-${pot.tone}`, isSelected ? "is-selected" : "", available ? "" : "is-unavailable", status !== "idle" ? `is-${status}` : "", state?.reference ? "is-reference" : ""].filter(Boolean).join(" ")}
        aria-pressed={selectable ? isSelected : undefined}
        aria-disabled={selectable && !available ? true : undefined}
        aria-label={name}
        data-pot={pot.potNumber}
        onClick={() => {
          if (selectable) {
            if (available) onToggle?.(pot.pairingName);
          } else if (!pot.unavailableReason) onInspect?.(pot.pairingName);
        }}
      >
        <span className="ax-pot-number">{pot.potNumber}</span>
        {statusGlyph[status] ? <span className="ax-pot-glyph" aria-hidden="true">{statusGlyph[status]}</span> : null}
        {state?.reference ? <span className="ax-pot-star" aria-hidden="true">★</span> : null}
      </button>
    );
  }
}
