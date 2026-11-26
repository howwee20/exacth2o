import { ArrowRight, ChevronDown, Plus } from "lucide-react";
import type { ReactNode } from "react";
import type { PortalRoute } from "../portalRoute";
import { PortalLink } from "./PortalLink";
import "./product.css";

// The home screen's system card and the column the cards sit in. This file imports nothing from the backend, so the
// demo's first screen can show the same cards without loading any data code.
//
// One card is one machine. Its title opens the machine's health, never an experiment, and holds the key that starts
// a new experiment. Under it is one row for each experiment running on the machine.
export type MachineExperiment = {
  id: string;
  name: string;
  to?: PortalRoute;
  extra?: Record<string, string | null>;
  /** Shown beside the name, such as "12 pots". Worked out from pairingNames when left out. */
  meta?: string;
  pairingNames?: readonly string[];
};

export function MachineTile({ name, detail, status, statusTone = "unknown", to, extra, traceExtra, healthTo, creation, onPrepare, experiments, setup }: {
  name: string;
  /** What the card says when nothing is running on the machine. */
  detail?: string;
  experiments?: readonly MachineExperiment[];
  /** A setup in progress on this machine. It takes a row of its own under the experiments. */
  setup?: ReactNode;
  status?: ReactNode;
  statusTone?: "online" | "warning" | "offline" | "unknown";
  to: PortalRoute;
  extra?: Record<string, string | null>;
  traceExtra?: Record<string, string | null>;
  /** Left out where there is no health screen to open, as in the demo. */
  healthTo?: PortalRoute;
  /** Left out where an experiment cannot be started from here. */
  creation?: { to: PortalRoute };
  onPrepare?: () => void;
}) {
  const reload = Boolean(extra?.project);
  const title = <>
    <span className="px-system-tile-name">{name}</span>
    {status ? <span className={`px-system-status is-${statusTone}`}><span className="px-system-status-dot" aria-hidden="true"/>{status}</span> : null}
  </>;
  return <div className="px-machine-tree" role="group" aria-label={name}>
    <div className="px-system-card">
      <div className="px-system-cap">
        {healthTo ? <PortalLink className="px-system-tile px-system-health-link" to={healthTo} extra={extra} reloadDocument={reload}
          aria-label={typeof status === "string" ? `${name} system health, ${status}` : `${name} system health`} title="System health">{title}</PortalLink>
          : <div className="px-system-tile">{title}</div>}
        {creation ? <PortalLink className="px-system-create" to={creation.to} extra={extra} reloadDocument={reload} aria-label={`New experiment on ${name}`}>
          <Plus size={14} aria-hidden="true" /> New experiment
        </PortalLink> : null}
      </div>
      <div className="px-study-list">
        {experiments?.map(study => {
          const meta = study.meta ?? (study.pairingNames?.length ? `${study.pairingNames.length} ${study.pairingNames.length === 1 ? "pot" : "pots"}` : null);
          return <PortalLink key={study.id} className="px-study-row"
            aria-label={study.name}
            to={study.to ?? {view:"experiment",experiment:study.id,tab:"pots",pot:null}}
            extra={{...extra,...study.extra}} reloadDocument={reload}
            onPointerEnter={onPrepare} onFocus={onPrepare}>
            <span className="px-study-text"><strong>{study.name}</strong></span>
            {meta ? <span className="px-study-meta">{meta}</span> : null}
            <ArrowRight size={15} aria-hidden="true"/>
          </PortalLink>;
        })}
        {setup}
        {/* With nothing running, one row opens the machine itself. It is shown only while it is the one thing in the list. */}
        {!experiments?.length && <PortalLink className="px-study-row px-study-empty" to={to} extra={{...extra,...traceExtra}} reloadDocument={reload}
          aria-label={`Open ${name}`} onPointerEnter={onPrepare} onFocus={onPrepare}>
          <span className="px-study-text">{detail ?? "No active experiment"}</span>
          <ArrowRight size={15} aria-hidden="true"/>
        </PortalLink>}
      </div>
    </div>
  </div>;
}

export function MachineHome({ children, tools }: { children: ReactNode; tools?: ReactNode }) {
  return <section className="px-home px-machine-home" aria-label="Your systems">
    <div className="px-system-tile-grid">{children}</div>
    {tools ? <details className="px-tools px-home-administration">
      <summary>Administration <ChevronDown size={15} aria-hidden="true" /></summary>
      <div className="px-admin-tools-body">{tools}</div>
    </details> : null}
  </section>;
}
