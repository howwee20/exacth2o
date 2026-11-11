import { ArrowRight, ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import type { PortalRoute } from "../portalRoute";
import { PortalLink } from "./PortalLink";
import "./product.css";

export function MachineTile({ name, description, detail, status, to, extra, healthTo, calibration, actionLabel = "Open traces" }: {
  name: string;
  description: string;
  detail?: string;
  status?: ReactNode;
  to: PortalRoute;
  extra?: Record<string, string | null>;
  healthTo: PortalRoute;
  calibration: { to: PortalRoute } | { unavailable: string };
  actionLabel?: string;
}) {
  return <div className="px-system-card">
    <div className="px-system-tile-wrap">
    <PortalLink className="px-system-tile" to={to} extra={extra} reloadDocument={Boolean(extra?.project)}>
    <span className="px-system-tile-name">{name}</span>
    <span className="px-system-tile-description">{description}</span>
    {detail ? <span className="px-system-tile-detail">{detail}</span> : null}
    <span className="px-system-tile-open">{actionLabel} <ArrowRight size={16} aria-hidden="true" /></span>
    </PortalLink>
    {"to" in calibration ? <PortalLink className="px-system-calibrate" to={calibration.to} extra={extra} reloadDocument={Boolean(extra?.project)} aria-label={`${name} Autocalibrate`}>
      Autocalibrate
    </PortalLink> : <button type="button" className="px-system-calibrate" disabled title={calibration.unavailable} aria-label={`${name} Autocalibrate unavailable`}>
      Autocalibrate
    </button>}
    </div>
    <PortalLink className="px-system-health-link" to={healthTo} extra={extra} reloadDocument={Boolean(extra?.project)} aria-label={`${name} system health`}>
      <span>System health</span><span className="px-system-health-status">{status}<ArrowRight size={14} aria-hidden="true" /></span>
    </PortalLink>
  </div>;
}

export function MachineHome({ children, tools }: { children: ReactNode; tools?: ReactNode }) {
  return <section className="px-home px-machine-home" aria-label="Your systems">
    <h1 className="px-title">Systems</h1>
    <div className="px-system-tile-grid">{children}</div>
    {tools ? <details className="px-tools px-home-administration">
      <summary>Administration <ChevronDown size={18} aria-hidden="true" /></summary>
      <div className="px-admin-tools-body">{tools}</div>
    </details> : null}
  </section>;
}
