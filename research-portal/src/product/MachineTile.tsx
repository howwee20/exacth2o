import { ArrowRight, ChevronDown, Plus } from "lucide-react";
import type { ReactNode } from "react";
import type { PortalRoute } from "../portalRoute";
import { PortalLink } from "./PortalLink";
import "./product.css";

// The home screen's system tile and the frame the tiles sit in. This file imports nothing from the backend, so the
// demo's first screen can show the same tiles without loading any data code.
//
// One card is one machine: its name and status on top, every experiment running on it as a row underneath, and
// the two things to do with the machine along the bottom.
export type MachineExperiment = {
  id: string;
  name: string;
  to?: PortalRoute;
  extra?: Record<string, string | null>;
  /** Shown beside the name, such as "12 pots". Worked out from pairingNames when left out. */
  meta?: string;
  pairingNames?: readonly string[];
};

export function MachineTile({ name, detail, status, statusTone = "unknown", to, extra, traceExtra, healthTo, creation, onPrepare, experiments, setup, children }: {
  name: string;
  /** What the card says when nothing is running on the machine. */
  detail?: string;
  experiments?: readonly MachineExperiment[];
  /** A setup in progress on this machine. It takes a row of its own under the experiments. */
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
  return <div className="px-machine-tree" role="group" aria-label={name}>
    <div className="px-system-card">
      <PortalLink className="px-system-tile" to={to} extra={{...extra,...traceExtra}} reloadDocument={Boolean(extra?.project)} aria-label={`Open ${name}`} onPointerEnter={onPrepare} onFocus={onPrepare}>
        <span className="px-system-tile-header">
          <span className="px-system-tile-name">{name}</span>
          {status && <span className={`px-system-status is-${statusTone}`}><span className="px-system-status-dot" aria-hidden="true"/>{status}</span>}
        </span>
      </PortalLink>
      <div className="px-study-list">
        {experiments?.map(study => {
          const meta = study.meta ?? (study.pairingNames?.length ? `${study.pairingNames.length} ${study.pairingNames.length === 1 ? "pot" : "pots"}` : null);
          return <PortalLink key={study.id} className="px-study-row"
            aria-label={study.name}
            to={study.to ?? {view:"experiment",experiment:study.id,tab:"pots",pot:null}}
            extra={{...extra,...study.extra}} reloadDocument={Boolean(extra?.project)}
            onPointerEnter={onPrepare} onFocus={onPrepare}>
            <span className="px-study-text"><strong>{study.name}</strong></span>
            {meta ? <span className="px-study-meta">{meta}</span> : null}
            <ArrowRight size={15} aria-hidden="true"/>
          </PortalLink>;
        })}
        {setup}
        {/* Shown only while it is the one thing in the list. */}
        {!experiments?.length && <p className="px-study-empty">{detail ?? "No active experiment"}</p>}
      </div>
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
