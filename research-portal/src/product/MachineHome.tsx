import { ArrowRight, ChevronDown, Plus } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { supabase } from "../supabase";
import { withSupabaseTimeout } from "../supabaseTimeout";
import { supabaseQueryTimeoutMs } from "../portalConstants";
import { scheduleVisiblePolling } from "../visiblePolling";
import { usePageClock } from "../pageClock";
import { controllerPresence } from "../settingsPresentation";
import { selectProjectDevice } from "../portalProjectContext";
import type { DeviceRuntimeState } from "../portalTypes";
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
  const [runtime, setRuntime] = useState<DeviceRuntimeState | null>(null);
  const [statusLoaded, setStatusLoaded] = useState(false);
  const nowMs = usePageClock();
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const [configs, states] = await Promise.all([
          withSupabaseTimeout(supabase.from('device_config_state').select('device_id,updated_at')
            .eq('project_id',projectId).order('updated_at',{ascending:false}).limit(1), supabaseQueryTimeoutMs, 'System device'),
          withSupabaseTimeout(supabase.from('device_runtime_state').select('project_id,device_id,state_observed_at,state_fresh_until,controller_state,pi_online')
            .eq('project_id',projectId), supabaseQueryTimeoutMs, 'System status'),
        ]);
        if (configs.error) throw configs.error;
        if (states.error) throw states.error;
        if (active) {
          const deviceId = selectProjectDevice(configs.data ?? []);
          setRuntime(((states.data ?? []).find(row => row.device_id === deviceId) ?? null) as DeviceRuntimeState | null);
          setStatusLoaded(true);
        }
      } catch { if (active) setStatusLoaded(true); }
    };
    void load();
    const stop = scheduleVisiblePolling(load, 60_000);
    const channel = supabase.channel(`system-tile-${projectId}`)
      .on('postgres_changes', {event:'*',schema:'public',table:'device_runtime_state',filter:`project_id=eq.${projectId}`}, () => { void load(); })
      .subscribe(status => { if (status === 'SUBSCRIBED') void load(); });
    return () => { active = false; stop(); void supabase.removeChannel(channel); };
  }, [projectId]);
  const presence = controllerPresence({stateFreshUntil:runtime?.state_fresh_until,
    stateObservedAt:runtime?.state_observed_at,controllerState:runtime?.controller_state,piOnline:runtime?.pi_online},nowMs);
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
  return <MachineTile name={name} detail={detail}
    status={!statusLoaded ? "Checking controller…" : presence.status === "never" ? "Status unavailable" : presence.label}
    statusTone={presence.status === "online" ? "online" : presence.status === "offline" ? "offline" : "unknown"}
    extra={{ project: projectId }}
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
