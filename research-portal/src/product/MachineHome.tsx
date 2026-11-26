import { useEffect, useState } from "react";
import { DiscoveryTile } from "../RheeDiscovery";
import { FIELD_PROJECT_ID } from "../../../supabase/functions/_shared/installation-field-map.mjs";
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
import { MachineTile, type MachineExperiment } from "./MachineTile";
import "./product.css";

export { MachineHome, MachineTile } from "./MachineTile";

export function ProjectMachineTile({ projectId, name }: { projectId: string; name: string }) {
  const [studies,setStudies]=useState<MachineExperiment[]>([]);
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
    const refresh=()=>loadPortalExperimentCatalog(projectId).then(experiments => {
      if (!active) return;
      const current = orderHomeExperiments(experiments).filter(experiment => !experimentIsCompleted(experiment));
      setStudies(current);setDetail("No active experiment");
    }).catch(() => {
      if (active) setDetail("Experiment unavailable");
    });
    void refresh();
    const stop=scheduleVisiblePolling(refresh,30000);
    return () => { active = false;stop(); };
  }, [projectId]);
  return <MachineTile name={name} detail={detail} experiments={studies} setup={projectId===FIELD_PROJECT_ID && <DiscoveryTile projectId={projectId}/>}
    status={!statusLoaded ? "Checking controller…" : presence.status === "never" ? "Status unavailable" : presence.label}
    statusTone={presence.status === "online" ? "online" : presence.status === "offline" ? "offline" : "unknown"}
    extra={{ project: projectId }}
    to={{view:"controller"}} healthTo={{ view: "health" }} creation={{ to: { view: "new-experiment" } }} />;
}
