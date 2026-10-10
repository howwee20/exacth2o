import { Search, Settings as SettingsIcon } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import exactH2OLogo from "../assets/exacth2o-logo.jpeg";
import { type PortalRoute } from "../portalRoute";
import { PortalLink } from "./PortalLink";
import "./product.css";

export type NavSection = "experiments" | "bench" | "other";

export function navSectionForRoute(route: PortalRoute): NavSection {
  if (route.view === "home" || route.view === "experiment" || route.view === "pot" || route.view === "trends") return "experiments";
  if (route.view === "bench") return "bench";
  return "other";
}

/**
 * One header for every product view: Experiments and Bench, with Find pot as a global action.
 */
export function ProductHeader({
  route,
  sections,
  onFindPot,
  onOpenAccount,
  atBench,
  onToggleAtBench,
  onSignOut,
  extra,
  demo = false,
}: {
  route: PortalRoute;
  sections: { bench: boolean };
  onFindPot: () => void;
  onOpenAccount?: () => void;
  atBench?: boolean;
  onToggleAtBench?: () => void;
  onSignOut: () => void;
  extra?: ReactNode;
  demo?: boolean;
}) {
  const section = navSectionForRoute(route);

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
      <a className="dashboard-logo" href="/" aria-label="ExactH2O website home">
        <img src={exactH2OLogo} alt="ExactH2O" />
      </a>
      <nav className="px-nav" aria-label="Portal">
        <PortalLink to={{ view: "home" }} aria-current={section === "experiments" ? "page" : undefined}>Experiments</PortalLink>
        {sections.bench ? <PortalLink to={{ view: "bench", pot: null }} aria-current={section === "bench" ? "page" : undefined}>Bench</PortalLink> : null}
      </nav>
      <div className="px-header-actions">
        <button type="button" className="px-header-button" onClick={onFindPot} aria-keyshortcuts="/" aria-label="Find pot">
          <Search size={14} aria-hidden="true" />
          <span className="px-label-wide">Find pot</span>
          <kbd aria-hidden="true">/</kbd>
        </button>
        {extra}
        {demo ? <span className="px-demo-label">Sample workspace</span> : <details className="px-menu px-header-menu" onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.currentTarget.open = false;
            event.currentTarget.querySelector("summary")?.focus();
          }
        }} onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) event.currentTarget.open = false;
        }}>
          <summary><SettingsIcon size={15} aria-hidden="true" /><span className="px-label-wide">Account</span></summary>
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
