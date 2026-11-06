#!/usr/bin/env node
// Edge Function invocation budget for the whole ExactH2O account.
//
// Agent cadences are derived, not restated: installed-client timing constants
// are parsed from the shipped client sources and server hold budgets come from
// supabase/functions/_shared/agent-polling.mjs. Other sources use measured
// daily rates (Logs Explorer, 2026-10-20/21) and are listed with their origin.
// `node scripts/budget/edge-budget-model.mjs` prints the JSON report.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { agentPollBudget } from "../../supabase/functions/_shared/agent-polling.mjs";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const DAY = 86_400;

export const pricing = Object.freeze({
  includedInvocations: 2_000_000,
  targetInvocations: 1_200_000,
  overagePerMillionUsd: 2,
  source: "https://supabase.com/docs/guides/platform/manage-your-usage/edge-function-invocations (read 2026-10-21)",
});

export function installedClients() {
  const native = read("controller-release/gas-mixer-native-bridge/native_bridge.py");
  const screen = read("controller-release/gas-mixer-agent/agent.py");
  const lighting = read("controller-release/lighting-bridge/src/com/exacth2o/lighting/LightingAgentV2.java");
  const number = (text, pattern, name) => {
    const value = Number(text.match(pattern)?.[1]);
    if (!Number.isFinite(value)) throw new Error(`Could not read ${name} from the installed client`);
    return value;
  };
  return {
    native: {
      version: native.match(/BRIDGE_VERSION = "([^"]+)"/)?.[1],
      waitAfterCycleS: number(native, /^POLL_INTERVAL_SECONDS = (\d+)$/m, "native poll interval"),
      heartbeatEveryS: number(native, /now - self\._last_heartbeat >= (\d+)/, "native heartbeat interval"),
      timeoutS: number(native, /^REQUEST_TIMEOUT_SECONDS = (\d+)$/m, "native timeout"),
    },
    screen: {
      version: screen.match(/AGENT_VERSION = "([^"]+)"/)?.[1],
      heartbeatEveryS: number(screen, /^HEARTBEAT_INTERVAL_SECONDS = ([\d.]+)$/m, "screen heartbeat"),
      frameEveryS: number(screen, /^FRAME_INTERVAL_SECONDS = ([\d.]+)$/m, "screen frame interval"),
      pollEveryS: number(screen, /^POLL_INTERVAL_SECONDS = ([\d.]+)$/m, "screen poll interval"),
      loopSleepS: number(screen, /time\.sleep\(([\d.]+)\)\n\s+except/, "screen loop sleep"),
      timeoutS: number(screen, /urlopen\(request, timeout=(\d+)\)/, "screen timeout"),
    },
    lighting: {
      version: lighting.match(/VERSION = "([^"]+)"/)?.[1],
      sleepS: number(lighting, /getProperty\("poll_ms"\), (\d+)L/, "lighting poll_ms") / 1000,
      readTimeoutS: number(lighting, /setReadTimeout\((\d+)\)/, "lighting read timeout") / 1000,
    },
  };
}

// Measured or bounded inputs that are not derivable from source.
export const assumptions = Object.freeze({
  requestOverheadS: 0.35, // one HTTPS round trip incl. auth/queries (native/screen calls measured 0.3-0.6 s)
  screenCaptureS: 0.5, // ffmpeg x11grab of one 800x480 PNG on the mixer Pi
  others: {
    // calls/day measured 2026-10-20 02:13Z - 2026-10-21 02:13Z (scripts/audit-supabase-usage.py)
    "receive-walker-telemetry": 3117,
    "sync-owner-health (control executor watchdog, 120 s)": 720,
    "sync-owner-health (GitHub watchdog, 30 min)": 48,
    "website-analytics (admin home tile, visible)": 56,
    "interactive control/session/manual-hold calls": 40,
  },
});

/**
 * Old-client cycles under a server: "deployed-2026-10-20" (before), "held"
 * (wake-ups available) or "held-no-listener" (LISTEN unavailable, so only the
 * poll is held, re-reading every 2 s, and lighting keeps its 5 s pacing).
 * Returns calls per day for unattended operation and per attended hour.
 */
export function agentRates(clients = installedClients(), server = "held", budget = agentPollBudget) {
  const rtt = assumptions.requestOverheadS;
  const py = budget.pythonResponseBudgetMs / 1000;
  const java = budget.javaResponseBudgetMs / 1000;
  const n = clients.native;
  const s = clients.screen;
  const l = clients.lighting;

  const deployed = server === "deployed-2026-10-20";
  const noListener = server === "held-no-listener";
  // Native: heartbeat (>=10 s since last), state (live delivered flow changes
  // every snapshot: worst case), poll, then the bridge's fixed wait.
  const nativeUnattendedCycle = deployed
    ? rtt + rtt + (budget.legacyIdleHoldMs / 1000 + rtt) + n.waitAfterCycleS
    : noListener ? rtt + rtt + py + n.waitAfterCycleS : py * 3 + n.waitAfterCycleS;
  const nativeAttendedCycle = deployed || noListener
    ? nativeUnattendedCycle
    : rtt + rtt + budget.nativeAttendedPollHoldMs / 1000 + n.waitAfterCycleS;
  // Screen: heartbeat, changed frame, poll; held server parks all three idle.
  const screenUnattendedCycle = deployed
    ? rtt + s.loopSleepS + assumptions.screenCaptureS + rtt + (budget.legacyIdleHoldMs / 1000 + rtt)
    : noListener ? rtt + s.loopSleepS + assumptions.screenCaptureS + rtt + py
      : py * 3 + assumptions.screenCaptureS + s.loopSleepS;
  // Open session: polls every pollEveryS (server returns at once, or holds
  // screenSessionHoldMs), a frame per frameEveryS, heartbeat per heartbeatEveryS.
  const sessionPollPeriod = deployed
    ? Math.max(s.pollEveryS, rtt + s.loopSleepS)
    : Math.max(s.pollEveryS, budget.screenSessionHoldMs / 1000 + rtt * 0.3 + s.loopSleepS);
  const sessionCallsPerHour = 3600 * (1 / sessionPollPeriod + 1 / Math.max(s.frameEveryS, assumptions.screenCaptureS + rtt) + 1 / s.heartbeatEveryS);
  // Lighting: one sync per cycle, then the bridge's fixed sleep.
  const lightingUnattendedCycle = deployed || noListener
    ? budget.lightingFallbackIdleMs / 1000 + rtt * 0.3 + l.sleepS
    : java + rtt * 0.3 + l.sleepS;
  const lightingAttendedCycle = deployed || noListener
    ? lightingUnattendedCycle
    : budget.lightingAttendedHoldMs / 1000 + rtt * 0.3 + l.sleepS;

  return {
    native: { unattendedPerDay: 3 * DAY / nativeUnattendedCycle, attendedPerHour: 3 * 3600 / nativeAttendedCycle, unattendedCycleS: nativeUnattendedCycle },
    screen: { unattendedPerDay: 3 * DAY / screenUnattendedCycle, sessionPerHour: sessionCallsPerHour, unattendedCycleS: screenUnattendedCycle },
    lighting: { unattendedPerDay: DAY / lightingUnattendedCycle, attendedPerHour: 3600 / lightingAttendedCycle, unattendedCycleS: lightingUnattendedCycle },
  };
}

export const profiles = Object.freeze({
  // Observed 2026-09-21..10-20: screen view 5 min/30 days; 58 mixer and 51
  // lighting commands in 10/30 days. "normal" is deliberately above that.
  normal: { nativeAttendedHoursPerDay: 2, lightingAttendedHoursPerDay: 2, screenSessionMinutesPerDay: 10, commandsPerDay: 30 },
  busy: { nativeAttendedHoursPerDay: 8, lightingAttendedHoursPerDay: 8, screenSessionMinutesPerDay: 60, commandsPerDay: 150 },
});

export function project(profileName = "normal", server = "held", days = 31) {
  const profile = profiles[profileName];
  const rates = agentRates(installedClients(), server);
  const unattendedShare = (hours) => Math.max(0, 24 - hours) / 24;
  const perDay = {
    "gas-mixer-native-agent": rates.native.unattendedPerDay * unattendedShare(profile.nativeAttendedHoursPerDay)
      + rates.native.attendedPerHour * profile.nativeAttendedHoursPerDay,
    "gas-mixer-agent": rates.screen.unattendedPerDay * unattendedShare(profile.screenSessionMinutesPerDay / 60)
      + rates.screen.sessionPerHour * profile.screenSessionMinutesPerDay / 60,
    "lighting-native-agent": rates.lighting.unattendedPerDay * unattendedShare(profile.lightingAttendedHoursPerDay)
      + rates.lighting.attendedPerHour * profile.lightingAttendedHoursPerDay,
    // Each command adds its control call plus at most a few agent calls (ack, result, early wake).
    commands: profile.commandsPerDay * 4,
    ...assumptions.others,
    // The 5-minute Cron jobs: gated (only when there is work) vs. unconditional before.
    "sync-owner-health (Supabase Cron)": server === "deployed-2026-10-20" ? 288 : 10,
    "assistant-automation-runner (Supabase Cron)": server === "deployed-2026-10-20" ? 288 : 0,
  };
  const sources = Object.fromEntries(Object.entries(perDay).map(([name, value]) => [name, Math.round(value * days)]));
  const total = Object.values(sources).reduce((sum, value) => sum + value, 0);
  return {
    profile: profileName,
    server,
    days,
    sources,
    total,
    percent_of_included: Math.round(1000 * total / pricing.includedInvocations) / 10,
    headroom_percent: Math.round(1000 * (1 - total / pricing.includedInvocations)) / 10,
    meets_target: total <= pricing.targetInvocations,
  };
}

/** Calls that still fit before quota exhaustion in a billing cycle. */
export function cycleForecast(usedSoFar, cycleStartIso, cycleEndIso, nowIso, dailyRate) {
  const now = Date.parse(nowIso);
  const end = Date.parse(cycleEndIso);
  const remainingDays = Math.max(0, (end - now) / 86_400_000);
  const projectedTotal = usedSoFar + dailyRate * remainingDays;
  return {
    cycle: `${cycleStartIso.slice(0, 10)} to ${cycleEndIso.slice(0, 10)}`,
    remaining_days: Math.round(remainingDays * 10) / 10,
    projected_cycle_total: Math.round(projectedTotal),
    projected_percent: Math.round(1000 * projectedTotal / pricing.includedInvocations) / 10,
    daily_rate_that_exhausts_quota: Math.round(Math.max(0, pricing.includedInvocations - usedSoFar) / Math.max(remainingDays, 1 / 24)),
  };
}

export function report() {
  const clients = installedClients();
  return {
    generated_from: "scripts/budget/edge-budget-model.mjs",
    pricing,
    installed_clients: clients,
    server_budget: agentPollBudget,
    agent_rates_held: agentRates(clients, "held"),
    agent_rates_deployed_2026_10_20: agentRates(clients, "deployed-2026-10-20"),
    projections: {
      before_normal: project("normal", "deployed-2026-10-20"),
      after_normal: project("normal", "held"),
      before_busy: project("busy", "deployed-2026-10-20"),
      after_busy: project("busy", "held"),
      after_normal_no_listener: project("normal", "held-no-listener"),
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(report(), null, 2));
}
