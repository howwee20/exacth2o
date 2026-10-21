import { AlertTriangle, ArrowLeft, ArrowRight, CheckCircle2, Clock3, Download, Lock, LogOut, Menu, Radar, X } from "lucide-react";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { CalibrationStudio } from "../CalibrationStudio";
import { AutocalibrateWorkspace } from "../autocalibrate/AutocalibrateWorkspace";
import { SettingsAssistant } from "../SettingsAssistant";
import { CopyableId, QueuedChangeNote, ReadinessTile, SettingsEmptyState, StatusChip } from "../SettingsChrome";
import { isObservationOnlyExperiment, type PortalExperiment } from "../experimentRegistry";
import { type PortalRole } from "../portalAccess";
import { boardConfigsFromPayload, formatIntervalFromMs, formatSecondsFromMs, formatSettingsTimestamp, formatTargetVwc, numberInputString, pairingGroupName, runtimeStateIsFresh, syncedCount } from "../portalFormat";
import { type CsvDownload, type DeviceConfigState, type DeviceRuntimeState, type LoadState, type QueueControlCommand, type QueueSettingsPlan, type SettingsNavItem, type SettingsSection } from "../portalTypes";
import { downloadJsonFile } from "../readingsExport";
import { type CommandProgress, type CommandStage } from "../commandLifecycle";
import { controllerPillText, controllerPresence, hardwareInventory, overviewNextAction, relativeAgeText, sensorsReportingText, settingsNavItems, settingsNavItemsFor } from "../settingsPresentation";
import { type PairingRow } from "../types";

export { settingsNavItems };

export type PortalSettingsPanelProps = {
  open: boolean;
  scope?: "installation" | "experiment";
  projectId: string;
  portalRole: PortalRole;
  experiment: PortalExperiment;
  activeSection: SettingsSection;
  data: LoadState;
  runtimeState: DeviceRuntimeState | null;
  configState: DeviceConfigState | null;
  pairings: PairingRow[];
  /** Every pairing on the controller, for Autocalibrate's view of the whole installation. */
  installationPairings?: PairingRow[];
  /** Experiments on this controller, offered as quick selections in Autocalibrate. */
  experiments?: readonly PortalExperiment[];
  visiblePotCount: number;
  csvDownload: CsvDownload | null;
  csvError: string | null;
  exportingCsv: boolean;
  controlBusy: boolean;
  controlNotice: string | null;
  commandProgress: CommandProgress | null;
  controlError: string | null;
  assistantInitialPrompt?: string;
  operatorEmail: string | null;
  onClose: () => void;
  onSectionChange: (section: SettingsSection) => void;
  onPrepareCsvDownload: () => void;
  onDownloadPairingsCsv: () => void;
  onQueueCommand: QueueControlCommand;
  onQueueSettingsPlan: QueueSettingsPlan;
  onSignOut: () => void;
};

const commandStageLabels = [
  ["requested", "Requested"],
  ["queued", "Queued"],
  ["accepted", "Accepted"],
  ["running", "Running"],
  ["executed", "Executed"],
] as const;

function commandStageClass(current: CommandStage, stage: CommandStage) {
  const order: CommandStage[] = ["requested", "queued", "accepted", "running", "executed"];
  if (current === "failed" || current === "canceled" || current === "expired") return stage === "requested" ? "is-done" : "is-stopped";
  const currentIndex = order.indexOf(current);
  const stageIndex = order.indexOf(stage);
  return stageIndex < currentIndex ? "is-done" : stageIndex === currentIndex ? "is-current" : "";
}

export function PortalSettingsPanel({
  open,
  scope = "experiment",
  projectId,
  portalRole,
  experiment,
  activeSection: requestedSection,
  data,
  runtimeState,
  configState,
  pairings,
  installationPairings,
  experiments = [],
  visiblePotCount,
  csvDownload,
  csvError,
  exportingCsv,
  controlBusy,
  controlNotice,
  commandProgress,
  controlError,
  assistantInitialPrompt,
  operatorEmail,
  onClose,
  onSectionChange,
  onPrepareCsvDownload,
  onDownloadPairingsCsv,
  onQueueCommand,
  onQueueSettingsPlan,
  onSignOut,
}: PortalSettingsPanelProps) {
  const isAdmin = portalRole === "admin";
  const availableSettingsNavItems = settingsNavItemsFor(scope);
  const availableSettingsNavGroups = Array.from(
    availableSettingsNavItems.reduce((groups, item) => {
      groups.set(item.group, [...(groups.get(item.group) ?? []), item]);
      return groups;
    }, new Map<SettingsNavItem["group"], SettingsNavItem[]>()),
    ([label, items]) => ({ label, items }),
  );
  const activeItem = availableSettingsNavItems.find((item) => item.id === requestedSection) ?? availableSettingsNavItems[0];
  const activeSection = activeItem.id;
  const boardConfigs = boardConfigsFromPayload(data.latestState?.latest_payload);
  const mirroredBoardCount = configState?.board_count ?? boardConfigs.length;
  const uniqueSensors = new Set(pairings.map((pairing) => pairing.sensor_key).filter(Boolean));
  const uniqueValves = new Set(pairings.map((pairing) => pairing.valve_key).filter(Boolean));
  const controllerGroupNames = useMemo(() => Array.from(new Set(
      (configState?.groups ?? [])
        .map((item) => {
          if (!item || typeof item !== "object" || Array.isArray(item)) return "";
          const name = (item as Record<string, unknown>).name;
          return typeof name === "string" ? name.trim() : "";
        })
        .filter(Boolean),
    )).sort((left, right) => left.localeCompare(right, undefined, { numeric: true })),
  [configState?.groups]);
  const projectGroups = Array.from(
    pairings.reduce((groups, pairing) => {
      const label = pairingGroupName(pairing);
      groups.set(label, [...(groups.get(label) ?? []), pairing]);
      return groups;
    }, new Map<string, PairingRow[]>(controllerGroupNames.map((name) => [name, []]))),
    ([label, groupPairings]) => ({ label, pairings: groupPairings }),
  );
  const groupOptions = [
    { value: "all", label: "All pairings", pairings },
    ...projectGroups.map((group) => ({
      value: group.label,
      label: group.label,
      pairings: group.pairings,
    })),
  ];
  const [bulkGroup, setBulkGroup] = useState("all");
  const [bulkWateringEnabled, setBulkWateringEnabled] = useState(true);
  const [bulkTarget, setBulkTarget] = useState("20");
  const [bulkOpenSeconds, setBulkOpenSeconds] = useState("5");
  const [bulkIntervalSeconds, setBulkIntervalSeconds] = useState("600");
  const [singlePairingName, setSinglePairingName] = useState(pairings[0]?.name ?? "");
  const [singleNewName, setSingleNewName] = useState(pairings[0]?.name ?? "");
  const [singleGroupName, setSingleGroupName] = useState(pairings[0] ? pairingGroupName(pairings[0]) : "");
  const [deletePairingConfirm, setDeletePairingConfirm] = useState(false);
  const [singleWateringEnabled, setSingleWateringEnabled] = useState((pairings[0]?.wtc_percent_limit ?? -999999) >= 0);
  const [singleTarget, setSingleTarget] = useState(pairings[0] && pairings[0].wtc_percent_limit >= 0 ? numberInputString(pairings[0].wtc_percent_limit) : "20");
  const [singleOpenSeconds, setSingleOpenSeconds] = useState(
    pairings[0] ? numberInputString(pairings[0].valve_open_time_ms / 1000) : "5",
  );
  const [singleIntervalSeconds, setSingleIntervalSeconds] = useState(
    pairings[0] ? numberInputString(pairings[0].measurement_interval_ms / 1000, 0) : "600",
  );
  const [newPairingName, setNewPairingName] = useState("");
  const [newPairingSensor, setNewPairingSensor] = useState("");
  const [newPairingValve, setNewPairingValve] = useState("");
  const [newPairingGroup, setNewPairingGroup] = useState("Experiment pairings");
  const [newPairingTarget, setNewPairingTarget] = useState("20");
  const [newPairingOpenSeconds, setNewPairingOpenSeconds] = useState("5");
  const [newPairingIntervalSeconds, setNewPairingIntervalSeconds] = useState("600");
  const [groupName, setGroupName] = useState("");
  const [groupType, setGroupType] = useState<"none" | "group" | "block">("none");
  const [removeGroupName, setRemoveGroupName] = useState(projectGroups[0]?.label ?? "");
  const [boardAddresses, setBoardAddresses] = useState(
    boardConfigs.length ? boardConfigs.map((config) => config.address).join(", ") : "0x20, 0x24, 0x26",
  );
  const [boardResetPin, setBoardResetPin] = useState("16");
  const [destructiveConfirm, setDestructiveConfirm] = useState(false);
  const [boardConfirm, setBoardConfirm] = useState(false);
  const [exportDataType, setExportDataType] = useState("readings");
  const selectedPairing = pairings.find((pairing) => pairing.name === singlePairingName) ?? pairings[0] ?? null;
  const csvReady = data.readings.length > 0;
  const [navOpen, setNavOpen] = useState(false);
  const presence = controllerPresence({
    stateFreshUntil: runtimeState?.state_fresh_until,
    stateObservedAt: runtimeState?.state_observed_at,
    controllerState: runtimeState?.controller_state,
    lastSeenAt: data.latestState?.last_seen_at ?? data.latestState?.updated_at,
  });
  const controllerIsLive = presence.status === "online";
  const inventory = useMemo(() => hardwareInventory(pairings, data.readings), [pairings, data.readings]);
  const lastReadingAt = runtimeState?.last_sensor_reading_at
    ?? data.latestLiveReading?.device_recorded_at
    ?? data.latestIngestTime;
  const sensorsReporting = sensorsReportingText(runtimeState?.sensors_current, runtimeState?.sensors_expected);

  useEffect(() => {
    if (!open) setNavOpen(false);
  }, [open]);

  useEffect(() => {
    if (!open || pairings.length === 0) return;
    setSinglePairingName((current) => (
      current && pairings.some((pairing) => pairing.name === current) ? current : pairings[0].name
    ));
  }, [open, pairings]);

  const loadedPairingRef = useRef<string | null>(null);
  useEffect(() => {
    if (!open) {
      loadedPairingRef.current = null;
      return;
    }
    if (!selectedPairing || loadedPairingRef.current === selectedPairing.name) return;
    // Polling replaces row objects. Keep unsaved inputs until the user changes
    // pairing or reopens Settings; the reviewed config hash guards stale saves.
    loadedPairingRef.current = selectedPairing.name;
    setSingleWateringEnabled(selectedPairing.wtc_percent_limit >= 0);
    setSingleTarget(selectedPairing.wtc_percent_limit >= 0 ? numberInputString(selectedPairing.wtc_percent_limit) : "20");
    setSingleOpenSeconds(numberInputString(Math.max(1, selectedPairing.valve_open_time_ms / 1000)));
    setSingleIntervalSeconds(numberInputString(selectedPairing.measurement_interval_ms / 1000, 0));
    setSingleNewName(selectedPairing.name);
    setSingleGroupName(pairingGroupName(selectedPairing));
    setDeletePairingConfirm(false);
  }, [open, selectedPairing]);

  useEffect(() => {
    if (!open || controllerGroupNames.length === 0) return;
    setNewPairingGroup((current) => (
      controllerGroupNames.includes(current) ? current : controllerGroupNames[0]
    ));
  }, [open, controllerGroupNames]);

  if (!open) return null;

  function pairingsForGroup(groupValue: string) {
    return groupOptions.find((group) => group.value === groupValue)?.pairings ?? [];
  }

  function pairingNamesForGroup(groupValue: string) {
    return pairingsForGroup(groupValue).map((pairing) => pairing.name);
  }

  function parseNumber(value: string) {
    return Number(value.trim());
  }

  async function submitBulkPairingUpdate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await onQueueCommand("bulk_update_pairings", {
      pairing_names: pairingNamesForGroup(bulkGroup),
      ...(bulkWateringEnabled ? { target_vwc: parseNumber(bulkTarget), open_time_seconds: parseNumber(bulkOpenSeconds) } : { disable_watering: true }),
      measurement_interval_seconds: parseNumber(bulkIntervalSeconds),
    });
  }

  async function submitSinglePairingUpdate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await onQueueCommand("update_pairing", {
      pairing_name: selectedPairing?.name ?? singlePairingName,
      new_name: singleNewName,
      group_name: singleGroupName,
      ...(singleWateringEnabled ? { target_vwc: parseNumber(singleTarget), open_time_seconds: parseNumber(singleOpenSeconds) } : { disable_watering: true }),
      measurement_interval_seconds: parseNumber(singleIntervalSeconds),
    });
  }

  async function submitCreatePairing(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await onQueueCommand("create_pairing", {
      name: newPairingName,
      sensor_key: newPairingSensor,
      valve_key: newPairingValve,
      group_name: newPairingGroup,
      target_vwc: parseNumber(newPairingTarget),
      open_time_seconds: parseNumber(newPairingOpenSeconds),
      measurement_interval_seconds: parseNumber(newPairingIntervalSeconds),
    });
  }

  async function submitCreateGroup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await onQueueCommand("create_group", {
      group_name: groupName,
      group_type: groupType,
    });
  }

  async function submitDeletePairing() {
    if (!selectedPairing) return;
    await onQueueCommand("delete_pairing", {
      pairing_name: selectedPairing.name,
    }, { confirm: true });
  }

  async function submitRemoveGroup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await onQueueCommand("remove_group", {
      group_name: removeGroupName,
    }, { confirm: true });
  }

  async function submitBoardConfig(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const boards = boardAddresses
      .split(/[,\n]/)
      .map((address) => address.trim())
      .filter(Boolean)
      .map((address) => ({
        address,
        reset_pin: parseNumber(boardResetPin),
      }));
    await onQueueCommand("update_board_config", { boards }, { confirm: true });
  }

  async function queueSystemState(state: "running" | "stopped") {
    await onQueueCommand("update_system_state", {
      state,
      reason: state === "stopped" ? "Portal stop request" : "Portal start request",
    }, { confirm: destructiveConfirm || state === "running" });
  }

  async function queueExportData() {
    if (exportDataType === "readings") {
      onPrepareCsvDownload();
      return;
    }
    if (exportDataType === "pairings") {
      onDownloadPairingsCsv();
      return;
    }
    const synchronized: Record<string, unknown> = {
      groups: configState?.groups ?? [],
      sensors: configState?.sensors ?? [],
      valves: configState?.valves ?? [],
      calibrations: configState?.calibrations ?? [],
    };
    downloadJsonFile(exportDataType, synchronized[exportDataType] ?? []);
  }

  const commandStatusPanel = (
    <>
      {commandProgress ? (
        <div className={`settings-callout is-${commandProgress.tone === "ok" ? "success" : commandProgress.tone === "bad" ? "error" : "warning"} command-progress`} role="status" aria-live="polite">
          {commandProgress.tone === "ok" ? <CheckCircle2 size={18} aria-hidden="true" /> : commandProgress.tone === "bad" ? <AlertTriangle size={18} aria-hidden="true" /> : <Clock3 size={18} aria-hidden="true" />}
          <div>
            <strong>{commandProgress.title}</strong>
            <p>{commandProgress.detail}</p>
            <ol className="command-stages" aria-label="Request progress">
              {commandProgress.steps
                ? commandProgress.steps.map((step, index) => (
                  <li key={`${index}-${step.label}`} className={step.state === "pending" ? "" : `is-${step.state}`}>
                    {step.label}
                  </li>
                ))
                : commandStageLabels.map(([stage, label]) => (
                  <li key={stage} className={commandStageClass(commandProgress.stage, stage)}>{label}</li>
                ))}
              {commandProgress.hasPhysicalOutcome ? (
                <li className="is-unverified" title="The portal has no flow, pressure or weight evidence.">Water delivery: not verified</li>
              ) : null}
            </ol>
          </div>
        </div>
      ) : null}
      {controlNotice ? (
        <div className={`settings-callout ${controllerIsLive ? "is-success" : "is-warning"}`} role="status">
          {controllerIsLive ? <CheckCircle2 size={18} aria-hidden="true" /> : <Clock3 size={18} aria-hidden="true" />}
          <div>
            <strong>{controlNotice}</strong>
            {controllerIsLive ? null : <p>Waiting for controller confirmation.</p>}
          </div>
        </div>
      ) : null}
      {controlError ? (
        <div className="settings-callout is-error">
          <AlertTriangle size={18} />
          <div>
            <strong>Request failed.</strong>
            <p>{controlError}</p>
          </div>
        </div>
      ) : null}
    </>
  );

  const renderSection = () => {
    if (activeSection === "overview" && scope === "experiment") {
      return <section className="settings-card">
        <h3>{experiment.name}</h3>
        <div className="settings-rows">
          <div className="settings-row"><span>Experiment state</span><strong>{experiment.status?.replace(/_/g, " ") ?? "Not recorded"}</strong></div>
          <div className="settings-row"><span>Pots in the plan</span><strong>{experiment.pairingNames.length}</strong></div>
          <div className="settings-row"><span>Mode</span><strong>{experiment.mode === "observation" ? "Sensing only" : experiment.mode === "calibration" ? "Calibration" : "Controlled"}</strong></div>
          <div className="settings-row"><span>Plan revision</span><strong>{experiment.currentVersion ?? "Not recorded"}</strong></div>
        </div>
        <p className="settings-muted">Edit the experiment from its page to review changes to its pots and targets. Controller operation and wiring are managed in Installation settings.</p>
      </section>;
    }
    if (activeSection === "overview") {
      const wateringEnabled = runtimeState?.watering_enabled ?? null;
      const sensingOnly = scope === "experiment" && isObservationOnlyExperiment(experiment);
      const canOpen = (section: SettingsSection) => availableSettingsNavItems.some((item) => item.id === section);
      const next = overviewNextAction({
        presence: presence.status,
        pairingCount: pairings.length,
        sensorsCurrent: runtimeState?.sensors_current ?? null,
        sensorsExpected: runtimeState?.sensors_expected ?? null,
        wateringEnabled,
        sensingOnly,
        isAdmin,
      });
      const lastKnown = controllerIsLive ? "" : " when last seen";
      const missingSensors = runtimeState?.sensors_current != null && runtimeState?.sensors_expected != null
        ? Math.max(0, Math.trunc(runtimeState.sensors_expected) - Math.trunc(runtimeState.sensors_current))
        : null;
      const when = (value?: string | null, empty = "Not yet") => (value
        ? `${formatSettingsTimestamp(value)} · ${relativeAgeText(value)}`
        : <span className="settings-empty-value">{empty}</span>);
      return (
        <>
          {!controllerIsLive || pairings.length === 0 ? <section className={`settings-next-step is-${next.tone}`} aria-label="Next step">
            <div>
              <p className="settings-next-step-eyebrow">Next step</p>
              <h3>{next.title}</h3>
              <p>{next.detail}</p>
            </div>
            {next.section && next.actionLabel && canOpen(next.section) ? (
              <button type="button" className="settings-primary-button" onClick={() => onSectionChange(next.section as SettingsSection)}>
                {next.actionLabel} <ArrowRight size={14} aria-hidden="true" />
              </button>
            ) : null}
          </section> : null}
          <div className="settings-readiness-grid">
            <ReadinessTile
              title="Installation"
              tone={!presence.controllerState ? "unknown" : controllerIsLive ? (presence.controllerState === "Running" ? "ok" : "warning") : "unknown"}
              status={presence.controllerState ? `${presence.controllerState}${lastKnown}` : "Not reported"}
              lines={[
                { label: "Pots", value: pairings.length },
                { label: "Plant groups", value: projectGroups.length },
              ]}
            />
            <ReadinessTile
              title="Valve activity"
              tone="info"
              status={runtimeState?.watering_last_event_at ? "Opening recorded" : "None recorded"}
              lines={[
                { label: "Last opening", value: when(runtimeState?.watering_last_event_at, "None recorded") },
              ]}
              actionLabel={canOpen("water") ? "Open Watering" : undefined}
              onAction={() => onSectionChange("water")}
            />
            <ReadinessTile
              title="Sensors"
              tone={!controllerIsLive || missingSensors == null ? "unknown" : missingSensors === 0 ? "ok" : "warning"}
              status={sensorsReporting ? `${sensorsReporting} reporting${lastKnown}` : "Not reported"}
              lines={[
                { label: "Last reading", value: when(lastReadingAt, "No readings yet") },
              ]}
              actionLabel={canOpen("calibrations") ? "Open Sensor calibration" : undefined}
              onAction={() => onSectionChange("calibrations")}
            />
            <ReadinessTile
              title="Pairings"
              tone={pairings.length ? "info" : "warning"}
              status={pairings.length ? `${pairings.length} paired` : "None yet"}
              lines={[
                { label: "Checked at the bench", value: <span className="settings-empty-value">Not yet</span> },
              ]}
              actionLabel={canOpen("pairings") ? "Open Pairings" : canOpen("autocalibrate") ? "Open Autocalibrate" : undefined}
              onAction={() => onSectionChange(canOpen("pairings") ? "pairings" : "autocalibrate")}
            />
          </div>
          <details className="settings-advanced">
            <summary>Advanced details</summary>
            <div className="settings-rows">
              <div className="settings-row">
                <span>Controller last seen</span>
                <strong>{when(presence.lastSeenAt, "Never")}</strong>
              </div>
              <div className="settings-row">
                <span>Readings from the live controller</span>
                <strong>{data.totalLiveReadings.toLocaleString()}</strong>
              </div>
              <div className="settings-row">
                <span>Readings from the imported archive</span>
                <strong>{data.totalImportedReadings.toLocaleString()}</strong>
              </div>
              <div className="settings-row">
                <span>Watering schedules loaded</span>
                <strong>
                  {runtimeState?.scheduler_jobs_loaded == null
                    ? <span className="settings-empty-value">Not reported</span>
                    : Math.trunc(runtimeState.scheduler_jobs_loaded).toLocaleString()}
                </strong>
              </div>
              <div className="settings-row">
                <span>Pots shown on the chart</span>
                <strong>{visiblePotCount}</strong>
              </div>
              {isAdmin ? (
                <div className="settings-row">
                  <span>Controller ID (for support)</span>
                  <strong><CopyableId value={data.latestState?.device_id} label="controller ID" /></strong>
                </div>
              ) : null}
            </div>
          </details>
          {commandStatusPanel}
        </>
      );
    }

    if (activeSection === "assistant") {
      return (
        <>
          {commandStatusPanel}
          <SettingsAssistant
            projectId={projectId}
            initialPrompt={assistantInitialPrompt}
            controlBusy={controlBusy}
            onApply={onQueueSettingsPlan}
          />
        </>
      );
    }

    if (activeSection === "pairings") {
      return (
        <>
          {commandStatusPanel}
          <div className="settings-section-heading">
            <h3>Current pairings</h3>
            <p>{pairings.length} {pairings.length === 1 ? "pot" : "pots"} · from the project records</p>
          </div>
          {pairings.length === 0 ? (
            <SettingsEmptyState title="No pairings yet">
              A pairing links one valve output to the sensor in the pot it waters. Add the first one below.
            </SettingsEmptyState>
          ) : (
            <div className="settings-table-wrap is-scrollable">
              <table className="settings-table">
                <thead>
                  <tr>
                    <th scope="col">Pot</th>
                    <th scope="col">Sensor</th>
                    <th scope="col">Valve</th>
                    <th scope="col">Group</th>
                    <th scope="col">Target</th>
                    <th scope="col">Pulse</th>
                    <th scope="col">Checks</th>
                  </tr>
                </thead>
                <tbody>
                  {pairings.map((pairing) => (
                    <tr key={pairing.id}>
                      <td>
                        <b>{pairing.pot_number}</b>
                        <span>{pairing.name}</span>
                      </td>
                      <td><code className="settings-identity">{pairing.sensor_key}</code></td>
                      <td><code className="settings-identity">{pairing.valve_key}</code></td>
                      <td>{pairingGroupName(pairing)}</td>
                      <td>{formatTargetVwc(pairing.wtc_percent_limit)}</td>
                      <td>{formatSecondsFromMs(pairing.valve_open_time_ms)}</td>
                      <td>Every {formatIntervalFromMs(pairing.measurement_interval_ms)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="settings-toolbar">
            <p>
              Sensor and valve addresses identify each connection.
            </p>
            <div className="settings-toolbar-actions">
              <button type="button" className="settings-secondary-button" onClick={() => onSectionChange("autocalibrate")}>
                <Radar size={14} aria-hidden="true" />
                Check with Autocalibrate
              </button>
              <button type="button" className="settings-secondary-button" onClick={onDownloadPairingsCsv}>
                <Download size={14} aria-hidden="true" />
                Pairings CSV
              </button>
            </div>
          </div>
          <div className="settings-section-heading">
            <h3>Change pairings</h3>
            <p>The controller applies a change, then reports back.</p>
          </div>
          <QueuedChangeNote presence={presence} />
          <div className="settings-grid">
            <section className="settings-card">
              <h3>Edit one pairing</h3>
              <form className="settings-form" onSubmit={submitSinglePairingUpdate}>
                <label>
                  Pairing
                  <select value={singlePairingName} onChange={(event) => setSinglePairingName(event.target.value)} required>
                    {pairings.map((pairing) => (
                      <option value={pairing.name} key={pairing.id}>
                        Pot {pairing.pot_number} · {pairing.name}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="settings-field-grid">
                  <label>
                    Name
                    <input
                      value={singleNewName}
                      onChange={(event) => setSingleNewName(event.target.value)}
                      pattern="Zone[0-9]+-Pot[0-9]+"
                      title="Use Zone<number>-Pot<number>"
                      required
                    />
                  </label>
                  <label>
                    Group
                    <select value={singleGroupName} onChange={(event) => setSingleGroupName(event.target.value)} required>
                      {controllerGroupNames.map((name) => (
                        <option value={name} key={name}>{name}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Watering
                    <select value={singleWateringEnabled ? "on" : "off"} onChange={(event) => setSingleWateringEnabled(event.target.value === "on")}>
                      <option value="off">Off · sense only</option>
                      <option value="on">On · water to target</option>
                    </select>
                  </label>
                  {singleWateringEnabled ? (
                    <label>
                      Target VWC %
                      <input type="number" min="0" max="80" step="0.1" value={singleTarget} onChange={(event) => setSingleTarget(event.target.value)} required />
                    </label>
                  ) : null}
                  <label>
                    Pulse length (sec)
                    <input type="number" min="1" max="120" step="1" value={singleOpenSeconds} onChange={(event) => setSingleOpenSeconds(event.target.value)} disabled={!singleWateringEnabled} required={singleWateringEnabled} />
                  </label>
                  <label>
                    Check every (sec)
                    <input type="number" min="30" max="3600" step="30" value={singleIntervalSeconds} onChange={(event) => setSingleIntervalSeconds(event.target.value)} required />
                  </label>
                </div>
                <button type="submit" className="settings-primary-button" disabled={controlBusy || !selectedPairing}>
                  Save pairing
                </button>
                {isAdmin ? (
                  <>
                    <label className="settings-check">
                      <input
                        type="checkbox"
                        checked={deletePairingConfirm}
                        onChange={(event) => setDeletePairingConfirm(event.target.checked)}
                      />
                      <span>Confirm deletion of {selectedPairing?.name}</span>
                    </label>
                    <button
                      type="button"
                      className="settings-danger-button"
                      onClick={() => void submitDeletePairing()}
                      disabled={controlBusy || !selectedPairing || !deletePairingConfirm}
                    >
                      Delete pairing
                    </button>
                  </>
                ) : null}
              </form>
            </section>
            <section className="settings-card">
              <h3>Set targets for a group</h3>
              <form className="settings-form" onSubmit={submitBulkPairingUpdate}>
                <label>
                  Group
                  <select value={bulkGroup} onChange={(event) => setBulkGroup(event.target.value)}>
                    {groupOptions.map((group) => (
                      <option value={group.value} key={group.value}>
                        {group.label} ({group.pairings.length})
                      </option>
                    ))}
                  </select>
                </label>
                <div className="settings-field-grid">
                  <label>
                    Watering
                    <select value={bulkWateringEnabled ? "on" : "off"} onChange={(event) => setBulkWateringEnabled(event.target.value === "on")}>
                      <option value="off">Off · sense only</option>
                      <option value="on">On · water to target</option>
                    </select>
                  </label>
                  {bulkWateringEnabled ? (
                    <label>
                      Target VWC %
                      <input type="number" min="0" max="80" step="0.1" value={bulkTarget} onChange={(event) => setBulkTarget(event.target.value)} required />
                    </label>
                  ) : null}
                  <label>
                    Pulse length (sec)
                    <input type="number" min="1" max="120" step="1" value={bulkOpenSeconds} onChange={(event) => setBulkOpenSeconds(event.target.value)} disabled={!bulkWateringEnabled} required={bulkWateringEnabled} />
                  </label>
                  <label>
                    Check every (sec)
                    <input type="number" min="30" max="3600" step="30" value={bulkIntervalSeconds} onChange={(event) => setBulkIntervalSeconds(event.target.value)} required />
                  </label>
                </div>
                <button type="submit" className="settings-primary-button" disabled={controlBusy || pairingsForGroup(bulkGroup).length === 0}>
                  Save group targets
                </button>
              </form>
            </section>
            <section className="settings-card">
              <h3>Add a pairing</h3>
              <form className="settings-form" onSubmit={submitCreatePairing}>
                <div className="settings-field-grid is-two">
                  <label>
                    Name
                    <input
                      value={newPairingName}
                      onChange={(event) => setNewPairingName(event.target.value)}
                      placeholder="Zone4-Pot101"
                      pattern="Zone[0-9]+-Pot[0-9]+"
                      title="Use Zone<number>-Pot<number>"
                      required
                    />
                  </label>
                  <label>
                    Group
                    <select value={newPairingGroup} onChange={(event) => setNewPairingGroup(event.target.value)} required>
                      {controllerGroupNames.map((name) => (
                        <option value={name} key={name}>{name}</option>
                      ))}
                    </select>
                  </label>
                </div>
                <div className="settings-field-grid is-two">
                  <label>
                    Sensor
                    <input value={newPairingSensor} onChange={(event) => setNewPairingSensor(event.target.value)} placeholder="D30GQN2E:y" required />
                  </label>
                  <label>
                    Valve
                    <input value={newPairingValve} onChange={(event) => setNewPairingValve(event.target.value)} placeholder="0x20:49" required />
                  </label>
                </div>
                <label>
                  Initial target VWC %
                  <input type="number" min="0" max="80" step="0.1" value={newPairingTarget} onChange={(event) => setNewPairingTarget(event.target.value)} required />
                </label>
                <div className="settings-field-grid is-two">
                  <label>
                    Pulse length (sec)
                    <input type="number" min="1" max="120" step="1" value={newPairingOpenSeconds} onChange={(event) => setNewPairingOpenSeconds(event.target.value)} required />
                  </label>
                  <label>
                    Check every (sec)
                    <input type="number" min="30" max="3600" step="30" value={newPairingIntervalSeconds} onChange={(event) => setNewPairingIntervalSeconds(event.target.value)} required />
                  </label>
                </div>
                <button type="submit" className="settings-secondary-button" disabled={controlBusy}>
                  Add pairing
                </button>
              </form>
            </section>
          </div>
        </>
      );
    }

    if (activeSection === "autocalibrate") {
      // Valve pulses go through the control-command service; pairing and settings changes
      // through the same reviewed settings batch as the rest of Settings.
      return (
        <>
          {commandStatusPanel}
          <AutocalibrateWorkspace
            projectId={projectId}
            deviceId={data.latestState?.device_id ?? runtimeState?.device_id ?? configState?.device_id ?? null}
            operator={operatorEmail}
            portalRole={portalRole}
            scope={scope}
            experiment={experiment}
            experiments={experiments}
            pairings={installationPairings ?? pairings}
            configHash={configState?.config_hash?.trim() || null}
            controllerState={runtimeStateIsFresh(runtimeState) ? runtimeState?.controller_state ?? null : null}
            controllerOnline={controllerIsLive}
            controlBusy={controlBusy}
            onQueueSettingsPlan={onQueueSettingsPlan}
          />
        </>
      );
    }

    if (activeSection === "calibrations") {
      return (
        <>
          {commandStatusPanel}
          <CalibrationStudio
            projectId={projectId}
            experiment={experiment}
            pairings={pairings}
            readings={data.readings}
            portalRole={portalRole}
            controllerStopped={runtimeStateIsFresh(runtimeState) && runtimeState?.controller_state?.trim().toLowerCase() === "stopped"}
          />
        </>
      );
    }

    if (activeSection === "water") {
      return (
        <>
          {commandStatusPanel}
          <QueuedChangeNote presence={presence} />
          <div className="settings-grid">
            <section className="settings-card">
              <h3>Current targets</h3>
              <div className="settings-rows">
                {projectGroups.length === 0 ? (
                  <p className="settings-muted">No groups have targets yet. Set them under Pairings.</p>
                ) : null}
                {projectGroups.map((group) => {
                  const targets = Array.from(new Set(group.pairings.map((pairing) => formatTargetVwc(pairing.wtc_percent_limit))));
                  return (
                    <div className="settings-row" key={group.label}>
                      <span>{group.label}</span>
                      <strong>{targets.join(", ") || "No pots"}</strong>
                    </div>
                  );
                })}
              </div>
            </section>
            <section className="settings-card">
              <h3>Manual watering</h3>
              <p className="settings-muted">Available after valve shutoff is verified at the bench.</p>
              <button type="button" className="settings-locked-button" disabled>
                <Lock size={14} aria-hidden="true" /> Awaiting bench check
              </button>
            </section>
            <section className="settings-card">
              <h3>Allowed setting ranges</h3>
              <div className="settings-rows">
                <div className="settings-row">
                  <span>Pulse length</span>
                  <strong>1–120 sec per pot</strong>
                </div>
                <div className="settings-row">
                  <span>Time between checks</span>
                  <strong>30 sec–60 min</strong>
                </div>
                <div className="settings-row">
                  <span>Target range</span>
                  <strong>0–80% VWC</strong>
                </div>
                <div className="settings-row">
                  <span>Manual pulse</span>
                  <strong><StatusChip tone="unknown">Locked</StatusChip></strong>
                </div>
              </div>
              <p className="settings-muted">The controller waits and measures again between watering pulses.</p>
            </section>
            <section className="settings-card">
              <h3>Controller state</h3>
              <p className="settings-muted">Starting or stopping affects every experiment on this controller.</p>
              <div className="settings-rows">
                <div className="settings-row">
                  <span>{controllerIsLive ? "Controller" : "Last known state"}</span>
                  <strong>
                    {presence.controllerState
                      ? <StatusChip tone={controllerIsLive ? "ok" : "unknown"}>{presence.controllerState}</StatusChip>
                      : <span className="settings-empty-value">Not reported</span>}
                  </strong>
                </div>
                <div className="settings-row">
                  <span>Observed</span>
                  <strong>
                    {runtimeState?.state_observed_at
                      ? `${formatSettingsTimestamp(runtimeState.state_observed_at)} · ${relativeAgeText(runtimeState.state_observed_at)}`
                      : <span className="settings-empty-value">Never</span>}
                  </strong>
                </div>
              </div>
              <label className="settings-check">
                <input
                  type="checkbox"
                  checked={destructiveConfirm}
                  onChange={(event) => setDestructiveConfirm(event.target.checked)}
                />
                <span>Confirm stop for the whole controller</span>
              </label>
              <div className="settings-action-stack">
                <button type="button" onClick={() => void queueSystemState("running")} disabled={controlBusy}>
                  <CheckCircle2 size={14} /> Start controller
                </button>
                <button type="button" onClick={() => void queueSystemState("stopped")} disabled={controlBusy || !destructiveConfirm}>
                  <AlertTriangle size={14} /> Stop controller
                </button>
              </div>
            </section>
          </div>
        </>
      );
    }

    if (activeSection === "groups") {
      return (
        <>
          {commandStatusPanel}
          <QueuedChangeNote presence={presence} />
          <div className="settings-grid">
            <section className="settings-card">
              <h3>Create a group</h3>
              <form className="settings-form" onSubmit={submitCreateGroup}>
                <label>
                  Group name
                  <input value={groupName} onChange={(event) => setGroupName(event.target.value)} placeholder="Drought rows" required />
                </label>
                <label>
                  Type
                  <select value={groupType} onChange={(event) => setGroupType(event.target.value as "none" | "group" | "block")}>
                    <option value="none">None</option>
                    <option value="group">Group</option>
                    <option value="block">Block</option>
                  </select>
                </label>
                <button type="submit" className="settings-primary-button" disabled={controlBusy}>
                  Create group
                </button>
              </form>
            </section>
            <section className="settings-card">
              <h3>Remove a group</h3>
              <form className="settings-form" onSubmit={submitRemoveGroup}>
                <label>
                  Group
                  <select value={removeGroupName} onChange={(event) => setRemoveGroupName(event.target.value)}>
                    <option value="">Choose a group</option>
                    {groupOptions.filter((group) => group.value !== "all").map((group) => (
                      <option value={group.label} key={group.value}>{group.label}</option>
                    ))}
                  </select>
                </label>
                <button type="submit" className="settings-danger-button" disabled={controlBusy || !removeGroupName}>
                  Remove group
                </button>
              </form>
            </section>
          </div>
          <div className="settings-section-heading">
            <h3>Current groups</h3>
            <p>{projectGroups.length} {projectGroups.length === 1 ? "group" : "groups"}</p>
          </div>
          {projectGroups.length === 0 ? (
            <SettingsEmptyState title="No groups yet">Create a group, then assign pots to it under Pairings.</SettingsEmptyState>
          ) : null}
          <div className="settings-grid">
            {projectGroups.map((group) => (
              <section className="settings-card" key={group.label}>
                <h3>{group.label}</h3>
                <div className="settings-rows">
                  <div className="settings-row">
                    <span>Pots</span>
                    <strong>{group.pairings.map((pairing) => pairing.pot_number).join(", ") || "None"}</strong>
                  </div>
                  <div className="settings-row">
                    <span>Count</span>
                    <strong>{group.pairings.length}</strong>
                  </div>
                  <div className="settings-row">
                    <span>Targets</span>
                    <strong>{Array.from(new Set(group.pairings.map((pairing) => formatTargetVwc(pairing.wtc_percent_limit)))).join(", ") || "—"}</strong>
                  </div>
                </div>
              </section>
            ))}
          </div>
        </>
      );
    }

    if (activeSection === "hardware") {
      return (
        <>
          {commandStatusPanel}
          <div className="settings-grid">
            <section className="settings-card">
              <h3>Installed hardware</h3>
              <div className="settings-rows">
                <div className="settings-row">
                  <span>Sensors</span>
                  <strong>{uniqueSensors.size || <span className="settings-empty-value">None</span>}</strong>
                </div>
                <div className="settings-row">
                  <span>Valve outputs</span>
                  <strong>{uniqueValves.size || <span className="settings-empty-value">None</span>}</strong>
                </div>
                <div className="settings-row">
                  <span>Valve driver boards</span>
                  <strong>{mirroredBoardCount || <span className="settings-empty-value">Not reported</span>}</strong>
                </div>
              </div>
            </section>
            <section className="settings-card">
              <h3>Controller configuration copy</h3>
              {!configState ? (
                <p className="settings-muted">
                  The controller has not shared its configuration with the portal yet. Counts on this page come from the
                  project records instead.
                </p>
              ) : null}
              <div className="settings-rows" hidden={!configState}>
                <div className="settings-row">
                  <span>Last copied from controller</span>
                  <strong>
                    {configState?.observed_at
                      ? `${formatSettingsTimestamp(configState.observed_at)} · ${relativeAgeText(configState.observed_at)}`
                      : <span className="settings-empty-value">Never</span>}
                  </strong>
                </div>
                <div className="settings-row">
                  <span>Pairings / calibrations</span>
                  <strong>{syncedCount(configState?.pairing_count ?? pairings.length)} / {syncedCount(configState?.calibration_count)}</strong>
                </div>
                <div className="settings-row">
                  <span>Sensors / valves</span>
                  <strong>{syncedCount(configState?.sensor_count)} / {syncedCount(configState?.valve_count)}</strong>
                </div>
                <div className="settings-row">
                  <span>Groups</span>
                  <strong>{syncedCount(configState?.group_count)}</strong>
                </div>
                <div className="settings-row">
                  <span>Configuration fingerprint</span>
                  <strong><CopyableId value={configState?.config_hash?.trim() || null} label="configuration fingerprint" maxLength={14} /></strong>
                </div>
              </div>
            </section>
          </div>
          <div className="settings-section-heading">
            <h3>Sensors</h3>
            <p>Identity is reported by the sensor. The label is the pot it is currently assigned to.</p>
          </div>
          {inventory.sensors.length === 0 ? (
            <SettingsEmptyState title="No sensors reported">Sensors appear here once they are part of a pairing.</SettingsEmptyState>
          ) : (
            <div className="settings-table-wrap is-compact">
              <table className="settings-table">
                <thead>
                  <tr>
                    <th scope="col">Sensor identity</th>
                    <th scope="col">Assigned label</th>
                    <th scope="col">Last reading</th>
                  </tr>
                </thead>
                <tbody>
                  {inventory.sensors.map((sensor) => (
                    <tr key={sensor.identity}>
                      <td><code className="settings-identity">{sensor.identity}</code></td>
                      <td>{sensor.label ?? "Unlabeled"}{sensor.potNumber != null ? ` · Pot ${sensor.potNumber}` : ""}</td>
                      <td>
                        {sensor.lastReadingAt
                          ? `${formatSettingsTimestamp(sensor.lastReadingAt)} · ${relativeAgeText(sensor.lastReadingAt)}`
                          : <span className="settings-empty-value">None in the loaded window</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="settings-section-heading">
            <h3>Valve outputs</h3>
            <p>Identity is the driver board address and channel. It does not change when a hose is moved.</p>
          </div>
          {inventory.valves.length === 0 ? (
            <SettingsEmptyState title="No valve outputs reported">Valve outputs appear here once they are part of a pairing.</SettingsEmptyState>
          ) : (
            <div className="settings-table-wrap is-compact">
              <table className="settings-table">
                <thead>
                  <tr>
                    <th scope="col">Valve identity</th>
                    <th scope="col">Board</th>
                    <th scope="col">Channel</th>
                    <th scope="col">Assigned label</th>
                  </tr>
                </thead>
                <tbody>
                  {inventory.valves.map((valve) => (
                    <tr key={valve.identity}>
                      <td><code className="settings-identity">{valve.identity}</code></td>
                      <td>{valve.board ?? "—"}</td>
                      <td>{valve.channel ?? "—"}</td>
                      <td>{valve.label ?? "Unlabeled"}{valve.potNumber != null ? ` · Pot ${valve.potNumber}` : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="settings-section-heading">
            <h3>Valve driver boards</h3>
            <p>Reported by the controller.</p>
          </div>
          <div className="settings-list">
            {boardConfigs.length === 0 ? (
              <div className="settings-list-row">
                <span>No boards reported</span>
                <em>The controller has not sent its board list.</em>
              </div>
            ) : boardConfigs.map((config, index) => (
              <div className="settings-list-row" key={`${config.address}-${index}`}>
                <span>Board {index + 1}</span>
                <em>Address {config.address} · Reset pin {config.resetPin}</em>
              </div>
            ))}
          </div>
          {isAdmin ? (
            <>
              <div className="settings-section-heading">
                <h3>Administrator operations</h3>
                <p>Visible to administrators only.</p>
              </div>
              <QueuedChangeNote presence={presence} />
              <div className="settings-grid">
                <section className="settings-card">
                  <h3>Board configuration</h3>
                  <form className="settings-form" onSubmit={submitBoardConfig}>
                    <label>
                      Board addresses
                      <input value={boardAddresses} onChange={(event) => setBoardAddresses(event.target.value)} placeholder="0x20, 0x24, 0x26" required />
                    </label>
                    <label>
                      Reset pin
                      <input type="number" min="0" max="40" step="1" value={boardResetPin} onChange={(event) => setBoardResetPin(event.target.value)} required />
                    </label>
                    <label className="settings-check">
                      <input
                        type="checkbox"
                        checked={boardConfirm}
                        onChange={(event) => setBoardConfirm(event.target.checked)}
                      />
                      <span>Confirm board configuration change</span>
                    </label>
                    <button type="submit" className="settings-danger-button" disabled={controlBusy || !boardConfirm}>
                      Update board
                    </button>
                  </form>
                </section>
                <section className="settings-card">
                  <h3>Protected operations</h3>
                  <p className="settings-muted">Sensor initialization, board addresses, reset pins, credentials, firmware, and recovery stay administrator-only.</p>
                  <button type="button" className="settings-locked-button" disabled>
                    <Lock size={14} /> Sensor initialization locked
                  </button>
                </section>
              </div>
            </>
          ) : null}
        </>
      );
    }

    if (activeSection === "exports") {
      return (
        <>
          {commandStatusPanel}
          <div className="settings-grid">
            <section className="settings-card">
              <h3>Readings</h3>
              <p className="settings-muted">Download the readings currently loaded in the portal.</p>
              <button type="button" className="settings-secondary-button" onClick={onPrepareCsvDownload} disabled={exportingCsv || !csvReady}>
                <Download size={14} />
                {exportingCsv ? "Preparing..." : "Prepare readings CSV"}
              </button>
              {csvError ? <p className="settings-error-line">{csvError}</p> : null}
              {csvDownload ? (
                <a className="settings-download-link" href={csvDownload.url} download={csvDownload.filename}>
                  Download {csvDownload.rowCount.toLocaleString()} rows
                </a>
              ) : null}
            </section>
            <section className="settings-card">
              <h3>Configuration</h3>
              <p className="settings-muted">Download the pairings table, or the groups, sensors, valves, and calibrations last reported by the controller.</p>
              <button type="button" className="settings-secondary-button" onClick={onDownloadPairingsCsv}>
                <Download size={14} />
                Download pairings CSV
              </button>
              <div className="settings-inline-form">
                <label>
                  Data type
                  <select value={exportDataType} onChange={(event) => setExportDataType(event.target.value)}>
                    <option value="groups">Groups</option>
                    <option value="sensors">Sensors</option>
                    <option value="valves">Valves</option>
                    <option value="pairings">Pairings</option>
                    <option value="calibrations">Calibrations</option>
                    <option value="readings">Readings</option>
                  </select>
                </label>
                <button type="button" className="settings-secondary-button" onClick={() => void queueExportData()} disabled={controlBusy}>
                  Export data
                </button>
              </div>
            </section>
          </div>
        </>
      );
    }

    return null;
  };

  const selectSection = (section: SettingsSection) => {
    onSectionChange(section);
    setNavOpen(false);
  };

  return (
    <div className="settings-backdrop" role="dialog" aria-modal="true" aria-label={scope === "installation" ? "Installation settings" : `${experiment.name} settings`}>
      <section className={`settings-modal${navOpen ? " is-nav-open" : ""}`}>
        <div className="settings-mobile-bar">
          <button
            type="button"
            onClick={() => setNavOpen((current) => !current)}
            aria-expanded={navOpen}
            aria-controls="settings-sidebar"
          >
            {navOpen ? <X size={16} aria-hidden="true" /> : <Menu size={16} aria-hidden="true" />}
            Sections
          </button>
          <strong>{activeItem.label}</strong>
          <button type="button" onClick={onClose} aria-label="Close settings">
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        {navOpen ? <button type="button" className="settings-nav-scrim" aria-label="Close sections" onClick={() => setNavOpen(false)} /> : null}
        <aside className="settings-sidebar" id="settings-sidebar" aria-label="Settings sections">
          <button type="button" className="settings-back-button" onClick={onClose}>
            <ArrowLeft size={16} aria-hidden="true" />
            Back to portal
          </button>
          <nav>
            {availableSettingsNavGroups.map((group) => (
              <div className="settings-sidebar-group" key={group.label}>
                <p className="settings-sidebar-group-label">{scope === "installation" && group.label === "Experiment" ? "Controller" : group.label}</p>
                {group.items.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      className={item.id === activeItem.id ? "is-active" : ""}
                      aria-current={item.id === activeItem.id ? "page" : undefined}
                      onClick={() => selectSection(item.id)}
                    >
                      <span>
                        <strong>{item.label}</strong>
                      </span>
                    </button>
                ))}
              </div>
            ))}
          </nav>
          <div className="settings-account-actions">
            <button type="button" className="settings-sign-out-button" onClick={onSignOut}>
              <LogOut size={16} aria-hidden="true" />
              Sign out
            </button>
          </div>
        </aside>
        <section className={`settings-content is-${activeSection}`}>
          <header className="settings-content-header">
            <div>
              <p className="settings-content-eyebrow">{scope === "installation" ? "Installation settings" : `${experiment.name} · Experiment settings`}</p>
              <h2>{activeSection === "assistant" ? "Settings assistant" : activeItem.label}</h2>
              <p className="settings-content-lede">
                {activeSection === "assistant"
                  ? "Describe a settings change in plain language, then review it before anything is queued."
                  : activeSection === "overview" ? (scope === "installation" ? "Status and configuration for every pot on this controller." : "The saved plan and records for this experiment.") : activeItem.description}
              </p>
            </div>
            <div className="settings-content-actions">
              {scope === "installation" ? <StatusChip tone={presence.tone}>{controllerPillText(presence)}</StatusChip> : null}
            </div>
          </header>
          <div className="settings-section-body">
            {renderSection()}
          </div>
        </section>
      </section>
    </div>
  );
}
