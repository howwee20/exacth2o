import { supabase } from "./supabase";
import type {
  ExperimentDraft,
  ExperimentDraftResponse,
  ExperimentDraftSource,
} from "./experimentSpec";
import type {
  PortalExperiment,
  PortalExperimentAssignment,
} from "./experimentRegistry";

type CatalogRow = {
  id: string;
  slug: string;
  name: string;
  description: string;
  mode: PortalExperiment["mode"];
  status: PortalExperiment["status"];
  watering_state: PortalExperiment["wateringState"];
  started_at: string | null;
  ended_at: string | null;
  pairing_names: string[] | null;
  assignments: PortalExperimentAssignment[] | null;
};

type PublishResponse = {
  experiment_id: string;
  experiment_slug: string;
};

async function invokeExperimentBuilder<T>(body: Record<string, unknown>) {
  const { data, error } = await supabase.functions.invoke<T>("experiment-builder", { body });
  if (error) {
    const context = error.context as Response | undefined;
    if (context) {
      const payload = await context.clone().json().catch(() => null) as {
        error?: string;
        validation_messages?: string[];
      } | null;
      if (payload?.validation_messages?.length) {
        throw new Error(payload.validation_messages.join(" "));
      }
      if (payload?.error) throw new Error(payload.error);
    }
    throw error;
  }
  if (!data) throw new Error("Experiment builder returned no data.");
  return data;
}

export async function loadPortalExperimentCatalog(projectId: string) {
  const { data, error } = await supabase
    .from("portal_experiment_catalog")
    .select(
      "id,slug,name,description,mode,status,watering_state,started_at,ended_at,pairing_names,assignments",
    )
    .eq("project_id", projectId)
    .order("created_at", { ascending: true });
  if (error) throw error;

  return ((data ?? []) as CatalogRow[]).map<PortalExperiment>((row) => ({
    id: row.slug,
    databaseId: row.id,
    name: row.name,
    shortDescription: row.description,
    mode: row.mode,
    status: row.status,
    wateringState: row.watering_state,
    groupNames: [],
    pairingNames: row.pairing_names ?? [],
    assignments: row.assignments ?? [],
    startedAt: row.started_at ?? undefined,
    endedAt: row.ended_at ?? undefined,
  }));
}

export function draftExperiment(projectId: string, prompt: string) {
  return invokeExperimentBuilder<ExperimentDraftResponse>({
    action: "draft",
    project_id: projectId,
    prompt,
  });
}

export function publishExperiment({
  projectId,
  draft,
  inventoryUpdatedAt,
  source,
  model,
  promptFingerprint,
}: {
  projectId: string;
  draft: ExperimentDraft;
  inventoryUpdatedAt: string;
  source: ExperimentDraftSource;
  model: string | null;
  promptFingerprint: string | null;
}) {
  return invokeExperimentBuilder<PublishResponse>({
    action: "publish",
    project_id: projectId,
    draft,
    inventory_updated_at: inventoryUpdatedAt,
    source,
    model,
    prompt_fingerprint: promptFingerprint,
  });
}
