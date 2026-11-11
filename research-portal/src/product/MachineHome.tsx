import { ArrowRight, ChevronDown, Plus } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { loadPortalExperimentCatalog } from "../experimentClient";
import { experimentIsCompleted, orderHomeExperiments } from "../experimentMeasurement";
import type { PortalRoute } from "../portalRoute";
import { PortalLink } from "./PortalLink";
import "./product.css";

export function MachineTile({ name, detail, status, statusTone = "unknown", to, extra, traceExtra, healthTo, creation, onPrepare }: {
  name: string;
  detail?: string;
  status?: ReactNode;
  statusTone?: "online" | "warning" | "offline" | "unknown";
  to: PortalRoute;
  extra?: Record<string, string | null>;
  traceExtra?: Record<string, string | null>;
  healthTo: PortalRoute;
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
      <PortalLink className="px-system-health-link" to={healthTo} extra={extra} reloadDocument={Boolean(extra?.project)} aria-label={`${name} system health`}>
        System health <ArrowRight size={13} aria-hidden="true" />
      </PortalLink>
    </div>
  </div>;
}

export function ProjectMachineTile({ projectId, name }: { projectId: string; name: string }) {
  const [detail, setDetail] = useState("Loading experiment…");
  useEffect(() => {
    let active = true;
    void loadPortalExperimentCatalog(projectId).then(experiments => {
      if (!active) return;
      const current = orderHomeExperiments(experiments).find(experiment => !experimentIsCompleted(experiment));
      setDetail(current?.name ?? "No active experiment");
    }).catch(() => {
      if (active) setDetail("Experiment unavailable");
    });
    return () => { active = false; };
  }, [projectId]);
  return <MachineTile name={name} detail={detail} extra={{ project: projectId }}
    to={{ view: "controller" }} healthTo={{ view: "health" }} creation={{ to: { view: "new-experiment" } }} />;
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
