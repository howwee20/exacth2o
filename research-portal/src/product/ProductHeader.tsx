import { Search, UserRound } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import exactH2OLogo from "../assets/exacth2o-logo.jpeg";
import { PortalLink } from "./PortalLink";
import "./product.css";

/**
 * One header for every product view. The logo returns to the default experiment list.
 */
export function ProductHeader({
  onFindPot,
  onOpenAccount,
  atBench,
  onToggleAtBench,
  onSignOut,
  extra,
  demo = false,
}: {
  onFindPot: () => void;
  onOpenAccount?: () => void;
  atBench?: boolean;
  onToggleAtBench?: () => void;
  onSignOut: () => void;
  extra?: ReactNode;
  demo?: boolean;
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
      event.preventDefault();
      onFindPot();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onFindPot]);

  return (
    <header className="px-header">
      <PortalLink className="dashboard-logo" to={{ view: "home" }} aria-label="Experiments">
        <img src={exactH2OLogo} alt="ExactH2O" />
      </PortalLink>
      <div className="px-header-actions">
        <button type="button" className="px-header-button" onClick={onFindPot} aria-keyshortcuts="/" aria-label="Find pot">
          <Search size={14} aria-hidden="true" />
          <span className="px-label-wide">Find pot</span>
          <kbd aria-hidden="true">/</kbd>
        </button>
        {extra}
        {demo ? null : <details className="px-menu px-header-menu" onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.currentTarget.open = false;
            event.currentTarget.querySelector("summary")?.focus();
          }
        }} onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) event.currentTarget.open = false;
        }}>
          <summary aria-label="Profile menu" title="Profile menu"><UserRound size={18} aria-hidden="true" /></summary>
          <div className="px-menu-panel">
            {onOpenAccount ? <button type="button" onClick={(event) => {
              event.currentTarget.closest("details")?.removeAttribute("open");
              onOpenAccount();
            }}>Account &amp; access</button> : null}
            {onToggleAtBench ? <button type="button" aria-pressed={atBench} onClick={(event) => {
              event.currentTarget.closest("details")?.removeAttribute("open");
              onToggleAtBench();
            }}>{atBench ? "Leave field mode" : "Field mode"}</button> : null}
            <hr />
            <button type="button" onClick={onSignOut}>Sign out</button>
          </div>
        </details>}
      </div>
    </header>
  );
}
