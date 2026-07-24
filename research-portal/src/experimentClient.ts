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
import type {
  SettingsDraftResponse,
  SettingsPlan,
} from "./settingsSpec";

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

export type AssistantRouteResponse = {
  intent: "experiment" | "settings";
  reason: string;
  model: string | null;
  prompt_fingerprint: string | null;
};

export type AssistantConversationMessage = {
  role: "user" | "assistant";
  content: string;
};

export type AssistantChatResponse = {
  reply: string;
  workflow: "answer" | "experiment" | "settings" | "archive";
  workflow_prompt: string | null;
  model: string | null;
  prompt_fingerprint: string | null;
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

export function routeAssistantRequest(projectId: string, prompt: string) {
  return invokeExperimentBuilder<AssistantRouteResponse>({
    action: "route",
    project_id: projectId,
    prompt,
  });
}

export function chatWithAssistant(
  projectId: string,
  prompt: string,
  conversation: AssistantConversationMessage[],
) {
  return invokeExperimentBuilder<AssistantChatResponse>({
    action: "assistant_chat",
    project_id: projectId,
    prompt,
    conversation,
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
}: {
  projectId: string;
  draft: ExperimentDraft;
  inventoryUpdatedAt: string;
}) {
  return invokeExperimentBuilder<ExperimentPreflightResponse>({
    action: "preflight",
    project_id: projectId,
    draft,
    inventory_updated_at: inventoryUpdatedAt,
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
}: {
  projectId: string;
  draft: ExperimentDraft;
  inventoryUpdatedAt: string;
  source: ExperimentDraftSource;
  model: string | null;
  promptFingerprint: string | null;
  reviewedConfigHash: string;
}) {
  return invokeExperimentBuilder<ExperimentLaunchResponse>({
    action: "launch",
    project_id: projectId,
    draft,
    inventory_updated_at: inventoryUpdatedAt,
    source,
    model,
    prompt_fingerprint: promptFingerprint,
    reviewed_config_hash: reviewedConfigHash,
    confirm: true,
  });
}

export function draftSettings(
  projectId: string,
  prompt: string,
  currentPlan?: SettingsPlan,
) {
  return invokeExperimentBuilder<SettingsDraftResponse>({
    action: currentPlan ? "settings_revise" : "settings_draft",
    project_id: projectId,
    prompt,
    current_plan: currentPlan,
  });
}
