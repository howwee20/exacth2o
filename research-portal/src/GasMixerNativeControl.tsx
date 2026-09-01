import { AlertTriangle, Loader2, SlidersHorizontal } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  applyGasMixerNativeField,
  cloneGasMixerNativeState,
  formatGasMixerNativeValue,
  gasFormulaLabel,
  gasMixerNativeDisplayOrder,
  gasMixerNativeFieldSpec,
  initialGasMixerNativeState,
  type GasMixerNativeAddress,
  type GasMixerNativeField,
  type GasMixerNativeMachineState,
  type GasMixerNativeStatus,
} from "./gasMixerNative";
import {
  loadGasMixerNativeStatus,
  sendGasMixerNativeField,
} from "./gasMixerNativeClient";

type FieldPhase = "idle" | "sending" | "confirmed" | "failed";

function NativeNumberInput({
  field,
  value,
  unit,
  ready,
  phase,
  onChange,
  onCommit,
}: {
  field: GasMixerNativeField;
  value: number;
  unit: "%" | "PPM" | "SLPM" | "SCCM";
  ready: boolean;
  phase: FieldPhase;
  onChange: (value: number) => void;
  onCommit: () => void;
}) {
  const spec = gasMixerNativeFieldSpec(field);
  return (
    <input
      className={`native-mixer-number is-${phase}`}
      type="number"
      aria-label={`${field} ${unit}`}
      min={spec.min}
      max={spec.max}
      step={spec.step}
      value={value}
      readOnly={!ready}
      inputMode="decimal"
      onFocus={(event) => event.currentTarget.select()}
      onChange={(event) => onChange(Number(event.currentTarget.value))}
      onKeyDown={(event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        onCommit();
        event.currentTarget.select();
      }}
    />
  );
}

function NativeMfcCard({
  address,
  draft,
  observed,
  ready,
  fieldPhase,
  onDraft,
  onCommit,
}: {
  address: GasMixerNativeAddress;
  draft: GasMixerNativeMachineState;
  observed: GasMixerNativeMachineState;
  ready: boolean;
  fieldPhase: Record<string, FieldPhase>;
  onDraft: (field: GasMixerNativeField, value: number) => void;
  onCommit: (field: GasMixerNativeField) => void;
}) {
  const channel = draft.channels[address];
  const observedChannel = observed.channels[address];
  const ratioField = `mfc.${address}.ratio` as GasMixerNativeField;
  const setpointField = `mfc.${address}.setpoint` as GasMixerNativeField;
  const canEdit = ready && !channel.balance && observedChannel.available;
  return (
    <section className={`native-mfc-card ${observedChannel.available ? "" : "is-unavailable"}`}>
      <header><strong>{gasFormulaLabel(channel.formula)}</strong><span>{address}</span></header>
      <label>
        <span>{channel.ratio_unit}</span>
        {channel.balance ? (
          <output>{formatGasMixerNativeValue(channel.ratio, channel.ratio_unit)}</output>
        ) : (
          <NativeNumberInput
            field={ratioField}
            value={channel.ratio}
            unit={channel.ratio_unit}
            ready={canEdit}
            phase={fieldPhase[ratioField] ?? "idle"}
            onChange={(value) => onDraft(ratioField, value)}
            onCommit={() => onCommit(ratioField)}
          />
        )}
      </label>
      <label>
        <span>{channel.flow_unit}</span>
        {channel.balance ? (
          <output>{formatGasMixerNativeValue(channel.setpoint, channel.flow_unit)}</output>
        ) : (
          <NativeNumberInput
            field={setpointField}
            value={channel.setpoint}
            unit={channel.flow_unit}
            ready={canEdit}
            phase={fieldPhase[setpointField] ?? "idle"}
            onChange={(value) => onDraft(setpointField, value)}
            onCommit={() => onCommit(setpointField)}
          />
        )}
      </label>
      <label>
        <span>{channel.flow_unit}</span>
        <output className={observedChannel.flow_error ? "is-error" : "is-delivered"}>
          {formatGasMixerNativeValue(observedChannel.delivered, channel.flow_unit)}
        </output>
      </label>
    </section>
  );
}

export function GasMixerNativeControl() {
  const fallback = useMemo(() => initialGasMixerNativeState(), []);
  const [status, setStatus] = useState<GasMixerNativeStatus | null>(null);
  const [draft, setDraft] = useState<GasMixerNativeMachineState>(() => cloneGasMixerNativeState(fallback));
  const [fieldPhase, setFieldPhase] = useState<Record<string, FieldPhase>>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const dirtyFields = useRef(new Set<GasMixerNativeField>());
  const pendingCommands = useRef(new Map<GasMixerNativeField, string>());
  const initialized = useRef(false);

  useEffect(() => {
    let active = true;
    const refresh = () => {
      loadGasMixerNativeStatus()
        .then((next) => {
          if (!active) return;
          setStatus(next);
          if (!initialized.current || dirtyFields.current.size === 0) {
            setDraft(cloneGasMixerNativeState(next.requested_state));
            initialized.current = true;
          }
          let commandError: string | null = null;
          if (next.last_command?.field &&
              pendingCommands.current.get(next.last_command.field) === next.last_command.id) {
            const commandField = next.last_command.field;
            if (next.last_command.status === "verified") {
              pendingCommands.current.delete(commandField);
              dirtyFields.current.delete(commandField);
              setFieldPhase((current) => ({ ...current, [commandField]: "confirmed" }));
            } else if (["rejected", "failed", "expired"].includes(next.last_command.status)) {
              pendingCommands.current.delete(commandField);
              dirtyFields.current.delete(commandField);
              setFieldPhase((current) => ({ ...current, [commandField]: "failed" }));
              commandError = next.last_command.error_message ?? "The mixer rejected that value";
            }
          }
          setError(commandError);
        })
        .catch((reason) => {
          if (!active) return;
          setError(reason instanceof Error ? reason.message : "Native mixer state is unavailable");
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    };
    refresh();
    const timer = window.setInterval(refresh, 1_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  const ready = status?.bridge_ready === true && status.remote_control_allowed;
  const applied = status?.applied_state ?? fallback;
  const observed = status?.observed_state ?? fallback;

  const updateDraft = (field: GasMixerNativeField, value: number | boolean) => {
    try {
      setDraft((current) => applyGasMixerNativeField(current, field, value));
      dirtyFields.current.add(field);
      setFieldPhase((current) => ({ ...current, [field]: "idle" }));
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Invalid mixer value");
    }
  };

  const commitField = async (field: GasMixerNativeField, explicitValue?: number | boolean) => {
    if (!status || !ready) return;
    const value = explicitValue ?? (field === "use_licor"
      ? draft.use_licor
      : field === "total_slpm"
        ? draft.total_slpm
        : (() => {
            const [, address, property] = field.split(".") as ["mfc", GasMixerNativeAddress, "ratio" | "setpoint"];
            return draft.channels[address][property];
          })());
    setFieldPhase((current) => ({ ...current, [field]: "sending" }));
    try {
      const response = await sendGasMixerNativeField(field, value, status.state_revision);
      pendingCommands.current.set(field, response.command.id);
      setFieldPhase((current) => ({ ...current, [field]: "sending" }));
      setError(null);
    } catch (reason) {
      setFieldPhase((current) => ({ ...current, [field]: "failed" }));
      setError(reason instanceof Error ? reason.message : "Unable to send mixer value");
    }
  };

  return (
    <section className="chamber-module is-gas-mixer-native">
      <header>
        <span className="chamber-module-icon"><SlidersHorizontal size={21} /></span>
        <div><h2>Gas Mixer V2</h2></div>
        <span className={`chamber-status ${ready ? "is-online" : "is-offline"}`}>
          {loading ? "Checking" : ready ? "Ready" : "Commissioning"}
        </span>
      </header>

      <div className="native-mixer-panel">
        <div className="native-mixer-controls">
          <div className="native-mixer-top-row">
            <label className="native-mixer-top-control">
              <span>LI-COR</span>
              <input
                type="checkbox"
                aria-label="LI-COR control"
                checked={draft.use_licor}
                disabled={!ready}
                onChange={(event) => {
                  const nextValue = event.currentTarget.checked;
                  updateDraft("use_licor", nextValue);
                  void commitField("use_licor", nextValue);
                }}
              />
            </label>
            <label className="native-mixer-top-control">
              <span>Total SLPM</span>
              <NativeNumberInput
                field="total_slpm"
                value={draft.total_slpm}
                unit="SLPM"
                ready={ready}
                phase={fieldPhase.total_slpm ?? "idle"}
                onChange={(value) => updateDraft("total_slpm", value)}
                onCommit={() => void commitField("total_slpm")}
              />
            </label>
          </div>
          <div className="native-mfc-grid">
            {gasMixerNativeDisplayOrder.map((address) => (
              <NativeMfcCard
                key={address}
                address={address}
                draft={draft}
                observed={observed}
                ready={ready}
                fieldPhase={fieldPhase}
                onDraft={updateDraft}
                onCommit={(field) => void commitField(field)}
              />
            ))}
          </div>
        </div>

        <div className="native-mixer-ledger">
          <table>
            <thead><tr><th>Gas</th><th>Requested</th><th>Applied</th><th>Observed</th></tr></thead>
            <tbody>
              {gasMixerNativeDisplayOrder.map((address) => {
                const requestedChannel = draft.channels[address];
                const appliedChannel = applied.channels[address];
                const observedChannel = observed.channels[address];
                return (
                  <tr key={address} className={observedChannel.available ? "" : "is-unavailable"}>
                    <th>{gasFormulaLabel(requestedChannel.formula)} {address}</th>
                    <td>{formatGasMixerNativeValue(requestedChannel.setpoint, requestedChannel.flow_unit)}</td>
                    <td>{formatGasMixerNativeValue(appliedChannel.setpoint, appliedChannel.flow_unit)}</td>
                    <td className={observedChannel.flow_error ? "is-error" : "is-delivered"}>
                      {formatGasMixerNativeValue(observedChannel.delivered, observedChannel.flow_unit)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="native-mixer-ledger-status" aria-live="polite">
            {loading ? <Loader2 className="chart-loading-spinner" size={18} /> : null}
            {error ? <><AlertTriangle size={16} /><span>{error}</span></> : null}
            {!loading && !error ? (
              <span>{ready ? "Synchronized" : "Bridge pending"}</span>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}
