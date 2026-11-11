import { ArrowRight, ChevronDown } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { loadPortalExperimentCatalog } from "../experimentClient";
import { experimentIsCompleted, orderHomeExperiments } from "../experimentMeasurement";
import type { PortalRoute } from "../portalRoute";
import { PortalLink } from "./PortalLink";
import "./product.css";

export function MachineTile({ name, detail, status, to, extra, traceExtra, healthTo, creation }: {
  name: string;
  detail?: string;
  status?: ReactNode;
  to: PortalRoute;
  extra?: Record<string, string | null>;
  traceExtra?: Record<string, string | null>;
  healthTo: PortalRoute;
  creation: { to: PortalRoute } | { unavailable: string };
}) {
  return <div className="px-system-card">
    <div className="px-system-tile-wrap">
      <PortalLink className="px-system-tile" to={to} extra={{ ...extra, ...traceExtra }} reloadDocument={Boolean(extra?.project)} aria-label={`Open ${name}`}>
        <span className="px-system-tile-name">{name}</span>
        {detail ? <span className="px-system-tile-detail">{detail}</span> : null}
      </PortalLink>
      {"to" in creation ? <PortalLink className="px-system-create" to={creation.to} extra={extra} reloadDocument={Boolean(extra?.project)} aria-label={`New experiment on ${name}`}>
        New experiment
      </PortalLink> : <button type="button" className="px-system-create" disabled title={creation.unavailable} aria-label={`New experiment on ${name} unavailable`}>
        New experiment
      </button>}
    </div>
    <PortalLink className="px-system-health-link" to={healthTo} extra={extra} reloadDocument={Boolean(extra?.project)} aria-label={`${name} system health`}>
      <span>System health</span><span className="px-system-health-status">{status}<ArrowRight size={14} aria-hidden="true" /></span>
    </PortalLink>
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
