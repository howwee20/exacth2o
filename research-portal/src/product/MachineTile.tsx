import { ArrowRight, ChevronDown, Plus } from "lucide-react";
import type { ReactNode } from "react";
import type { PortalRoute } from "../portalRoute";
import { PortalLink } from "./PortalLink";
import "./product.css";

// The home screen's system tile and the frame the tiles sit in. This file imports nothing from the backend, so the
// demo's first screen can show the same tiles without loading any data code.
export function MachineTile({ name, detail, status, statusTone = "unknown", to, extra, traceExtra, healthTo, creation, onPrepare }: {
  name: string;
  detail?: string;
  status?: ReactNode;
  statusTone?: "online" | "warning" | "offline" | "unknown";
  to: PortalRoute;
  extra?: Record<string, string | null>;
  traceExtra?: Record<string, string | null>;
  /** Left out where there is no health screen to open, as in the demo. */
  healthTo?: PortalRoute;
  creation: { to: PortalRoute } | { unavailable: string };
  onPrepare?: () => void;
}) {
  return <div className="px-system-card">
    <PortalLink className="px-system-tile" to={to} extra={{ ...extra, ...traceExtra }} reloadDocument={Boolean(extra?.project)} aria-label={`Open ${name}`} onPointerEnter={onPrepare} onFocus={onPrepare}>
      <span className="px-system-tile-header">
        <span className="px-system-tile-name">{name}</span>
        <span className={`px-system-status is-${statusTone}`}><span className="px-system-status-dot" aria-hidden="true" />{status ?? "Status unavailable"}</span>
      </span>
      <span className="px-system-experiment">
        <span className="px-system-experiment-label">Active experiment</span>
        <span className="px-system-tile-detail">{detail ?? "No active experiment"}</span>
      </span>
    </PortalLink>
    <div className="px-system-tile-footer">
      {"to" in creation ? <PortalLink className="px-system-create" to={creation.to} extra={extra} reloadDocument={Boolean(extra?.project)} aria-label={`New experiment on ${name}`}>
        <Plus size={13} aria-hidden="true" /> New experiment
      </PortalLink> : <button type="button" className="px-system-create" disabled title={creation.unavailable} aria-label={`New experiment on ${name} unavailable`}>
        <Plus size={13} aria-hidden="true" /> New experiment
      </button>}
      {healthTo ? <PortalLink className="px-system-health-link" to={healthTo} extra={extra} reloadDocument={Boolean(extra?.project)} aria-label={`${name} system health`}>
        System health <ArrowRight size={13} aria-hidden="true" />
      </PortalLink> : null}
    </div>
  </div>;
}

export function MachineHome({ children, tools }: { children: ReactNode; tools?: ReactNode }) {
  return <section className="px-home px-machine-home" aria-label="Your systems">
    <div className="px-system-tile-grid">{children}</div>
    {tools ? <details className="px-tools px-home-administration">
      <summary>Administration <ChevronDown size={18} aria-hidden="true" /></summary>
      <div className="px-admin-tools-body">{tools}</div>
    </details> : null}
  </section>;
}
