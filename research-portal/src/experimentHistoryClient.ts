import type { PortalExperiment } from "./experimentRegistry";
import { experimentHistoryAliases } from "./experimentHistory";
import { readRecordPages } from "./recordClient";
import { supabase } from "./supabase";
import { emptyStats, loadReadingBuckets } from "./workbenchClient";

export async function loadExperimentHistory({experiment,projectId,deviceId,startMs,endMs,bucketMs}: {
 experiment:PortalExperiment;projectId:string;deviceId:string;startMs:number;endMs:number;bucketMs:number;
}) {
      const historical = experiment.databaseId ? await readRecordPages<{pairing_name: string; sensor_key_snapshot: string | null}>(async (from,to) => {
        const result = await supabase.from("experiment_assignments").select("pairing_name,sensor_key_snapshot").eq("experiment_id",experiment.databaseId).order("revision_id").order("pairing_name").range(from,to);
        if (result.error) throw result.error;
        return result.data ?? [];
      }, 20000) : [];
      const aliases = experimentHistoryAliases(experiment.pairingNames, experiment.assignments ?? [], historical);
      const stats = emptyStats();
      const result = await loadReadingBuckets({projectId,deviceId,pairingNames:[...aliases.keys()],window:{queryStartMs:startMs,endMs:endMs,bucketMs},exclusions:[]},stats);
      if (stats.failed) throw new Error("Some history could not be loaded. Retry to view a complete chart.");

  return {result,aliases};
}
