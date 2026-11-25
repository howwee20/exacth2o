import { ArrowRight, ChevronDown, Plus } from "lucide-react";
import type { ReactNode } from "react";
import type { PortalRoute } from "../portalRoute";
import { PortalLink } from "./PortalLink";
import "./product.css";

// The home screen's system tile and the frame the tiles sit in. This file imports nothing from the backend, so the
// demo's first screen can show the same tiles without loading any data code.
export function MachineTile({ name, detail, status, statusTone = "unknown", to, extra, traceExtra, healthTo, creation, onPrepare, experiments, setup, children }: {
  name: string;
  detail?: string;
  experiments?: readonly {id:string; name:string; to?:PortalRoute; extra?:Record<string,string|null>}[];
  setup?: ReactNode;
  children?: ReactNode;
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
  return <div className={experiments ? "px-machine-tree has-branches" : "px-machine-tree"} role="group" aria-label={name}>
    <div className="px-study-branches">
      {experiments?.map(study => (
        <PortalLink key={study.id} className="px-study-tile"
          aria-label={study.name}
          to={study.to ?? {view:"experiment",experiment:study.id,tab:"pots",pot:null}}
          extra={{...extra,...study.extra}} reloadDocument={Boolean(extra?.project)}
          onPointerEnter={onPrepare} onFocus={onPrepare}>
          <span><span className="px-study-caption">Active experiment</span><strong>{study.name}</strong></span>
          <ArrowRight size={17} aria-hidden="true"/>
        </PortalLink>
      ))}
      {setup}
    </div>
    <div className="px-system-card">
      <PortalLink className="px-system-tile" to={to} extra={{...extra,...traceExtra}} reloadDocument={Boolean(extra?.project)} aria-label={`Open ${name}`} onPointerEnter={onPrepare} onFocus={onPrepare}>
        <span className="px-system-tile-header">
          <span className="px-system-tile-name">{name}</span>
          {status && <span className={`px-system-status is-${statusTone}`}><span className="px-system-status-dot" aria-hidden="true"/>{status}</span>}
        </span>
        {!experiments?.length && detail && <span className="px-system-experiment">
          {!experiments && <span className="px-system-experiment-label">Active experiment</span>}
          <span className="px-system-tile-detail">{detail}</span>
        </span>}
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
    {children && <div className="px-machine-extras">{children}</div>}
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
