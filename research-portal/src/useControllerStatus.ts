import type * as React from "react";
import { useCallback,useEffect,useRef } from "react";
import { healthSnapshotPollMs,healthSnapshotSelectColumns,incrementalCursorOverlapMs,incrementalValveEventRows,maxValveEventRows,supabaseQueryTimeoutMs,wateringHistoryMs } from "./portalConstants";
import { isIgnoredDiagnosticValveEvent } from "./portalData";
import { errorMessage,selectHealthSnapshot } from "./portalFormat";
import { type DeviceConfigState,type DeviceHealthSnapshot,type DeviceRuntimeState,type ExperimentGraphMode,type PortalView } from "./portalTypes";
import { supabase } from "./supabase";
import { withSupabaseTimeout } from "./supabaseTimeout";
import { type ValveEvent } from "./types";
import { scheduleVisiblePolling } from "./visiblePolling";
import { mergeValveEventRows,valveEventTimestampMs } from "./wateringEvents";



/** ControllerStatus owns this workspace behavior; App supplies the current scope. */
type Context = {
  isAdmin: boolean;
  activeProjectId: string;
  activeDeviceId: string;
  setHealthError: React.Dispatch<React.SetStateAction<string | null>>;
  scopeKeyRef: React.RefObject<string>;
  setHealthHistory: React.Dispatch<React.SetStateAction<DeviceHealthSnapshot[]>>;
  setHealthSnapshot: React.Dispatch<React.SetStateAction<DeviceHealthSnapshot | null>>;
  canUseExperimentSettings: boolean;
  setRuntimeState: React.Dispatch<React.SetStateAction<DeviceRuntimeState | null>>;
  setConfigState: React.Dispatch<React.SetStateAction<DeviceConfigState | null>>;
  canReadProjectData: boolean;
  setValveEvents: React.Dispatch<React.SetStateAction<ValveEvent[]>>;
  valveEventsRef: React.RefObject<ValveEvent[]>;
  valveLoadInFlightRef: React.RefObject<{ promise: Promise<void>; full: boolean; scope: string; } | null>;
  sessionReady: boolean;
  portalView: PortalView;
  experimentGraphMode: ExperimentGraphMode;
};

export function useControllerStatus({ isAdmin, activeProjectId, activeDeviceId, setHealthError, scopeKeyRef, setHealthHistory, setHealthSnapshot, canUseExperimentSettings, setRuntimeState, setConfigState, canReadProjectData, setValveEvents, valveEventsRef, valveLoadInFlightRef, sessionReady, portalView, experimentGraphMode }: Context) {
  const loadHealthSnapshot = useCallback(async (options: { silent?: boolean } = {}) => {
    if (!isAdmin || !activeProjectId || !activeDeviceId) return;
    const silent = options.silent === true;
    if (!silent) {
      setHealthError(null);
    }

    const scope = scopeKeyRef.current;
    try {
      const response = await withSupabaseTimeout(
        supabase
          .from("device_health_snapshots")
          .select(healthSnapshotSelectColumns)
          .eq("project_id", activeProjectId)
          .eq("device_id", activeDeviceId)
          .eq("ingest_complete", true)
          .order("captured_at", { ascending: false })
          .limit(300),
        supabaseQueryTimeoutMs,
        "Health snapshot",
      );

      if (scope !== scopeKeyRef.current) return;
      if (response.error) throw response.error;
      const snapshots = (response.data ?? []) as DeviceHealthSnapshot[];
      setHealthHistory(snapshots);
      setHealthSnapshot(selectHealthSnapshot(snapshots));
    } catch (err) {
      if (scope !== scopeKeyRef.current) return;
      if (!silent) setHealthError(errorMessage(err));
    }
  }, [activeDeviceId, activeProjectId, isAdmin, scopeKeyRef, setHealthError, setHealthHistory, setHealthSnapshot]);

  const loadDeviceSyncState = useCallback(async () => {
    if (!canUseExperimentSettings || !activeProjectId || !activeDeviceId) {
      setRuntimeState(null);
      setConfigState(null);
      return;
    }

    const scope = scopeKeyRef.current;
    try {
      const [runtimeResponse, configResponse] = await Promise.all([
        withSupabaseTimeout(
          supabase
            .from("device_runtime_state")
            .select("*")
            .eq("project_id", activeProjectId)
            .eq("device_id", activeDeviceId)
            .maybeSingle(),
          supabaseQueryTimeoutMs,
          "Runtime state",
        ),
        withSupabaseTimeout(
          supabase
            .from("device_config_state")
            .select("*")
            .eq("project_id", activeProjectId)
            .eq("device_id", activeDeviceId)
            .maybeSingle(),
          supabaseQueryTimeoutMs,
          "Config state",
        ),
      ]);

      if (scope !== scopeKeyRef.current) return;
      if (!runtimeResponse.error) {
        setRuntimeState((runtimeResponse.data ?? null) as DeviceRuntimeState | null);
      }
      if (!configResponse.error) {
        setConfigState((configResponse.data ?? null) as DeviceConfigState | null);
      }
    } catch {
      // Keep the last mirrored controller state visible while Supabase catches up.
    }
  }, [activeDeviceId, activeProjectId, canUseExperimentSettings, scopeKeyRef, setConfigState, setRuntimeState]);

  const loadValveEvents = useCallback((options: { incremental?: boolean; fresh?: boolean } = {}): Promise<void> => {
    if (!canReadProjectData || !activeProjectId || !activeDeviceId) {
      setValveEvents([]);
      return Promise.resolve();
    }
    const scope = scopeKeyRef.current;
    // Incremental only extends a timeline that exists; with nothing loaded (or a failed first load)
    // it would fetch just the newest rows of the whole window and never backfill the rest.
    const incremental = options.incremental === true && valveEventsRef.current.length > 0;
    // Startup, the realtime subscription and tab return can all ask at once; share one request for
    // the same scope. `fresh` asks for a query that starts after any request already running.
    const inFlight = valveLoadInFlightRef.current;
    if (inFlight && inFlight.scope === scope && (inFlight.full || incremental)) {
      return options.fresh ? inFlight.promise.then(() => loadValveEventsRef.current({ incremental: true })) : inFlight.promise;
    }
    const query = async (fromIncremental: boolean) => {
      const existing = valveEventsRef.current;
      const newestExistingAt = existing.reduce(
        (latest, event) => Math.max(latest, valveEventTimestampMs(event)),
        0,
      );
      const sinceMs = fromIncremental && newestExistingAt > 0
        ? newestExistingAt - incrementalCursorOverlapMs
        : Date.now() - wateringHistoryMs;
      const limit = fromIncremental ? incrementalValveEventRows : maxValveEventRows;
      const response = await withSupabaseTimeout(
        supabase
          .from("valve_events")
          .select("*")
          .eq("project_id", activeProjectId)
          .eq("device_id", activeDeviceId)
          .gte("device_recorded_at", new Date(sinceMs).toISOString())
          .order("device_recorded_at", { ascending: false })
          .limit(limit),
        supabaseQueryTimeoutMs,
        "Valve events",
      );
      if (response.error) throw response.error;
      const rows = (response.data ?? []) as ValveEvent[];
      return { rows, filled: rows.length >= limit };
    };
    const promise = (async () => {
      try {
        let result = await query(incremental);
        // A full page of newer rows means the gap may hold more: reload the whole window.
        if (incremental && result.filled && scopeKeyRef.current === scope) result = await query(false);
        if (scopeKeyRef.current !== scope) return;
        setValveEvents((current) => mergeValveEventRows(current, result.rows));
      } catch {
        // Keep the last good watering timeline visible until Supabase recovers.
      }
    })().finally(() => {
      if (valveLoadInFlightRef.current?.promise === promise) valveLoadInFlightRef.current = null;
    });
    valveLoadInFlightRef.current = { promise, full: !incremental, scope };
    return promise;
  }, [activeDeviceId, activeProjectId, canReadProjectData, scopeKeyRef, setValveEvents, valveEventsRef, valveLoadInFlightRef]);

  const loadValveEventsRef = useRef(loadValveEvents);

  useEffect(() => {
    loadValveEventsRef.current = loadValveEvents;
  }, [loadValveEvents]);

  useEffect(() => {
    if (!sessionReady || !isAdmin) return;
    void loadHealthSnapshot();
  }, [isAdmin, loadHealthSnapshot, sessionReady]);

  useEffect(() => {
    if (!sessionReady || !canReadProjectData) return;
    void loadValveEvents();
  }, [
    activeDeviceId,
    activeProjectId,
    canReadProjectData,
    loadValveEvents,
    sessionReady,
  ]);

  useEffect(() => {
    if (
      !sessionReady ||
      !canReadProjectData ||
      portalView !== "experiment" ||
      experimentGraphMode === "vwc"
    ) return;
    void loadValveEvents();
  }, [
    canReadProjectData,
    experimentGraphMode,
    loadValveEvents,
    portalView,
    sessionReady,
  ]);

  useEffect(() => {
    if (!sessionReady || !canUseExperimentSettings) return;
    void loadDeviceSyncState();
  }, [canUseExperimentSettings, loadDeviceSyncState, sessionReady]);

  useEffect(() => {
    if (!sessionReady || !isAdmin) return undefined;
    return scheduleVisiblePolling(() => loadHealthSnapshot({ silent: true }), healthSnapshotPollMs);
  }, [isAdmin, loadHealthSnapshot, sessionReady]);

  useEffect(() => {
    if (!sessionReady || !canReadProjectData || !activeProjectId || !activeDeviceId) return undefined;
    // Realtime inserts carry new events; this poll only backstops a dropped subscription.
    return scheduleVisiblePolling(() => loadValveEvents({ incremental: true }), healthSnapshotPollMs, { catchUpOnVisible: false });
  }, [
    activeDeviceId,
    activeProjectId,
    canReadProjectData,
    loadValveEvents,
    sessionReady,
  ]);

  useEffect(() => {
    if (!sessionReady || !canUseExperimentSettings) return undefined;
    // Controller state gates reviewed settings; it is refreshed immediately on return to the tab.
    return scheduleVisiblePolling(loadDeviceSyncState, healthSnapshotPollMs);
  }, [canUseExperimentSettings, loadDeviceSyncState, sessionReady]);

  useEffect(() => {
    if (!sessionReady || !isAdmin || !activeProjectId || !activeDeviceId) return undefined;

    const channel = supabase
      .channel(`exacth2o-health-live-${activeProjectId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "device_health_snapshots",
          filter: `project_id=eq.${activeProjectId}`,
        },
        (payload) => {
          const row = payload.new as Partial<DeviceHealthSnapshot>;
          if (row.device_id !== activeDeviceId || row.ingest_complete !== true) return;
          setHealthHistory((current) => {
            const next = row as DeviceHealthSnapshot;
            const byId = new Map(current.map((item) => [item.id, item]));
            byId.set(next.id, next);
            return Array.from(byId.values())
              .sort((left, right) => Date.parse(right.captured_at) - Date.parse(left.captured_at))
              .slice(0, 300);
          });
          setHealthSnapshot((current) => selectHealthSnapshot([
            row as DeviceHealthSnapshot,
            ...(current ? [current] : []),
          ]));
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [activeDeviceId, activeProjectId, isAdmin, loadHealthSnapshot, sessionReady, setHealthHistory, setHealthSnapshot]);

  useEffect(() => {
    if (!sessionReady || !canUseExperimentSettings || !activeProjectId || !activeDeviceId) return undefined;

    const channel = supabase
      .channel(`exacth2o-device-sync-live-${activeProjectId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "device_runtime_state",
          filter: `project_id=eq.${activeProjectId}`,
        },
        (payload) => {
          const row = payload.new as Partial<DeviceRuntimeState>;
          if (row.device_id === activeDeviceId) {
            setRuntimeState(row as DeviceRuntimeState);
            return;
          }
          void loadDeviceSyncState();
        },
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "device_config_state",
          filter: `project_id=eq.${activeProjectId}`,
        },
        (payload) => {
          const row = payload.new as Partial<DeviceConfigState>;
          if (row.device_id === activeDeviceId) {
            setConfigState(row as DeviceConfigState);
            return;
          }
          void loadDeviceSyncState();
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [activeDeviceId, activeProjectId, canUseExperimentSettings, loadDeviceSyncState, sessionReady, setConfigState, setRuntimeState]);

  useEffect(() => {
    if (!sessionReady || !canReadProjectData || !activeProjectId || !activeDeviceId) return undefined;

    const channel = supabase
      .channel(`exacth2o-valve-events-live-${activeProjectId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "valve_events",
          filter: `project_id=eq.${activeProjectId}`,
        },
        (payload) => {
          const row = payload.new as ValveEvent;
          if (row.device_id !== activeDeviceId || isIgnoredDiagnosticValveEvent(row)) return;
          setValveEvents((current) => mergeValveEventRows(current, [row]));
        },
      )
      .subscribe((status) => {
        // Catch rows written between the initial load and the subscription becoming active.
        // A query already running may have started before the subscription went live, so this
        // one must start after it.
        if (status === "SUBSCRIBED") void loadValveEvents({ incremental: true, fresh: true });
      });

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [activeDeviceId, activeProjectId, canReadProjectData, loadValveEvents, sessionReady, setValveEvents]);

  return { loadDeviceSyncState, loadValveEvents };
}
