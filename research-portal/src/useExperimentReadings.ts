import { useCallback, useEffect, useState } from "react";
import { loadExportExperiment, loadExportReadings } from "./experimentExportClient";
import type { PortalExperiment } from "./experimentRegistry";
import type { SensorReading, ValveEvent } from "./types";
import { loadExperimentValveEvents } from "./experimentValveHistory";

type Result = { key: string; readings: SensorReading[]; valveEvents: ValveEvent[]; loading: boolean; progress: number; error: string | null };
const emptyReadings: SensorReading[] = [];
const emptyValveEvents: ValveEvent[] = [];

/** Fetch the archive once per experiment/revision; live polling stays small and independent. */
export function useExperimentReadings(experiment: PortalExperiment, projectId: string, deviceId: string, enabled: boolean) {
  const key = JSON.stringify([projectId, deviceId, experiment.id, experiment.currentRevisionId, experiment.startedAt, experiment.endedAt]);
  const [result, setResult] = useState<Result | null>(null);
  const [revision, setRevision] = useState(0);
  const retry = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    if (!enabled || !projectId || !deviceId) return;
    const controller = new AbortController();
    let active = true;
    setResult({ key, readings: [], valveEvents: [], loading: true, progress: 0, error: null });
    void (async () => {
      const scope = await loadExportExperiment(experiment);
      if (!active) return;
      const query = {
        projectId, deviceId, pairingNames: scope.pairingNames,
        startMs: experiment.startedAt ? Date.parse(experiment.startedAt) : null,
        endMs: experiment.endedAt ? Date.parse(experiment.endedAt) : Date.now(),
        signal: controller.signal,
      };
      const [{ readings }, valveEvents] = await Promise.all([loadExportReadings({ ...query,
        onProgress: (progress) => { if (active) setResult((old) => old && { ...old, progress }); },
      }), loadExperimentValveEvents(query)]);
      if (active) setResult({ key, readings, valveEvents, loading: false, progress: readings.length, error: null });
    })().catch((failure: unknown) => {
      if (active) setResult({ key, readings: [], valveEvents: [], loading: false, progress: 0, error: failure instanceof Error ? failure.message : "Could not load experiment readings." });
    });
    return () => { active = false; controller.abort(); };
  }, [deviceId, enabled, experiment, key, projectId, revision]);
  const current = result?.key === key && enabled ? result : null;
  return { readings: current?.readings ?? emptyReadings, valveEvents: current?.valveEvents ?? emptyValveEvents, loading: current?.loading ?? enabled, progress: current?.progress ?? 0, error: current?.error ?? null, retry };
}
