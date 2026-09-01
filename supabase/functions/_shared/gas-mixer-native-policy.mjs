const channelConfig = {
  A: { address: "A", formula: "N2", balance: true, ratio_unit: "%", flow_unit: "SLPM" },
  B: { address: "B", formula: "O2", balance: false, ratio_unit: "%", flow_unit: "SLPM" },
  C: { address: "C", formula: "Ar", balance: false, ratio_unit: "PPM", flow_unit: "SCCM" },
  D: { address: "D", formula: "CO2", balance: false, ratio_unit: "PPM", flow_unit: "SCCM" },
  E: { address: "E", formula: "N2", balance: false, ratio_unit: "%", flow_unit: "SLPM" },
  F: { address: "F", formula: "O2", balance: false, ratio_unit: "%", flow_unit: "SLPM" },
};

const editableFields = new Map([
  ["use_licor", { kind: "boolean" }],
  ["total_slpm", { kind: "number", min: 0, max: 9, decimals: 3 }],
  ["mfc.B.ratio", { kind: "number", min: 0, max: 100, decimals: 1 }],
  ["mfc.B.setpoint", { kind: "number", min: 0, max: 9, decimals: 3 }],
  ["mfc.C.ratio", { kind: "number", min: 0, max: 99999, decimals: 0 }],
  ["mfc.C.setpoint", { kind: "number", min: 0, max: 9999, decimals: 2 }],
  ["mfc.D.ratio", { kind: "number", min: 0, max: 99999, decimals: 0 }],
  ["mfc.D.setpoint", { kind: "number", min: 0, max: 9999, decimals: 2 }],
  ["mfc.E.ratio", { kind: "number", min: 0, max: 100, decimals: 1 }],
  ["mfc.E.setpoint", { kind: "number", min: 0, max: 9, decimals: 3 }],
  ["mfc.F.ratio", { kind: "number", min: 0, max: 100, decimals: 1 }],
  ["mfc.F.setpoint", { kind: "number", min: 0, max: 9, decimals: 3 }],
]);

export function normalizeNativeField(field, value) {
  const spec = editableFields.get(field);
  if (!spec) throw new Error("The mixer field is not editable");
  if (spec.kind === "boolean") {
    if (typeof value !== "boolean") throw new Error("LI-COR must be on or off");
    return { field, value };
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < spec.min || value > spec.max) {
    throw new Error(`The mixer value must be between ${spec.min} and ${spec.max}`);
  }
  const factor = 10 ** spec.decimals;
  return { field, value: Math.round(value * factor) / factor };
}

export function bridgeIsReady(state, nowMs = Date.now()) {
  if (!state?.bridge_connected || !state?.bridge_ready || !state?.last_bridge_at) return false;
  const heartbeatMs = Date.parse(state.last_bridge_at);
  return Number.isFinite(heartbeatMs) && heartbeatMs >= nowMs - 45_000;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function ratioPercent(channel) {
  return channel.ratio_unit === "PPM" ? channel.ratio / 10000 : channel.ratio;
}

function setRatioPercent(channel, percent) {
  channel.ratio = channel.ratio_unit === "PPM" ? percent * 10000 : percent;
}

function setpointSlpm(channel) {
  return channel.flow_unit === "SCCM" ? channel.setpoint / 1000 : channel.setpoint;
}

function setSetpointSlpm(channel, slpm) {
  channel.setpoint = channel.flow_unit === "SCCM" ? slpm * 1000 : slpm;
}

function rebalanceForTotalChange(state) {
  for (const address of Object.keys(channelConfig)) {
    const channel = state.channels[address];
    setSetpointSlpm(channel, ratioPercent(channel) * state.total_slpm / 100);
  }
}

function rebalanceForMfcChange(state, modifiedAddress) {
  const addresses = Object.keys(channelConfig);
  if (state.total_slpm === 0) {
    const otherPercent = ["B", "C", "D", "E", "F"]
      .reduce((sum, address) => sum + ratioPercent(state.channels[address]), 0);
    if (otherPercent <= 100) {
      setRatioPercent(state.channels.A, 100 - otherPercent);
    } else {
      for (const address of addresses) {
        if (address !== modifiedAddress) setRatioPercent(state.channels[address], 0);
      }
      setRatioPercent(state.channels.A, 100 - ratioPercent(state.channels[modifiedAddress]));
    }
    return;
  }
  const otherSlpm = ["B", "C", "D", "E", "F"]
    .reduce((sum, address) => sum + setpointSlpm(state.channels[address]), 0);
  if (otherSlpm <= state.total_slpm) {
    setSetpointSlpm(state.channels.A, state.total_slpm - otherSlpm);
  } else {
    for (const address of addresses) {
      if (address !== modifiedAddress) setSetpointSlpm(state.channels[address], 0);
    }
    setSetpointSlpm(
      state.channels.A,
      state.total_slpm - setpointSlpm(state.channels[modifiedAddress]),
    );
  }
  for (const address of addresses) {
    setRatioPercent(
      state.channels[address],
      100 * setpointSlpm(state.channels[address]) / state.total_slpm,
    );
  }
}

export function applyNativeField(current, rawField, rawValue) {
  const { field, value } = normalizeNativeField(rawField, rawValue);
  const state = clone(current);
  if (field === "use_licor") {
    state.use_licor = value;
    return state;
  }
  if (field === "total_slpm") {
    state.total_slpm = value;
    rebalanceForTotalChange(state);
    return state;
  }
  const [, address, property] = field.split(".");
  const channel = state.channels[address];
  if (!channel) throw new Error("The mixer channel is not configured");
  if (property === "ratio") {
    channel.ratio = value;
    setSetpointSlpm(channel, ratioPercent(channel) * state.total_slpm / 100);
  } else {
    const slpm = channel.flow_unit === "SCCM" ? value / 1000 : value;
    if (slpm > state.total_slpm) throw new Error("Setpoint exceeds total flow");
    channel.setpoint = value;
  }
  rebalanceForMfcChange(state, address);
  return state;
}

export function normalizeNativeMachineState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Mixer state must be an object");
  }
  const state = clone(value);
  if (typeof state.use_licor !== "boolean" || typeof state.total_slpm !== "number" ||
      !Number.isFinite(state.total_slpm) || state.total_slpm < 0 || state.total_slpm > 9 ||
      !state.channels || typeof state.channels !== "object") {
    throw new Error("Mixer state header is invalid");
  }
  for (const [address, config] of Object.entries(channelConfig)) {
    const channel = state.channels[address];
    if (!channel || channel.address !== address || channel.formula !== config.formula ||
        channel.balance !== config.balance || channel.ratio_unit !== config.ratio_unit ||
        channel.flow_unit !== config.flow_unit ||
        !Number.isFinite(channel.ratio) || !Number.isFinite(channel.setpoint) ||
        !Number.isFinite(channel.delivered) || typeof channel.available !== "boolean" ||
        typeof channel.flow_error !== "boolean") {
      throw new Error(`Mixer channel ${address} is invalid`);
    }
  }
  return state;
}
