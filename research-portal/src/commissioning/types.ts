// REAL HARDWARE commissioning types. Kept apart from src/autocal (simulation).

export type CommissioningMode = "real" | "dry_run";

export type SelectedPot = {
  pairingName: string;
  potNumber: number | null;
  valveKey: string;
  sensorKey: string;
};

export type Reading = {
  sensorKey: string;
  atMs: number;
  vwc: number;
};

export type ControllerStatus = {
  observedAtMs: number | null;
  freshUntilMs: number | null;
  controllerState: string | null;
  wateringEnabled: boolean | null;
};

export type CommandState =
  | "queued"
  | "accepted"
  | "running"
  | "succeeded"
  | "failed"
  | "canceled"
  | "expired";

export type CommandSnapshot = {
  id: string;
  status: CommandState;
  error: string | null;
  result: Record<string, unknown> | null;
};

export type PulseRequest = {
  pairingName: string;
  seconds: number;
  runId: string;
  step: string;
};

export type PulseTicket = { commandId: string; operationId: string | null };

export type IntakeProbe = { open: boolean; detail: string };

// Everything the orchestrator may do to the outside world. The real adapter
// maps these onto the existing authenticated Edge Function and RLS-guarded
// tables; tests supply a mock controller. There is deliberately no method that
// addresses a valve directly or bypasses the command queue.
export type CommissioningPorts = {
  now: () => number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  readControllerStatus: () => Promise<ControllerStatus>;
  readReadings: (sensorKeys: string[], sinceMs: number) => Promise<Reading[]>;
  countActiveWateringCommands: () => Promise<number>;
  // Selected pairings whose automatic watering target is still active.
  readAutoWateringPairings: (pairingNames: string[]) => Promise<string[]>;
  probePulseIntake: () => Promise<IntakeProbe>;
  requestPulse: (request: PulseRequest) => Promise<PulseTicket>;
  readCommand: (commandId: string) => Promise<CommandSnapshot | null>;
};

export type CommissioningConfig = {
  pulseSeconds: number;
  escalatedPulseSeconds: number;
  maxTotalValveSeconds: number;
  maxPulses: number;
  baselineReadings: number;
  baselineLookbackSeconds: number;
  baselineTimeoutSeconds: number;
  preReadings: number;
  minPostReadings: number;
  settleSkipSeconds: number;
  maxObserveSeconds: number;
  maxSettleSeconds: number;
  quietRangeVwc: number;
  dryRunObserveSeconds: number;
  pollSeconds: number;
  commandTimeoutSeconds: number;
  cooldownSeconds: number;
  sensorSilenceSeconds: number;
  maxRunSeconds: number;
  minDeltaVwc: number;
  minZ: number;
  rivalZ: number;
  ambiguousRatio: number;
  saturationVwc: number;
  overshootLimitVwc: number;
  reviewConfidence: number;
  safeControllerStates: string[];
};

export type LogKind =
  | "run"
  | "preflight"
  | "operator"
  | "baseline"
  | "interlock"
  | "command_request"
  | "command_ack"
  | "observation"
  | "decision"
  | "error"
  | "abort"
  | "mapping_change";

export type LogEntry = {
  seq: number;
  at: string;
  kind: LogKind;
  message: string;
  data?: Record<string, unknown>;
};

export type SensorBaseline = {
  sensorKey: string;
  valid: boolean;
  reason: string | null;
  warnings: string[];
  count: number;
  medianVwc: number | null;
  noiseSigma: number | null;
  driftPerMinute: number | null;
  cadenceSeconds: number | null;
  lastAtMs: number | null;
};

export type SensorResponse = {
  sensorKey: string;
  preVwc: number;
  postVwc: number;
  deltaVwc: number;
  z: number;
  postCount: number;
  detected: boolean;
};

// Three deliberately separate facts about one pulse: what was asked, what the
// controller acknowledged, and what the sensors measured. None of them proves
// that water physically reached a pot.
export type PulseEvidence = {
  valveKey: string;
  pairingName: string;
  step: string;
  escalated: boolean;
  requestedSeconds: number;
  requestedAt: string;
  commandId: string | null;
  operationId: string | null;
  acknowledgement: {
    status: CommandState | "not_sent";
    at: string | null;
    error: string | null;
    controllerResult: Record<string, unknown> | null;
  };
  responses: SensorResponse[];
  observedSeconds: number;
  physicalDeliveryVerified: false;
};

export type ProposalFault =
  | "no_response"
  | "multiple_responses"
  | "cross_talk"
  | "duplicate_claim"
  | "overshoot"
  | "low_confidence";

export type ProposedMapping = {
  valveKey: string;
  pairingName: string;
  proposedSensorKey: string;
  recordedSensorKey: string;
  matchesRecord: boolean;
  confidence: number;
  status: "proposed" | "needs_review";
  faults: ProposalFault[];
  deltaVwc: number;
  z: number;
  pulseSeconds: number;
  rowRivalDeltaVwc: number;
  columnRivalDeltaVwc: number;
  commandId: string | null;
};

export type UnresolvedValve = {
  valveKey: string;
  pairingName: string;
  reason: ProposalFault | "not_reached" | "command_failed";
  detail: string;
};

export type RunOutcome =
  | "completed"
  | "completed_with_findings"
  | "dry_run_completed"
  | "aborted"
  | "stopped_by_interlock"
  | "failed";

export type CommissioningResult = {
  runId: string;
  mode: CommissioningMode;
  outcome: RunOutcome;
  stopReason: string | null;
  startedAt: string;
  endedAt: string;
  pots: SelectedPot[];
  baselines: SensorBaseline[];
  evidence: PulseEvidence[];
  proposals: ProposedMapping[];
  unresolved: UnresolvedValve[];
  pulsesRequested: number;
  valveSecondsRequested: number;
  log: LogEntry[];
};
