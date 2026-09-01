export const gasMixerNativeAddresses = ["A", "B", "C", "D", "E", "F"] as const;
export const gasMixerNativeDisplayOrder = ["A", "C", "E", "B", "D", "F"] as const;

export type GasMixerNativeAddress = (typeof gasMixerNativeAddresses)[number];
export type GasMixerRatioUnit = "%" | "PPM";
export type GasMixerFlowUnit = "SLPM" | "SCCM";
export type GasMixerNativeField =
  | "use_licor"
  | "total_slpm"
  | `mfc.${Exclude<GasMixerNativeAddress, "A">}.ratio`
  | `mfc.${Exclude<GasMixerNativeAddress, "A">}.setpoint`;

export type GasMixerNativeChannelConfig = {
  address: GasMixerNativeAddress;
  formula: "N2" | "O2" | "Ar" | "CO2";
  balance: boolean;
  ratio_unit: GasMixerRatioUnit;
  flow_unit: GasMixerFlowUnit;
};

export type GasMixerNativeChannelState = GasMixerNativeChannelConfig & {
  ratio: number;
  setpoint: number;
  delivered: number;
  available: boolean;
  flow_error: boolean;
};

export type GasMixerNativeMachineState = {
  use_licor: boolean;
  total_slpm: number;
  channels: Record<GasMixerNativeAddress, GasMixerNativeChannelState>;
};

export type GasMixerNativeCommandStatus =
  | "queued"
  | "accepted"
  | "applied"
  | "verified"
  | "rejected"
  | "failed"
  | "expired";

export type GasMixerNativeStatus = {
  project_id: string;
  device_id: string;
  bridge_ready: boolean;
  bridge_version: string | null;
  last_bridge_at: string | null;
  state_revision: number;
  remote_control_allowed: boolean;
  requested_state: GasMixerNativeMachineState;
  applied_state: GasMixerNativeMachineState;
  observed_state: GasMixerNativeMachineState;
  last_command: {
    id: string;
    field: GasMixerNativeField;
    status: GasMixerNativeCommandStatus;
    created_at: string;
    completed_at: string | null;
    error_message: string | null;
  } | null;
};

export const gasMixerNativeChannelConfig: readonly GasMixerNativeChannelConfig[] = [
  { address: "A", formula: "N2", balance: true, ratio_unit: "%", flow_unit: "SLPM" },
  { address: "B", formula: "O2", balance: false, ratio_unit: "%", flow_unit: "SLPM" },
  { address: "C", formula: "Ar", balance: false, ratio_unit: "PPM", flow_unit: "SCCM" },
  { address: "D", formula: "CO2", balance: false, ratio_unit: "PPM", flow_unit: "SCCM" },
  { address: "E", formula: "N2", balance: false, ratio_unit: "%", flow_unit: "SLPM" },
  { address: "F", formula: "O2", balance: false, ratio_unit: "%", flow_unit: "SLPM" },
] as const;

export function initialGasMixerNativeState(): GasMixerNativeMachineState {
  const channels = {} as Record<GasMixerNativeAddress, GasMixerNativeChannelState>;
  for (const config of gasMixerNativeChannelConfig) {
    channels[config.address] = {
      ...config,
      ratio: config.balance ? 100 : 0,
      setpoint: 0,
      delivered: 0,
      available: config.address === "A" || config.address === "B" || config.address === "D",
      flow_error: false,
    };
  }
  return { use_licor: false, total_slpm: 0, channels };
}

export function cloneGasMixerNativeState(
  state: GasMixerNativeMachineState,
): GasMixerNativeMachineState {
  return {
    ...state,
    channels: Object.fromEntries(
      gasMixerNativeAddresses.map((address) => [address, { ...state.channels[address] }]),
    ) as Record<GasMixerNativeAddress, GasMixerNativeChannelState>,
  };
}

export function gasMixerNativeFieldSpec(field: GasMixerNativeField) {
  if (field === "use_licor") return { min: 0, max: 1, decimals: 0, step: 1 };
  if (field === "total_slpm") return { min: 0, max: 9, decimals: 3, step: 0.001 };
  const [, address, property] = field.split(".") as ["mfc", GasMixerNativeAddress, "ratio" | "setpoint"];
  const channel = gasMixerNativeChannelConfig.find((value) => value.address === address);
  if (!channel || channel.balance) throw new Error("Balance fields are calculated automatically");
  if (property === "ratio") {
    return channel.ratio_unit === "PPM"
      ? { min: 0, max: 99_999, decimals: 0, step: 1 }
      : { min: 0, max: 100, decimals: 1, step: 0.1 };
  }
  return channel.flow_unit === "SCCM"
    ? { min: 0, max: 9_999, decimals: 2, step: 0.01 }
    : { min: 0, max: 9, decimals: 3, step: 0.001 };
}

export function normalizeGasMixerNativeValue(field: GasMixerNativeField, value: unknown) {
  if (field === "use_licor") {
    if (typeof value !== "boolean") throw new Error("LI-COR must be on or off");
    return value;
  }
  const numeric = typeof value === "number" ? value : Number(value);
  const spec = gasMixerNativeFieldSpec(field);
  if (!Number.isFinite(numeric) || numeric < spec.min || numeric > spec.max) {
    throw new Error(`Enter a value from ${spec.min} to ${spec.max}`);
  }
  const factor = 10 ** spec.decimals;
  return Math.round(numeric * factor) / factor;
}

function ratioPercent(channel: GasMixerNativeChannelState) {
  return channel.ratio_unit === "PPM" ? channel.ratio / 10_000 : channel.ratio;
}

function setRatioPercent(channel: GasMixerNativeChannelState, percent: number) {
  channel.ratio = channel.ratio_unit === "PPM" ? percent * 10_000 : percent;
}

function setpointSlpm(channel: GasMixerNativeChannelState) {
  return channel.flow_unit === "SCCM" ? channel.setpoint / 1_000 : channel.setpoint;
}

function setSetpointSlpm(channel: GasMixerNativeChannelState, slpm: number) {
  channel.setpoint = channel.flow_unit === "SCCM" ? slpm * 1_000 : slpm;
}

function rebalanceForTotalChange(state: GasMixerNativeMachineState) {
  for (const address of gasMixerNativeAddresses) {
    const channel = state.channels[address];
    setSetpointSlpm(channel, ratioPercent(channel) * state.total_slpm / 100);
  }
}

function rebalanceForMfcChange(
  state: GasMixerNativeMachineState,
  modifiedAddress: Exclude<GasMixerNativeAddress, "A">,
) {
  if (state.total_slpm === 0) {
    const otherPercent = gasMixerNativeAddresses
      .filter((address) => address !== "A")
      .reduce((sum, address) => sum + ratioPercent(state.channels[address]), 0);
    if (otherPercent <= 100) {
      setRatioPercent(state.channels.A, 100 - otherPercent);
    } else {
      for (const address of gasMixerNativeAddresses) {
        if (address !== modifiedAddress) setRatioPercent(state.channels[address], 0);
      }
      setRatioPercent(state.channels.A, 100 - ratioPercent(state.channels[modifiedAddress]));
    }
    return;
  }

  const otherSlpm = gasMixerNativeAddresses
    .filter((address) => address !== "A")
    .reduce((sum, address) => sum + setpointSlpm(state.channels[address]), 0);
  if (otherSlpm <= state.total_slpm) {
    setSetpointSlpm(state.channels.A, state.total_slpm - otherSlpm);
  } else {
    for (const address of gasMixerNativeAddresses) {
      if (address !== modifiedAddress) setSetpointSlpm(state.channels[address], 0);
    }
    setSetpointSlpm(
      state.channels.A,
      state.total_slpm - setpointSlpm(state.channels[modifiedAddress]),
    );
  }
  for (const address of gasMixerNativeAddresses) {
    setRatioPercent(
      state.channels[address],
      100 * setpointSlpm(state.channels[address]) / state.total_slpm,
    );
  }
}

export function applyGasMixerNativeField(
  current: GasMixerNativeMachineState,
  field: GasMixerNativeField,
  rawValue: unknown,
) {
  const value = normalizeGasMixerNativeValue(field, rawValue);
  const state = cloneGasMixerNativeState(current);
  if (field === "use_licor") {
    state.use_licor = value as boolean;
    return state;
  }
  if (field === "total_slpm") {
    state.total_slpm = value as number;
    rebalanceForTotalChange(state);
    return state;
  }

  const [, address, property] = field.split(".") as ["mfc", Exclude<GasMixerNativeAddress, "A">, "ratio" | "setpoint"];
  const channel = state.channels[address];
  if (property === "ratio") {
    channel.ratio = value as number;
    setSetpointSlpm(channel, ratioPercent(channel) * state.total_slpm / 100);
  } else {
    const slpm = channel.flow_unit === "SCCM" ? (value as number) / 1_000 : value as number;
    if (slpm > state.total_slpm) throw new Error("Setpoint exceeds total flow");
    channel.setpoint = value as number;
  }
  rebalanceForMfcChange(state, address);
  return state;
}

export function formatGasMixerNativeValue(
  value: number,
  unit: GasMixerRatioUnit | GasMixerFlowUnit,
) {
  if (unit === "PPM") return value.toFixed(0);
  if (unit === "%") return value.toFixed(1);
  if (unit === "SCCM") return value.toFixed(2);
  return value.toFixed(3);
}

export function gasFormulaLabel(formula: GasMixerNativeChannelConfig["formula"]) {
  return formula === "N2" ? "N₂" : formula === "O2" ? "O₂" : formula === "CO2" ? "CO₂" : formula;
}
