import { useCallback,useEffect,useRef,useState } from "react";
import { isCommandStatus,settingsBatchCommandType,type TrackedCommand,trackedCommandProgress } from "./commandLifecycle";
import { supabaseQueryTimeoutMs } from "./portalConstants";
import { controlCommandLabel,errorMessage,functionErrorMessage,runtimeStateIsFresh } from "./portalFormat";
import { adminOnlyControlCommandTypes,type ControlCommandResponse,type DeviceConfigState,type DeviceRuntimeState,type QueueControlCommand,type QueueSettingsPlan } from "./portalTypes";
import { downloadJsonFile } from "./readingsExport";
import { type SettingsCommandDraft,stoppedSettingsCommandTypes } from "./settingsSpec";
import { supabase } from "./supabase";
import { withSupabaseTimeout } from "./supabaseTimeout";
import { scheduleVisiblePolling } from "./visiblePolling";

const trackedCommandPollMs = 15_000;

const trackedCommandPollLimitMs = 15 * 60_000;

/** ControllerCommands owns this workspace behavior; App supplies the current scope. */
type Context = {
  canUseExperimentSettings: boolean;
  activeProjectId: string;
  activeDeviceId: string;
  isAdmin: boolean;
  prepareCsvDownload: () => Promise<void>;
  downloadPairingsCsv: () => void;
  configState: DeviceConfigState | null;
  runtimeState: DeviceRuntimeState | null;
  sessionReady: boolean;
  loadExperimentCatalog: () => Promise<void>;
};

export function useControllerCommands({ canUseExperimentSettings, activeProjectId, activeDeviceId, isAdmin, prepareCsvDownload, downloadPairingsCsv, configState, runtimeState, sessionReady, loadExperimentCatalog }: Context) {
  const [controlBusy, setControlBusy] = useState(false);

  const [controlNotice, setControlNotice] = useState<string | null>(null);

  const [trackedCommand, setTrackedCommand] = useState<TrackedCommand | null>(null);

  const [controlError, setControlError] = useState<string | null>(null);

  const controlRequestIdsRef = useRef(new Map<string, { id: string; createdAt: number }>());

  const settingsBatchIdsRef = useRef(new Map<string, {
    batchId: string;
    commandIds: string[];
    createdAt: number;
  }>());

  const sendSingleControlCommand = useCallback<QueueControlCommand>(
    async (commandType, payload, options) => {
      if (!canUseExperimentSettings || !activeProjectId || !activeDeviceId) {
        setControlError("Experiment settings access is required for portal controls.");
        return;
      }
      if (!isAdmin && adminOnlyControlCommandTypes.has(commandType)) {
        setControlError("Administrator access is required for this controller command.");
        return;
      }

      setControlBusy(true);
      setControlNotice(null);
      setControlError(null);
      setTrackedCommand(null);

      const requestKey = JSON.stringify([commandType, payload, options?.confirm === true]);
      const nowMs = Date.now();
      for (const [key, entry] of controlRequestIdsRef.current) {
        if (nowMs - entry.createdAt > 10 * 60 * 1000) controlRequestIdsRef.current.delete(key);
      }
      const existingRequest = controlRequestIdsRef.current.get(requestKey);
      const clientRequestId = existingRequest?.id ?? crypto.randomUUID();
      controlRequestIdsRef.current.set(requestKey, { id: clientRequestId, createdAt: nowMs });

      try {
        const response = await withSupabaseTimeout(
          (signal) => supabase.functions.invoke<ControlCommandResponse>("create-control-command", {
            body: {
              project_id: activeProjectId,
              device_id: activeDeviceId,
              client_request_id: clientRequestId,
              command_type: commandType,
              payload,
              confirm: options?.confirm === true,
              operation_intent: options?.operationIntent,
            },
            signal,
          }),
          supabaseQueryTimeoutMs,
          "Control command",
        );

        if (response.error) {
          throw new Error(await functionErrorMessage(response.error));
        }

        controlRequestIdsRef.current.delete(requestKey);
        const command = response.data?.command;
        if (command?.id) {
          setTrackedCommand({
            ids: [command.id],
            label: controlCommandLabel(commandType),
            commandType,
            requestedAt: command.requested_at ?? new Date().toISOString(),
            statuses: { [command.id]: isCommandStatus(command.status) ? command.status : undefined },
          });
        } else {
          setControlNotice(`${controlCommandLabel(commandType)} requested`);
        }
      } catch (err) {
        try {
          const reconciliation = await withSupabaseTimeout(
            supabase
              .from("project_control_commands")
              .select("id,status,requested_at")
              .eq("project_id", activeProjectId)
              .eq("client_request_id", clientRequestId)
              .maybeSingle(),
            supabaseQueryTimeoutMs,
            "Control command reconciliation",
          );
          if (!reconciliation.error && reconciliation.data?.id) {
            controlRequestIdsRef.current.delete(requestKey);
            const recorded = reconciliation.data as { id: string; status?: unknown; requested_at?: string };
            setTrackedCommand({
              ids: [recorded.id],
              label: controlCommandLabel(commandType),
              commandType,
              requestedAt: recorded.requested_at ?? new Date().toISOString(),
              statuses: { [recorded.id]: isCommandStatus(recorded.status) ? recorded.status : undefined },
            });
          } else {
            setControlError(`${errorMessage(err)} Safe to retry; the same request ID will be reused.`);
          }
        } catch {
          setControlError(`${errorMessage(err)} Safe to retry; the same request ID will be reused.`);
        }
      } finally {
        setControlBusy(false);
      }
    },
    [
      activeDeviceId,
      activeProjectId,
      canUseExperimentSettings,
      isAdmin,
    ],
  );

  const queueSettingsPlan: QueueSettingsPlan = async (plan, reviewedConfigHash) => {
      if (!canUseExperimentSettings || !activeProjectId || !activeDeviceId) {
        setControlError("Experiment settings access is required for portal controls.");
        return null;
      }
      if (!plan.commands.length || plan.questions.length) {
        setControlError("Resolve the request before applying settings.");
        return null;
      }
      for (const command of plan.commands) {
        if (!isAdmin && adminOnlyControlCommandTypes.has(command.command_type)) {
          setControlError("Administrator access is required for this controller command.");
          return null;
        }
      }

      const directCommands = plan.commands.filter(
        (command) => !stoppedSettingsCommandTypes.has(command.command_type),
      );
      if (directCommands.length) {
        if (plan.commands.length !== 1) {
          setControlError("System-state and export requests must be reviewed separately.");
          return null;
        }
        const direct = directCommands[0];
        if (direct.command_type === "export_data") {
          const dataType = String(direct.payload.data_type ?? "");
          if (dataType === "readings") {
            await prepareCsvDownload();
          } else if (dataType === "pairings") {
            downloadPairingsCsv();
          } else {
            const synchronized: Record<string, unknown> = {
              groups: configState?.groups ?? [],
              sensors: configState?.sensors ?? [],
              valves: configState?.valves ?? [],
              calibrations: configState?.calibrations ?? [],
            };
            downloadJsonFile(dataType, synchronized[dataType] ?? []);
          }
          setControlNotice("Export ready");
          return null;
        }
        await sendSingleControlCommand(
          direct.command_type,
          direct.payload,
          {
            confirm: direct.command_type === "update_system_state",
            operationIntent: plan.summary,
          },
        );
        return null;
      }

      setControlBusy(true);
      setControlNotice(null);
      setControlError(null);
      setTrackedCommand(null);

      const reviewedControllerState = runtimeState?.controller_state?.trim().toLowerCase();
      if (
        !runtimeStateIsFresh(runtimeState) ||
        (reviewedControllerState !== "running" && reviewedControllerState !== "stopped")
      ) {
        setControlBusy(false);
        setControlError("Current controller state is unavailable or stale. Refresh and review again.");
        return null;
      }

      const requestKey = JSON.stringify([
        reviewedConfigHash,
        reviewedControllerState,
        plan.commands.map((command) => [command.command_type, command.payload]),
      ]);
      const nowMs = Date.now();
      for (const [key, entry] of settingsBatchIdsRef.current) {
        if (nowMs - entry.createdAt > 10 * 60 * 1000) settingsBatchIdsRef.current.delete(key);
      }
      const existing = settingsBatchIdsRef.current.get(requestKey);
      const batchId = existing?.batchId ?? crypto.randomUUID();
      const commandIds = existing?.commandIds ?? Array.from(
        { length: plan.commands.length + 2 },
        () => crypto.randomUUID(),
      );
      settingsBatchIdsRef.current.set(requestKey, { batchId, commandIds, createdAt: nowMs });
      const batchTracking = {
        label: "Reviewed settings",
        commandType: settingsBatchCommandType,
        stepLabels: [
          "Stop controller",
          ...plan.commands.map((command) => controlCommandLabel(command.command_type)),
          reviewedControllerState === "running" ? "Restart controller" : "Leave controller stopped",
        ],
        restoresTo: reviewedControllerState,
      };

      const batchCommands = [
        {
          client_request_id: commandIds[0],
          command_type: "update_system_state",
          payload: { state: "stopped", reason: `Apply reviewed settings: ${plan.summary}` },
          confirm: true,
        },
        ...plan.commands.map((command, index) => ({
          client_request_id: commandIds[index + 1],
          command_type: command.command_type,
          payload: command.payload,
          confirm: true,
        })),
        {
          client_request_id: commandIds[commandIds.length - 1],
          command_type: "update_system_state",
          payload: {
            state: reviewedControllerState,
            reason: `Restore reviewed state after settings: ${plan.summary}`,
          },
          confirm: true,
        },
      ];

      try {
        const response = await withSupabaseTimeout(
          (signal) => supabase.functions.invoke<ControlCommandResponse>("create-control-command", {
            body: {
              project_id: activeProjectId,
              device_id: activeDeviceId,
              client_request_id: commandIds[0],
              batch_id: batchId,
              expected_config_hash: reviewedConfigHash,
              expected_controller_state: reviewedControllerState,
              batch_commands: batchCommands,
              operation_intent: plan.summary,
              ...(/^Autocalibrat/i.test(plan.summary) ? { workflow: "autocalibration" } : {}),
            },
            signal,
          }),
          supabaseQueryTimeoutMs,
          "Settings batch",
        );
        if (response.error) throw new Error(await functionErrorMessage(response.error));
        if (!response.data?.commands?.length) throw new Error("The complete settings batch was not accepted.");
        settingsBatchIdsRef.current.delete(requestKey);
        const commands = response.data.commands;
        setTrackedCommand({
          ...batchTracking,
          ids: commands.map((command) => command.id),
          requestedAt: new Date().toISOString(),
          statuses: Object.fromEntries(commands.map((command) => [command.id, isCommandStatus(command.status) ? command.status : undefined])),
        });
        return { batchId, commandIds: commands.map((command) => command.id) };
      } catch (nextError) {
        try {
          const reconciliation = await withSupabaseTimeout(
            supabase
              .from("project_control_commands")
              .select("id,status,client_request_id")
              .eq("project_id", activeProjectId)
              .eq("batch_id", batchId),
            supabaseQueryTimeoutMs,
            "Settings batch reconciliation",
          );
          if (
            !reconciliation.error &&
            (reconciliation.data?.length ?? 0) === batchCommands.length
          ) {
            settingsBatchIdsRef.current.delete(requestKey);
            // Steps are tracked in execution order (stop, change(s), restore): the order the IDs were issued in.
            const recorded = ((reconciliation.data ?? []) as Array<{ id: string; status?: unknown; client_request_id?: string }>)
              .slice()
              .sort((a, b) => commandIds.indexOf(a.client_request_id ?? "") - commandIds.indexOf(b.client_request_id ?? ""));
            setTrackedCommand({
              ...batchTracking,
              ids: recorded.map((command) => command.id),
              requestedAt: new Date().toISOString(),
              statuses: Object.fromEntries(recorded.map((command) => [command.id, isCommandStatus(command.status) ? command.status : undefined])),
            });
            return { batchId, commandIds: recorded.map((command) => command.id) };
          } else {
            setControlError(`${errorMessage(nextError)} Safe to retry; the same batch IDs will be reused.`);
          }
        } catch {
          setControlError(`${errorMessage(nextError)} Safe to retry; the same batch IDs will be reused.`);
        }
      } finally {
        setControlBusy(false);
      }
      return null;
  };

  const queueControlCommand: QueueControlCommand = async (commandType, payload, options) => {
      if (stoppedSettingsCommandTypes.has(commandType as SettingsCommandDraft["command_type"])) {
        const configHash = configState?.config_hash?.trim();
        if (!configHash) {
          setControlError("Current controller configuration is unavailable. Refresh and try again.");
          return;
        }
        await queueSettingsPlan({
          summary: controlCommandLabel(commandType),
          commands: [{
            command_type: commandType as SettingsCommandDraft["command_type"],
            payload,
            effect: controlCommandLabel(commandType),
          }],
          questions: [],
        }, configHash);
        return;
      }
      await sendSingleControlCommand(commandType, payload, options);
  };

  const trackedCommandIds = trackedCommand?.ids.join(",") ?? "";

  const trackedCommandSettled = trackedCommand
    ? trackedCommand.trackingStopped === true || trackedCommandProgress(trackedCommand, true).terminal
    : true;

  useEffect(() => {
    // Backstop for a missed realtime update: re-read the tracked commands until they finish.
    if (!sessionReady || !activeProjectId || !trackedCommandIds || trackedCommandSettled) return undefined;
    const ids = trackedCommandIds.split(",");
    const startedAt = Date.now();
    return scheduleVisiblePolling(async () => {
      if (Date.now() - startedAt > trackedCommandPollLimitMs) {
        // Say so rather than leaving an unfinished stage on screen indefinitely.
        setTrackedCommand((current) => current && current.ids.join(",") === trackedCommandIds
          ? { ...current, trackingStopped: true }
          : current);
        return;
      }
      const response = await withSupabaseTimeout(
        supabase.from("project_control_commands").select("id,status").eq("project_id", activeProjectId).in("id", ids),
        supabaseQueryTimeoutMs,
        "Command status",
      );
      if (response.error || !response.data) return;
      const rows = response.data as Array<{ id: string; status?: unknown }>;
      setTrackedCommand((current) => {
        if (!current || current.ids.join(",") !== trackedCommandIds) return current;
        const statuses = { ...current.statuses };
        for (const row of rows) if (isCommandStatus(row.status)) statuses[row.id] = row.status;
        return { ...current, statuses };
      });
    }, trackedCommandPollMs);
  }, [activeProjectId, sessionReady, trackedCommandIds, trackedCommandSettled]);

  useEffect(() => {
    if (!sessionReady || !canUseExperimentSettings || !activeProjectId) return undefined;

    const channel = supabase
      .channel(`exacth2o-control-activity-live-${activeProjectId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "project_control_commands",
          filter: `project_id=eq.${activeProjectId}`,
        },
        (payload) => {
          const row = payload.new as { id?: string; status?: unknown } | null;
          if (row?.id && isCommandStatus(row.status)) {
            const status = row.status;
            setTrackedCommand((current) => current && current.ids.includes(row.id as string)
              ? { ...current, statuses: { ...current.statuses, [row.id as string]: status } }
              : current);
          }
          void loadExperimentCatalog();
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [
    canUseExperimentSettings,
    activeProjectId,
    loadExperimentCatalog,
    sessionReady,
  ]);

  return { controlBusy, setControlBusy, controlNotice, setControlNotice, trackedCommand, setTrackedCommand, controlError, setControlError, queueSettingsPlan, queueControlCommand };
}
