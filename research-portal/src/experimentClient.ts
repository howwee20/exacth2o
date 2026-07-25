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
import type { AssistantEvidenceBundle } from "./assistantEvidence";

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
  workflow:
    | "answer"
    | "experiment"
    | "settings"
    | "archive"
    | "schedule"
    | "monitor"
    | "lifecycle";
  workflow_prompt: string | null;
  thread_id: string;
  request_id: string;
  evidence: AssistantEvidenceBundle;
  model: string | null;
  prompt_fingerprint: string | null;
};

export type AssistantPersistedMessage = AssistantConversationMessage & {
  id: string;
  workflow: AssistantChatResponse["workflow"];
  created_at: string;
  metadata: {
    evidence?: AssistantEvidenceBundle;
    workflow_prompt?: string | null;
    model?: string | null;
  };
};

export type AssistantThread = {
  id: string;
  title: string;
  status: "active" | "archived";
  created_at: string;
  updated_at: string;
};

export type SchedulePlan = {
  name: string;
  run_at: string | null;
  recurrence: "once" | "daily" | "weekly";
  timezone: string;
  settings_plan: SettingsPlan;
  questions: string[];
};

export type ScheduleDraftResponse = {
  plan: SchedulePlan;
  config_hash: string;
  review_token: string;
  model: string | null;
  prompt_fingerprint: string | null;
  validation_messages: string[];
};

export type MonitorPlan = {
  name: string;
  experiment_id: string | null;
  experiment: string | null;
  metric: "current_vwc" | "change_vwc" | "sensor_stale" | "controller_health";
  comparator: "above" | "below" | "increase_by" | "decrease_by" | "stale" | "unhealthy";
  threshold: number | null;
  window_minutes: number;
  pairing_names: string[];
  check_every_minutes: number;
  cooldown_minutes: number;
  questions: string[];
};

export type MonitorDraftResponse = {
  plan: MonitorPlan;
  review_token: string;
  model: string | null;
  prompt_fingerprint: string | null;
  validation_messages: string[];
};

export type LifecyclePreflight = {
  experiment_id: string;
  experiment_slug: string;
  experiment_name: string;
  lifecycle_action: "complete" | "restore";
  status: string;
  watering_state: string;
  can_apply: boolean;
  reason: string;
  review_token: string;
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
  threadId?: string | null,
) {
  return invokeExperimentBuilder<AssistantChatResponse>({
    action: "assistant_chat",
    project_id: projectId,
    prompt,
    conversation,
    thread_id: threadId,
  });
}

export async function listAssistantThreads(projectId: string) {
  const { data, error } = await supabase
    .from("assistant_threads")
    .select("id,title,status,created_at,updated_at")
    .eq("project_id", projectId)
    .eq("status", "active")
    .order("updated_at", { ascending: false })
    .limit(50);
  if (error) throw error;
  return (data ?? []) as AssistantThread[];
}

export async function loadAssistantConversation(projectId: string, selectedThreadId?: string | null) {
  const threads = await listAssistantThreads(projectId);
  const thread = selectedThreadId
    ? threads.find((item) => item.id === selectedThreadId) ?? null
    : threads[0] ?? null;
  if (!thread) return { threadId: null, messages: [] as AssistantPersistedMessage[] };
  const { data: messages, error: messageError } = await supabase
    .from("assistant_messages")
    .select("id,role,content,workflow,metadata,created_at")
    .eq("project_id", projectId)
    .eq("thread_id", thread.id)
    .order("created_at", { ascending: true })
    .limit(60);
  if (messageError) throw messageError;
  return {
    threadId: thread.id as string,
    messages: (messages ?? []) as AssistantPersistedMessage[],
  };
}

export function renameAssistantThread(projectId: string, threadId: string, title: string) {
  return invokeExperimentBuilder<{ thread: AssistantThread }>({
    action: "assistant_thread_rename",
    project_id: projectId,
    thread_id: threadId,
    title,
  });
}

export function deleteAssistantThread(projectId: string, threadId: string) {
  return invokeExperimentBuilder<{
    deleted_thread_id: string;
    audit_history_preserved: true;
  }>({
    action: "assistant_thread_delete",
    project_id: projectId,
    thread_id: threadId,
  });
}

export function draftSchedule(
  projectId: string,
  prompt: string,
  timezone: string,
  currentPlan?: SchedulePlan,
) {
  return invokeExperimentBuilder<ScheduleDraftResponse>({
    action: "schedule_draft",
    project_id: projectId,
    prompt,
    timezone,
    current_plan: currentPlan,
  });
}

export function createSchedule(
  projectId: string,
  plan: SchedulePlan,
  reviewToken: string,
) {
  return invokeExperimentBuilder<{
    schedule: {
      id: string;
      name: string;
      status: string;
      next_run_at: string;
      recurrence: string;
      timezone: string;
      created_at: string;
    };
  }>({
    action: "schedule_create",
    project_id: projectId,
    plan,
    review_token: reviewToken,
    confirm: true,
  });
}

export function draftMonitor(
  projectId: string,
  prompt: string,
  currentPlan?: MonitorPlan,
) {
  return invokeExperimentBuilder<MonitorDraftResponse>({
    action: "monitor_draft",
    project_id: projectId,
    prompt,
    current_plan: currentPlan,
  });
}

export function createMonitor(
  projectId: string,
  plan: MonitorPlan,
  reviewToken: string,
) {
  return invokeExperimentBuilder<{
    monitor: {
      id: string;
      name: string;
      status: string;
      metric: string;
      comparator: string;
      threshold: number | null;
      window_minutes: number;
      pairing_names: string[];
      check_every_minutes: number;
      created_at: string;
    };
  }>({
    action: "monitor_create",
    project_id: projectId,
    plan,
    review_token: reviewToken,
    confirm: true,
  });
}

export function preflightLifecycle(
  projectId: string,
  experiment: string,
  lifecycleAction: "complete" | "restore",
) {
  return invokeExperimentBuilder<LifecyclePreflight>({
    action: "lifecycle_preflight",
    project_id: projectId,
    experiment,
    lifecycle_action: lifecycleAction,
  });
}

export function applyLifecycle(
  projectId: string,
  review: LifecyclePreflight,
) {
  return invokeExperimentBuilder<{
    experiment_id: string;
    experiment_slug: string;
    status: string;
    lifecycle_action: "complete" | "restore";
    history_preserved: true;
  }>({
    action: "lifecycle_apply",
    project_id: projectId,
    experiment: review.experiment_slug,
    experiment_id: review.experiment_id,
    lifecycle_action: review.lifecycle_action,
    review_token: review.review_token,
    confirm: true,
  });
}

export function cancelAutomation(
  projectId: string,
  automationType: "schedule" | "monitor",
  automationId: string,
) {
  return invokeExperimentBuilder<{
    automation_type: "schedule" | "monitor";
    item: { id: string; status: "canceled"; updated_at: string };
  }>({
    action: "automation_cancel",
    project_id: projectId,
    automation_type: automationType,
    automation_id: automationId,
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
