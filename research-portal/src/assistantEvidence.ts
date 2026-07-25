export type AssistantEvidenceSource = {
  tool: string;
  label: string;
  observed_at: string | null;
  available: boolean;
};

export type AssistantExperimentEvidencePairing = {
  pairing_name: string;
  pot_number: number | null;
  crop: string | null;
  treatment: string | null;
  target_vwc_percent: number | null;
  current_vwc_percent: number | null;
  change_vwc_percent: number | null;
};

export type AssistantExperimentEvidenceGroup = {
  id: string;
  label: string;
  target_vwc_percent: number | null;
  pairing_names: string[];
};

export type AssistantExperimentChartArtifact = {
  kind: "experiment_chart";
  title: string;
  experiment_slug: string | null;
  start_at: string | null;
  end_at: string | null;
  observed_at: string | null;
  expected_pots: number | null;
  reading_count: number | null;
  recorded_water_events: number | null;
  latest_water_event_at: string | null;
  pairings: AssistantExperimentEvidencePairing[];
  groups: AssistantExperimentEvidenceGroup[];
  limitations: string[];
};

export type AssistantOperationReceiptArtifact = {
  kind: "operation_receipt";
  title: string;
  observed_at: string | null;
  operations: Array<{
    id: string;
    intent: string;
    execution_state: string;
    verification_state: string;
    created_at: string | null;
    completed_at: string | null;
  }>;
  commands: Array<{
    command_type: string;
    status: string;
    experiment: string | null;
    requested_at: string | null;
    completed_at: string | null;
    error: string | null;
  }>;
};

export type AssistantStatusArtifact = {
  kind: "status";
  title: string;
  observed_at: string | null;
  facts: Array<{ label: string; value: string }>;
};

export type AssistantDeliveryEvidenceArtifact = {
  kind: "delivery_evidence";
  title: string;
  observed_at: string | null;
  physical_evidence_available: boolean;
  evidence_count: number;
  note: string;
};

export type AssistantEvidenceArtifact =
  | AssistantExperimentChartArtifact
  | AssistantOperationReceiptArtifact
  | AssistantStatusArtifact
  | AssistantDeliveryEvidenceArtifact;

export type AssistantEvidenceBundle = {
  version: 1;
  checked_at: string;
  sources: AssistantEvidenceSource[];
  artifacts: AssistantEvidenceArtifact[];
};

export function assistantEvidenceBundle(value: unknown): AssistantEvidenceBundle | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<AssistantEvidenceBundle>;
  if (candidate.version !== 1 || !Array.isArray(candidate.sources) || !Array.isArray(candidate.artifacts)) {
    return null;
  }
  return candidate as AssistantEvidenceBundle;
}
