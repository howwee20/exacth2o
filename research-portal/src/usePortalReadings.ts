import type * as React from "react";
import { useCallback,useEffect,useRef } from "react";
import {
isSessionAuthorizationError
} from "./authSession";
import { autoRefreshMs,fullReconciliationEveryPolls,incrementalCursorOverlapMs,livePrefix,supabaseQueryTimeoutMs } from "./portalConstants";
import { type DataMode,type EffectiveMode,isIgnoredDiagnosticReading,mergeRollingExperimentReadings,pairingsFromDeviceConfigState,resolveEffectiveMode,visibleExperimentPairings } from "./portalData";
import { errorMessage } from "./portalFormat";
import { fetchReadingsForMode,incrementalReadingCursor,loadedReadingCounts,newestByTime } from "./portalReadings";
import { type DeviceConfigState,type LoadState,type RefreshOptions } from "./portalTypes";
import { supabase } from "./supabase";
import { withSupabaseTimeout } from "./supabaseTimeout";
import { type LatestState,type PairingRow,type SensorReading } from "./types";
import { scheduleVisiblePolling } from "./visiblePolling";

const realtimeBatchMs = 400;

function readingsState(
  current: LoadState,
  readings: SensorReading[],
  incoming: SensorReading[],
  nowIso: string,
  effectiveMode: EffectiveMode,
): LoadState {
  const known = current.readings.length ? new Set(current.readings.map((reading) => reading.event_id || String(reading.id))) : null;
  const hasNew = incoming.some((reading) => !known || !known.has(reading.event_id || String(reading.id)));
  const loadedCounts = loadedReadingCounts(readings);
  const latestLiveReading = newestByTime(
    readings.filter((reading) => reading.event_id.startsWith("live-device:")),
  );
  return {
    ...current,
    readings,
    totalImportedReadings: loadedCounts.imported,
    totalLiveReadings: loadedCounts.live,
    latestLiveReading: latestLiveReading ?? current.latestLiveReading,
    lastCheckedAt: nowIso,
    lastNewDataAt: hasNew ? nowIso : current.lastNewDataAt,
    effectiveMode,
  };
}

/** PortalReadings owns this workspace behavior; App supplies the current scope. */
type Context = {
  activeProjectId: string;
  activeDeviceId: string;
  scopeKeyRef: React.RefObject<string>;
  loadTokenRef: React.RefObject<number>;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
  setLoading: React.Dispatch<React.SetStateAction<boolean>>;
  dataRef: React.RefObject<LoadState>;
  selectedMode: DataMode;
  recoverPortalSession: () => Promise<boolean>;
  setConfigState: React.Dispatch<React.SetStateAction<DeviceConfigState | null>>;
  setData: React.Dispatch<React.SetStateAction<LoadState>>;
  setLastSuccessfulCheckAt: React.Dispatch<React.SetStateAction<number | null>>;
  setRefreshFailedAt: React.Dispatch<React.SetStateAction<number | null>>;
  expirePortalSession: () => void;
  realtimeRefreshInFlightRef: React.RefObject<boolean>;
  refreshInFlightRef: React.RefObject<boolean>;
  pendingRefreshRef: React.RefObject<RefreshOptions | null>;
  sessionReady: boolean;
  canReadProjectData: boolean;
  watchdogRefreshCountRef: React.RefObject<number>;
};

export function usePortalReadings({ activeProjectId, activeDeviceId, scopeKeyRef, loadTokenRef, setError, setLoading, dataRef, selectedMode, recoverPortalSession, setConfigState, setData, setLastSuccessfulCheckAt, setRefreshFailedAt, expirePortalSession, realtimeRefreshInFlightRef, refreshInFlightRef, pendingRefreshRef, sessionReady, canReadProjectData, watchdogRefreshCountRef }: Context) {
  const runPortalRefresh = useCallback(
    async ({ incremental }: RefreshOptions) => {
      if (!activeProjectId || !activeDeviceId) return;
      const scope = scopeKeyRef.current;
      const token = loadTokenRef.current + 1;
      loadTokenRef.current = token;
      setError(null);
      setLoading(!incremental || dataRef.current.readings.length === 0);
      try {
        const loadCoreData = async () => {
          const results = await Promise.all([
            withSupabaseTimeout(
              supabase
                .from("device_config_state")
                .select("*")
                .eq("project_id", activeProjectId)
                .eq("device_id", activeDeviceId)
                .maybeSingle(),
              supabaseQueryTimeoutMs,
              "Controller config",
            ),
            withSupabaseTimeout(
              supabase
                .from("latest_device_state")
                .select("*")
                .eq("device_id", activeDeviceId)
                .limit(1)
                .maybeSingle(),
              supabaseQueryTimeoutMs,
              "Latest device state",
            ),
            selectedMode === "auto"
              ? withSupabaseTimeout(
                supabase
                  .from("sensor_readings")
                  .select("id, server_received_at")
                  .eq("project_id", activeProjectId)
                  .eq("device_id", activeDeviceId)
                  .like("event_id", livePrefix)

                  .limit(1),
                supabaseQueryTimeoutMs,
                "Live reading availability",
              )
              : Promise.resolve({ data: null, error: null }),
          ]);

          for (const result of results) {
            if (result.error) throw result.error;
          }
          return results;
        };

        let coreData;
        try {
          coreData = await loadCoreData();
        } catch (err) {
          if (!isSessionAuthorizationError(err) || !(await recoverPortalSession())) throw err;
          coreData = await loadCoreData();
        }
        const [controllerConfig, latestState, liveAvailability] = coreData;

        const previous = dataRef.current;
        const effectiveMode = resolveEffectiveMode(selectedMode, Boolean(liveAvailability.data?.length));
        const canIncrement = incremental && previous.effectiveMode === effectiveMode;
        const newerThan = canIncrement ? incrementalReadingCursor(previous.readings) : null;
        const nowIso = new Date().toISOString();
        const latestIngestTime =
          latestState.data?.updated_at ??
          previous.latestIngestTime ??
          null;

        if (token !== loadTokenRef.current || scope !== scopeKeyRef.current) return;
        const startedAtMs = Date.now();

        let pairingsData = pairingsFromDeviceConfigState(
          controllerConfig.data?.pairings,
          controllerConfig.data?.groups,
        );
        if (pairingsData.length === 0) {
          const legacyPairings = await withSupabaseTimeout(
            supabase
              .from("pairings")
              .select("*")
              .eq("project_id", activeProjectId)
              .eq("device_id", activeDeviceId)
              .limit(1000),
            supabaseQueryTimeoutMs,
            "Legacy pairings",
          );
          if (legacyPairings.error) throw legacyPairings.error;
          if (token !== loadTokenRef.current || scope !== scopeKeyRef.current) return;
          pairingsData = (legacyPairings.data ?? []) as PairingRow[];
        }
        pairingsData = visibleExperimentPairings(pairingsData);

        if (controllerConfig.data) {
          setConfigState(controllerConfig.data as DeviceConfigState);
        }

        // A full reconciliation of data already on screen is assembled off-screen and swapped
        // in once complete, so the chart never empties and refills. Only a first load (or a
        // switch between live and imported data) streams batches in as they arrive.
        const reconcileInPlace = !canIncrement && previous.readings.length > 0;
        setData((current) => ({
          ...current,
          pairings: pairingsData,
          latestState: latestState.data ?? null,
          latestIngestTime,
          lastCheckedAt: nowIso,
          effectiveMode,
          readings: current.readings,
          totalImportedReadings: current.totalImportedReadings,
          totalLiveReadings: current.totalLiveReadings,
        }));

        const applyReadingsBatch = (incomingReadings: SensorReading[]) => {
          if (token !== loadTokenRef.current || scope !== scopeKeyRef.current || incomingReadings.length === 0) return;
          setData((current) => readingsState(current, mergeRollingExperimentReadings(current.readings, incomingReadings), incomingReadings, nowIso, effectiveMode));
        };

        const fetched = await fetchReadingsForMode(
          activeProjectId,
          activeDeviceId,
          effectiveMode,
          newerThan,
          reconcileInPlace ? undefined : applyReadingsBatch,
        );
        if (reconcileInPlace && token === loadTokenRef.current && scope === scopeKeyRef.current) {
          setData((current) => {
            // Keep realtime rows that arrived while the reconciliation was running.
            const arrivedDuring = current.readings.filter((reading) =>
              Date.parse(reading.server_received_at) >= startedAtMs - incrementalCursorOverlapMs);
            if (selectedMode === "auto" && fetched.length === 0) return {...current, effectiveMode: previous.effectiveMode};
            const reconciled = mergeRollingExperimentReadings(fetched, arrivedDuring);
            return readingsState(current, reconciled, fetched, nowIso, effectiveMode);
          });
        }
        if (token === loadTokenRef.current && scope === scopeKeyRef.current) {
          // Only a completed check may make the home quiet; a failed one is stated, with the
          // time of the last good data.
          setLastSuccessfulCheckAt(Date.now());
          setRefreshFailedAt(null);
        }
      } catch (err) {
        if (token === loadTokenRef.current && scope === scopeKeyRef.current) {
          if (isSessionAuthorizationError(err)) {
            expirePortalSession();
            return;
          }
          setError(errorMessage(err));
          setRefreshFailedAt(Date.now());
        }
      } finally {
        if (token === loadTokenRef.current && scope === scopeKeyRef.current) {
          setLoading(false);
        }
      }
    },
    [activeDeviceId, activeProjectId, dataRef, expirePortalSession, loadTokenRef, recoverPortalSession, scopeKeyRef, selectedMode, setConfigState, setData, setError, setLastSuccessfulCheckAt, setLoading, setRefreshFailedAt],
  );

  const refreshLatestReadings = useCallback(async () => {
    if (realtimeRefreshInFlightRef.current || !activeProjectId || !activeDeviceId) return;
    const currentData = dataRef.current;
    const newerThan = incrementalReadingCursor(currentData.readings);
    if (!newerThan) return;

    realtimeRefreshInFlightRef.current = true;
    const scope = scopeKeyRef.current;
    try {
      const effectiveMode = currentData.effectiveMode;
      const incomingReadings = await fetchReadingsForMode(
        activeProjectId,
        activeDeviceId,
        effectiveMode,
        newerThan,
      );
      const nowIso = new Date().toISOString();

      if (scopeKeyRef.current !== scope) return;
      setData((current) => {
        if (!incomingReadings.length) {
          return {
            ...current,
            lastCheckedAt: nowIso,
          };
        }
        const next = readingsState(current, mergeRollingExperimentReadings(current.readings, incomingReadings), incomingReadings, nowIso, current.effectiveMode);
        return {
          ...next,
          latestIngestTime:
            next.latestLiveReading?.server_received_at ??
            current.latestState?.updated_at ??
            current.latestIngestTime,
        };
      });
    } catch {
      // Keep the visible chart stable and retry on the next realtime/poll tick.
    } finally {
      realtimeRefreshInFlightRef.current = false;
    }
  }, [activeDeviceId, activeProjectId, dataRef, realtimeRefreshInFlightRef, scopeKeyRef, setData]);

  const runPortalRefreshRef = useRef(runPortalRefresh);

  const refresh = useCallback(
    async (options: RefreshOptions) => {
      if (refreshInFlightRef.current) {
        if (options.incremental) {
          void refreshLatestReadings();
          return;
        }
        const pending = pendingRefreshRef.current;
        pendingRefreshRef.current = {
          incremental: pending ? pending.incremental && options.incremental : options.incremental,
        };
        return;
      }

      refreshInFlightRef.current = true;
      let nextOptions: RefreshOptions | null = options;

      try {
        while (nextOptions) {
          const currentOptions = nextOptions;
          nextOptions = null;
          await runPortalRefreshRef.current(currentOptions);
          nextOptions = pendingRefreshRef.current;
          pendingRefreshRef.current = null;
        }
      } finally {
        refreshInFlightRef.current = false;
      }
    },
    [pendingRefreshRef, refreshInFlightRef, refreshLatestReadings],
  );

  useEffect(() => {
    if (!sessionReady || !canReadProjectData) return undefined;
    // Visible-tab watchdog alongside realtime; the return-to-tab handler reconciles after hidden time.
    return scheduleVisiblePolling(() => {
      watchdogRefreshCountRef.current += 1;
      const fullReconciliation =
        watchdogRefreshCountRef.current % fullReconciliationEveryPolls === 0;
      return refresh({ incremental: !fullReconciliation });
    }, autoRefreshMs, { catchUpOnVisible: false });
  }, [canReadProjectData, refresh, sessionReady, watchdogRefreshCountRef]);

  useEffect(() => {
    if (!sessionReady || !canReadProjectData) return undefined;

    const shouldApplyReading = (reading: Partial<SensorReading> | null | undefined) => {
      if (!reading || isIgnoredDiagnosticReading(reading)) return false;
      const eventId = reading.event_id;
      if (typeof eventId !== "string") return false;
      if (selectedMode === "combined" || selectedMode === "auto") return true;
      if (selectedMode === "live") return eventId.startsWith("live-device:");
      return eventId.startsWith("balena-export-v2:");
    };

    // A controller reports every pot at once; apply each burst as one merge and one redraw.
    let pendingRows: Array<SensorReading & { device_id?: string }> = [];
    let flushTimer: number | null = null;
    const scope = scopeKeyRef.current;
    const flushRows = () => {
      flushTimer = null;
      const rows = pendingRows;
      pendingRows = [];
      if (!rows.length || scopeKeyRef.current !== scope) return;
      const nowIso = new Date().toISOString();
      const switchingToLive =
        selectedMode === "auto" &&
        rows.some((row) => row.event_id.startsWith("live-device:")) &&
        dataRef.current.effectiveMode !== "live";
      setData((current) => {
        const hasLive = rows.some((row) => row.event_id.startsWith("live-device:"));
        const accepted = selectedMode === "auto" && current.effectiveMode === "live"
          ? rows.filter((row) => row.event_id.startsWith("live-device:"))
          : rows;
        if (!accepted.length) return current;
        const effectiveMode = selectedMode === "auto" && hasLive ? "live" : current.effectiveMode;
        const next = readingsState(current, mergeRollingExperimentReadings(current.readings, accepted), accepted, nowIso, effectiveMode);
        const newestReceived = accepted.reduce<string | null>(
          (latest, row) => (row.server_received_at && (!latest || row.server_received_at > latest) ? row.server_received_at : latest),
          null,
        );
        return {
          ...next,
          latestIngestTime: newestReceived ?? current.latestIngestTime,
        };
      });
      if (switchingToLive) void refresh({ incremental: false });
    };

    const channel = supabase
      .channel(`exacth2o-dashboard-live-${activeProjectId}-${selectedMode}-${crypto.randomUUID()}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "sensor_readings",
          filter: `project_id=eq.${activeProjectId}`,
        },
        (payload) => {
          const row = payload.new as SensorReading & { device_id?: string };
          if (row.device_id !== activeDeviceId || !shouldApplyReading(row)) return;
          pendingRows.push(row);
          flushTimer ??= window.setTimeout(flushRows, realtimeBatchMs);
        },
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "latest_device_state",
          filter: `device_id=eq.${activeDeviceId}`,
        },
        (payload) => {
          const row = payload.new as LatestState;
          if (row.device_id !== activeDeviceId) return;
          setData((current) => ({
            ...current,
            latestState: row,
            latestIngestTime: row.updated_at ?? current.latestIngestTime,
            lastCheckedAt: new Date().toISOString(),
          }));
        },
      )
      .subscribe();

    return () => {
      if (flushTimer != null) window.clearTimeout(flushTimer);
      pendingRows = [];
      void supabase.removeChannel(channel);
    };
  }, [activeDeviceId, activeProjectId, canReadProjectData, refresh, sessionReady, selectedMode, scopeKeyRef, dataRef, setData]);

  return { runPortalRefresh, runPortalRefreshRef, refresh };
}
