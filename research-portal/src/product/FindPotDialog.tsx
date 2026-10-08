import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { PortalExperiment } from "../experimentRegistry";
import { navigatePortal, portalRouteHref, type PortalRoute } from "../portalRoute";
import { searchPots } from "../potIdentity";
import type { PairingRow } from "../types";

/** Global pot lookup: number, pairing name or experiment name; Enter opens the first match. */
export function FindPotDialog({
  open,
  onClose,
  pairings,
  experiments,
  routeFor,
}: {
  open: boolean;
  onClose: () => void;
  pairings: readonly PairingRow[];
  experiments: readonly PortalExperiment[];
  routeFor: (pairingName: string) => PortalRoute;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const titleId = useId();
  const listId = useId();
  const results = useMemo(() => searchPots(query, pairings, experiments), [experiments, pairings, query]);

  useEffect(() => {
    if (!open) return undefined;
    setQuery("");
    setActive(0);
    const timer = window.setTimeout(() => inputRef.current?.focus(), 0);
    const previous = document.activeElement as HTMLElement | null;
    return () => {
      window.clearTimeout(timer);
      previous?.focus?.();
    };
  }, [open]);

  if (!open) return null;

  const go = (pairingName: string) => {
    onClose();
    navigatePortal(routeFor(pairingName));
  };

  return (
    <div className="px-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="px-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        }
      }}>
        <h2 id={titleId}>Find a pot</h2>
        <input
          ref={inputRef}
          value={query}
          inputMode="search"
          placeholder="Pot number, pairing or experiment"
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
              go(results[active].pairing.name);
            }
          }}
        />
        {query.trim() ? (
          results.length ? (
            <ul className="px-results" id={listId} role="listbox" aria-label="Matching pots">
              {results.map((result, index) => (
                <li key={result.pairing.name} role="presentation">
                  <a
                    id={`${listId}-${index}`}
                    role="option"
                    aria-selected={index === active}
                    href={portalRouteHref(routeFor(result.pairing.name))}
                    onClick={(event) => {
                      if (event.metaKey || event.ctrlKey || event.shiftKey) return;
                      event.preventDefault();
                      go(result.pairing.name);
                    }}
                  >
                    <b>Pot {result.pairing.pot_number}</b>
                    <span>{result.experiment ? result.experiment.name : "Not in a current experiment"}</span>
                    <span className="px-mono">{result.pairing.name}</span>
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-muted" role="status">No pot on this controller matches “{query.trim()}”.</p>
          )
        ) : (
          <p className="px-muted px-small">Type a pot number, e.g. 17. Pots are the controller's pairings for this project.</p>
        )}
      </div>
    </div>
  );
}
