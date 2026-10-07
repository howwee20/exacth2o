import { AlertTriangle, ArrowLeft, ArrowRight, CheckCircle2, Clock3, Download, Lock, LogOut, Menu, Radar, X } from "lucide-react";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import { CalibrationStudio } from "../CalibrationStudio";
import { Commissioning } from "../Commissioning";
import { SettingsAssistant } from "../SettingsAssistant";
import { CopyableId, QueuedChangeNote, ReadinessTile, SettingsEmptyState, StatusChip } from "../SettingsChrome";
import { isObservationOnlyExperiment, type PortalExperiment } from "../experimentRegistry";
import { type PortalRole } from "../portalAccess";
import { boardConfigsFromPayload, formatIntervalFromMs, formatSecondsFromMs, formatSettingsTimestamp, formatTargetVwc, numberInputString, pairingGroupName, runtimeStateIsFresh, syncedCount } from "../portalFormat";
import { type CsvDownload, type DeviceConfigState, type DeviceRuntimeState, type LoadState, type QueueControlCommand, type QueueSettingsPlan, type SettingsNavItem, type SettingsSection } from "../portalTypes";
import { downloadJsonFile } from "../readingsExport";
import { type CommandProgress, type CommandStage } from "../commandLifecycle";
import { controllerPillText, controllerPresence, hardwareInventory, overviewNextAction, relativeAgeText, sensorsReportingText } from "../settingsPresentation";
import { type PairingRow } from "../types";

export const settingsNavItems: SettingsNavItem[] = [
  {
    id: "overview",
    label: "Overview",
    description: "Whether this experiment is ready, and the next useful thing to do.",
    group: "Experiment",
  },
  {
    id: "water",
    label: "Watering",
    description: "Start or stop the experiment and see the target each group is held to. You choose the targets; calibration only measures how each pot responds.",
    group: "Experiment",
  },
  {
    id: "pairings",
    label: "Pairings",
    description: "Which valve waters which pot, and the target, pulse, and check interval each pot runs with.",
    group: "Set up",
  },
  {
    id: "autocalibrate",
    label: "Autocalibrate",
    description: "Pulses one valve at a time and watches every sensor to find out which valve waters which pot. Nothing changes until you review it.",
    group: "Set up",
  },
  {
    id: "calibrations",
    label: "Sensor calibration",
    description: "Fit a sensor's raw signal to reference water-content measurements.",
    group: "Set up",
  },
  {
    id: "groups",
    label: "Groups",
    description: "Plant groups used for targets, charts, and exports.",
    group: "Set up",
  },
  {
    id: "exports",
    label: "Exports",
    description: "Download readings and configuration files.",
    group: "Data",
  },
  {
    id: "hardware",
    label: "Hardware",
    description: "The sensors and valve outputs this installation reports. Identity comes from the hardware; labels come from people.",
    group: "Advanced",
  },
];

export type PortalSettingsPanelProps = {
  open: boolean;
  projectId: string;
  portalRole: PortalRole;
  experiment: PortalExperiment;
  activeSection: SettingsSection;
  data: LoadState;
  runtimeState: DeviceRuntimeState | null;
  configState: DeviceConfigState | null;
  pairings: PairingRow[];
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
  projectId,
  portalRole,
  experiment,
  activeSection,
  data,
  runtimeState,
  configState,
  pairings,
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
  // Autocalibrate commissions the installation, not one experiment's watering, so it
  // stays available when an experiment is sensing-only. It is administrator-only.
  const availableSettingsNavItems = (isObservationOnlyExperiment(experiment)
    ? settingsNavItems.filter((item) => ["overview", "autocalibrate", "calibrations", "exports"].includes(item.id))
    : settingsNavItems
  ).filter((item) => item.id !== "autocalibrate" || isAdmin);
  const availableSettingsNavGroups = Array.from(
    availableSettingsNavItems.reduce((groups, item) => {
      groups.set(item.group, [...(groups.get(item.group) ?? []), item]);
      return groups;
    }, new Map<SettingsNavItem["group"], SettingsNavItem[]>()),
    ([label, items]) => ({ label, items }),
  );
  const activeItem = availableSettingsNavItems.find((item) => item.id === activeSection) ?? availableSettingsNavItems[0];
  const boardConfigs = boardConfigsFromPayload(data.latestState?.latest_payload);
  const mirroredBoardCount = configState?.board_count ?? boardConfigs.length;
  const uniqueSensors = new Set(pairings.map((pairing) => pairing.sensor_key).filter(Boolean));
  const uniqueValves = new Set(pairings.map((pairing) => pairing.valve_key).filter(Boolean));
  const projectGroups = Array.from(
    pairings.reduce((groups, pairing) => {
      const label = pairingGroupName(pairing);
      groups.set(label, [...(groups.get(label) ?? []), pairing]);
      return groups;
    }, new Map<string, PairingRow[]>()),
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
  const [bulkTarget, setBulkTarget] = useState("20");
  const [bulkOpenSeconds, setBulkOpenSeconds] = useState("5");
  const [bulkIntervalSeconds, setBulkIntervalSeconds] = useState("600");
  const [singlePairingName, setSinglePairingName] = useState(pairings[0]?.name ?? "");
  const [singleNewName, setSingleNewName] = useState(pairings[0]?.name ?? "");
  const [singleGroupName, setSingleGroupName] = useState(pairings[0] ? pairingGroupName(pairings[0]) : "");
  const [deletePairingConfirm, setDeletePairingConfirm] = useState(false);
  const [singleTarget, setSingleTarget] = useState(pairings[0] ? numberInputString(pairings[0].wtc_percent_limit) : "20");
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
  const [manualGroup, setManualGroup] = useState("all");
  const [manualSeconds, setManualSeconds] = useState("5");
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

  useEffect(() => {
    if (!open || !selectedPairing) return;
    setSingleTarget(numberInputString(selectedPairing.wtc_percent_limit));
    setSingleOpenSeconds(numberInputString(selectedPairing.valve_open_time_ms / 1000));
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
      target_vwc: parseNumber(bulkTarget),
      open_time_seconds: parseNumber(bulkOpenSeconds),
      measurement_interval_seconds: parseNumber(bulkIntervalSeconds),
    });
  }

  async function submitSinglePairingUpdate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await onQueueCommand("update_pairing", {
      pairing_name: selectedPairing?.name ?? singlePairingName,
      new_name: singleNewName,
      group_name: singleGroupName,
      target_vwc: parseNumber(singleTarget),
      open_time_seconds: parseNumber(singleOpenSeconds),
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
      open_time_seconds: parseNumber(bulkOpenSeconds),
      measurement_interval_seconds: parseNumber(bulkIntervalSeconds),
    });
  }

  async function submitManualWater(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await onQueueCommand("manual_water", {
      pairing_names: pairingNamesForGroup(manualGroup),
      duration_seconds: parseNumber(manualSeconds),
    }, { confirm: true });
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
      group_name: removeGroupName || groupName,
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
              {commandStageLabels.map(([stage, label]) => (
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
            {controllerIsLive ? null : <p>Queued only. The controller is offline, so this has not taken effect. It applies after the controller reconnects and confirms it.</p>}
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
    if (activeSection === "overview") {
      const wateringEnabled = runtimeState?.watering_enabled ?? null;
      const sensingOnly = isObservationOnlyExperiment(experiment);
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
          <section className={`settings-next-step is-${next.tone}`} aria-label="Next step">
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
          </section>
          <div className="settings-readiness-grid">
            <ReadinessTile
              title="Experiment"
              tone={!presence.controllerState ? "unknown" : controllerIsLive ? (presence.controllerState === "Running" ? "ok" : "warning") : "unknown"}
              status={presence.controllerState ? `${presence.controllerState}${lastKnown}` : "Not reported"}
              lines={[
                { label: "Pots", value: pairings.length },
                { label: "Plant groups", value: projectGroups.length },
              ]}
            />
            <ReadinessTile
              title="Watering"
              tone={sensingOnly ? "info" : wateringEnabled == null || !controllerIsLive ? "unknown" : wateringEnabled ? "ok" : "warning"}
              status={sensingOnly ? "Sensing only" : wateringEnabled == null ? "Not reported" : `${wateringEnabled ? "Automatic" : "Off"}${lastKnown}`}
              lines={[
                { label: "Last watering", value: when(runtimeState?.watering_last_event_at, "None recorded") },
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
              actionLabel={canOpen("pairings") ? "Open Pairings" : isAdmin && canOpen("autocalibrate") ? "Open Autocalibrate" : undefined}
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
              These pairings were entered by hand and have not been checked at the bench.
              {isAdmin ? " Autocalibrate can check them; this table only changes after you review and apply its result." : ""}
            </p>
            <div className="settings-toolbar-actions">
              {isAdmin ? (
                <button type="button" className="settings-secondary-button" onClick={() => onSectionChange("autocalibrate")}>
                  <Radar size={14} aria-hidden="true" />
                  Check with Autocalibrate
                </button>
              ) : null}
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
                    Target VWC %
                    <input type="number" min="0" max="80" step="0.1" value={singleTarget} onChange={(event) => setSingleTarget(event.target.value)} required />
                  </label>
                  <label>
                    Pulse length (sec)
                    <input type="number" min="1" max="120" step="1" value={singleOpenSeconds} onChange={(event) => setSingleOpenSeconds(event.target.value)} required />
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
                    Target VWC %
                    <input type="number" min="0" max="80" step="0.1" value={bulkTarget} onChange={(event) => setBulkTarget(event.target.value)} required />
                  </label>
                  <label>
                    Pulse length (sec)
                    <input type="number" min="1" max="120" step="1" value={bulkOpenSeconds} onChange={(event) => setBulkOpenSeconds(event.target.value)} required />
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
      // Real hardware commissioning. Pulses go through the control-command service;
      // pairing changes go through the same reviewed settings batch as the rest of Settings.
      return (
        <>
          {commandStatusPanel}
          <Commissioning
            projectId={projectId}
            deviceId={data.latestState?.device_id ?? runtimeState?.device_id ?? configState?.device_id ?? null}
            operator={operatorEmail}
            portalRole={portalRole}
            experimentId={experiment.id}
            experimentName={experiment.name}
            pairings={pairings}
            configHash={configState?.config_hash?.trim() || null}
            controlBusy={controlBusy}
            controllerOnline={controllerIsLive}
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
          <p className="settings-principle">
            <strong>You choose the targets.</strong> Calibration and Autocalibrate only measure how each pot responds to
            water; they never pick a biological target for you.
          </p>
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
                      <strong>{targets.join(", ")}</strong>
                    </div>
                  );
                })}
              </div>
            </section>
            <section className="settings-card">
              <h3>Manual watering</h3>
              <form className="settings-form" onSubmit={submitManualWater}>
                <label>
                  Group
                  <select value={manualGroup} onChange={(event) => setManualGroup(event.target.value)}>
                    {groupOptions.map((group) => (
                      <option value={group.value} key={group.value}>
                        {group.label} ({group.pairings.length})
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Duration seconds
                  <input type="number" min="1" max="60" step="1" value={manualSeconds} onChange={(event) => setManualSeconds(event.target.value)} required />
                </label>
                <button type="submit" className="settings-primary-button" disabled title="Manual watering requires the physical valve fail-safe check">
                  Manual watering locked
                </button>
              </form>
              <p className="settings-muted">Targets and automatic watering settings are live. A bounded manual pulse unlocks only after the physical valve-close check.</p>
            </section>
            <section className="settings-card">
              <h3>Pulse and safety limits</h3>
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
              <p className="settings-muted">The controller waters in short pulses, then waits and measures again before deciding whether to pulse again. Per-pot pulse length and check interval are set under Pairings.</p>
            </section>
            <section className="settings-card">
              <h3>Experiment state</h3>
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
                <span>Confirm experiment stop</span>
              </label>
              <div className="settings-action-stack">
                <button type="button" onClick={() => void queueSystemState("running")} disabled={controlBusy}>
                  <CheckCircle2 size={14} /> Start experiment
                </button>
                <button type="button" onClick={() => void queueSystemState("stopped")} disabled={controlBusy || !destructiveConfirm}>
                  <AlertTriangle size={14} /> Stop experiment
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
                    <option value="">Type custom group above</option>
                    {groupOptions.filter((group) => group.value !== "all").map((group) => (
                      <option value={group.label} key={group.value}>{group.label}</option>
                    ))}
                  </select>
                </label>
                <button type="submit" className="settings-danger-button" disabled={controlBusy || (!removeGroupName && !groupName)}>
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
                    <strong>{group.pairings.map((pairing) => pairing.pot_number).join(", ")}</strong>
                  </div>
                  <div className="settings-row">
                    <span>Count</span>
                    <strong>{group.pairings.length}</strong>
                  </div>
                  <div className="settings-row">
                    <span>Targets</span>
                    <strong>{Array.from(new Set(group.pairings.map((pairing) => formatTargetVwc(pairing.wtc_percent_limit)))).join(", ")}</strong>
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
              <p className="settings-muted">Downloads the clean readings currently loaded in the portal.</p>
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
    <div className="settings-backdrop" role="dialog" aria-modal="true" aria-label="Portal settings">
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
                <p className="settings-sidebar-group-label">{group.label}</p>
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
              <p className="settings-content-eyebrow">{activeSection === "assistant" ? "Assistant" : activeItem.group}</p>
              <h2>{activeSection === "assistant" ? "Settings assistant" : activeItem.label}</h2>
              <p className="settings-content-lede">
                {activeSection === "assistant"
                  ? "Describe a settings change in plain language, then review it before anything is queued."
                  : activeItem.description}
              </p>
            </div>
            <div className="settings-content-actions">
              <StatusChip tone={presence.tone}>{controllerPillText(presence)}</StatusChip>
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
