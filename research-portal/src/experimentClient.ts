import { supabase } from "./supabase";
import type {
  ExperimentDraft,
  ExperimentDraftResponse,
  ExperimentDraftSource,
  ExperimentLaunchResponse,
  ExperimentPreflightResponse,
} from "./experimentSpec";
import type {
  PortalExperiment,
  PortalExperimentAssignment,
} from "./experimentRegistry";

type CatalogRow = {
  id: string;
  current_revision_id: string | null;
  current_version: number | null;
  current_spec: ExperimentDraft | null;
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

export type ExperimentArchivePreflight = {
  experiment_id: string;
  experiment_slug: string;
  experiment_name: string;
  mode: PortalExperiment["mode"];
  status: PortalExperiment["status"];
  watering_state: PortalExperiment["wateringState"];
  history_preserved: true;
  review_token: string;
  can_archive: boolean;
  reason: string;
};

export type ExperimentArchiveResponse = {
  experiment_id: string;
  experiment_slug: string;
  experiment_name: string;
  status: "archived";
  history_preserved: true;
};

export class ExperimentRequestError extends Error {
  constructor(message: string, readonly savedExperimentSlug?: string) { super(message); this.name = "ExperimentRequestError"; }
}

async function invokeExperimentBuilder<T>(body: Record<string, unknown>) {
  const { data, error } = await supabase.functions.invoke<T>("experiment-builder", { body });
  if (error) {
    const context = error.context as Response | undefined;
    if (context) {
      const payload = await context.clone().json().catch(() => null) as {
        error?: string;
        validation_messages?: string[];
        experiment_slug?: string;
      } | null;
      if (payload?.validation_messages?.length) {
        throw new Error(payload.validation_messages.join(" "));
      }
      if (payload?.error) throw new ExperimentRequestError(payload.error, payload.experiment_slug);
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
      "id,current_revision_id,current_version,current_spec,slug,name,description,mode,status,watering_state,started_at,ended_at,pairing_names,assignments",
    )
    .eq("project_id", projectId)
    .order("created_at", { ascending: true });
  if (error) throw error;

  return ((data ?? []) as CatalogRow[]).map<PortalExperiment>((row) => ({
    id: row.slug,
    databaseId: row.id,
    currentRevisionId: row.current_revision_id ?? undefined,
    currentVersion: row.current_version ?? undefined,
    currentSpec: row.current_spec ?? undefined,
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

export function draftExperiment(
  projectId: string,
  prompt: string,
  currentDraft?: ExperimentDraft,
) {
  return invokeExperimentBuilder<ExperimentDraftResponse>({
    action: currentDraft ? "revise" : "draft",
    project_id: projectId,
    prompt,
    current_draft: currentDraft,
  });
}

export function preflightExperimentArchive(
  projectId: string,
  experiment: string,
) {
  return invokeExperimentBuilder<ExperimentArchivePreflight>({
    action: "archive_preflight",
    project_id: projectId,
    experiment,
  });
}

export function archiveExperiment({
  projectId,
  experiment,
  experimentId,
  reviewToken,
}: {
  projectId: string;
  experiment: string;
  experimentId: string;
  reviewToken: string;
}) {
  return invokeExperimentBuilder<ExperimentArchiveResponse>({
    action: "archive",
    project_id: projectId,
    experiment,
    experiment_id: experimentId,
    review_token: reviewToken,
    confirm: true,
  });
}

export function preflightExperiment({
  projectId,
  draft,
  inventoryUpdatedAt,
  experimentId,
  expectedRevisionId,
}: {
  projectId: string;
  draft: ExperimentDraft;
  inventoryUpdatedAt: string;
  experimentId?: string;
  expectedRevisionId?: string;
}) {
  return invokeExperimentBuilder<ExperimentPreflightResponse>({
    action: experimentId ? "edit_preflight" : "preflight",
    project_id: projectId,
    draft,
    inventory_updated_at: inventoryUpdatedAt,
    experiment_id: experimentId,
    expected_revision_id: expectedRevisionId,
  });
}

export function launchExperiment({
  projectId,
  draft,
  inventoryUpdatedAt,
  source,
  model,
  promptFingerprint,
  reviewedConfigHash,
  experimentId,
  expectedRevisionId,
}: {
  projectId: string;
  draft: ExperimentDraft;
  inventoryUpdatedAt: string;
  source: ExperimentDraftSource;
  model: string | null;
  promptFingerprint: string | null;
  reviewedConfigHash: string;
  experimentId?: string;
  expectedRevisionId?: string;
}) {
  return invokeExperimentBuilder<ExperimentLaunchResponse>({
    action: experimentId ? "edit_apply" : "launch",
    project_id: projectId,
    draft,
    inventory_updated_at: inventoryUpdatedAt,
    source,
    model,
    prompt_fingerprint: promptFingerprint,
    reviewed_config_hash: reviewedConfigHash,
    experiment_id: experimentId,
    expected_revision_id: expectedRevisionId,
    confirm: true,
  });
}
