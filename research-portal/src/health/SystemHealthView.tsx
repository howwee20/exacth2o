import type { PortalExperiment } from "../experimentRegistry";
import { PortalHomeButton } from "../product/PortalHomeButton";
import { AlertTriangle } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { controllerPresence } from "../settingsPresentation";
import { advanceCurrentBootUptime, reconstructCurrentBootUptime, restartOutagePresentation } from "../healthUptime";
import { healthBoolean, healthDateWithAge, healthNumber, healthRecord, healthString, healthTimestampMs } from "../healthValues";
import { sumKnownCounts } from "../portalData";
import { formatHealthNumber, runtimeStateIsFresh } from "../portalFormat";
import { type DeviceHealthSnapshot, type DeviceRuntimeState } from "../portalTypes";
import { HealthLineChart } from "./HealthLineChart";
import "./health.css";
import { currentHealthObservation, currentUptimeSeconds, healthChartPoint, healthHistoryRecords, healthOwnerValue, healthRecentRecords, mergeHealthObservation, monitoringGaps, restartEvents } from "./healthHistory";

import { pairingReport } from "./pairingReport";

type Tone = "ok" | "warning" | "bad" | "unknown";

/** 66 d 9 h, 5 h 12 m or 12 m. */
function spanText(secondsValue: number | null) {
  if (secondsValue == null) return "Not synced";
  const minutes = Math.max(0, Math.round(secondsValue / 60)), days = Math.floor(minutes / 1440), hours = Math.floor((minutes % 1440) / 60);
  if (days) return `${days} d ${hours} h`;
  if (hours) return `${hours} h ${minutes % 60} m`;
  return `${minutes} m`;
}

function Stat({ label, value, note, tone }: { label: string; value: string; note: string; tone: Tone }) {
  return <div className="sh-stat">
    <span>{label}</span>
    <strong>{value}</strong>
    <small className={`is-${tone}`}><i aria-hidden="true" />{note}</small>
  </div>;
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return <section className="sh-card">
    <div className="sh-card-head"><h2>{title}</h2></div>
    {children}
  </section>;
}

export function SystemHealthView({
  systemName,
  snapshot,
  history,
  runtimeState,
  error,
  onBackHome,
}: {
  experiments?: PortalExperiment[];
  systemName?: string;
  snapshot: DeviceHealthSnapshot | null;
  history: DeviceHealthSnapshot[];
  runtimeState: DeviceRuntimeState | null;
  error: string | null;
  onBackHome: () => void;
}) {
  const [clockNowMs, setClockNowMs] = useState(() => Date.now());

  useEffect(() => {
    const intervalId = window.setInterval(() => setClockNowMs(Date.now()), 30_000);
    return () => window.clearInterval(intervalId);
  }, []);

  const rawRecords = healthHistoryRecords(snapshot, history);
  const synchronizedUptime = currentUptimeSeconds(snapshot, runtimeState, rawRecords);
  const runtimeFresh = runtimeStateIsFresh(runtimeState, clockNowMs) && runtimeState?.pi_online !== false;
  const runtimeAt = healthTimestampMs(runtimeState?.state_observed_at);
  const snapshotAt = healthTimestampMs(snapshot?.captured_at);
  const useRuntimeReport = runtimeAt !== null && (snapshotAt === null || runtimeAt >= snapshotAt);
  const recordedAt = useRuntimeReport ? runtimeState?.state_observed_at : snapshot?.captured_at;
  const connection = controllerPresence({stateFreshUntil:runtimeState?.state_fresh_until,
    stateObservedAt:recordedAt,
    piOnline:runtimeState?.pi_online},clockNowMs);
  const lastReport = recordedAt ? `Last report ${healthDateWithAge(recordedAt)}.` : 'No health report received.';
  const uptimeObservedAt = runtimeFresh
    ? runtimeState?.state_observed_at
    : snapshot?.captured_at;
  const currentUptime = runtimeFresh
    ? advanceCurrentBootUptime(synchronizedUptime, uptimeObservedAt, clockNowMs)
    : synchronizedUptime;
  const reconstructedRecords = reconstructCurrentBootUptime(
    rawRecords,
    synchronizedUptime,
    uptimeObservedAt,
  );
  const records = mergeHealthObservation(
    reconstructedRecords,
    currentHealthObservation(snapshot, runtimeState, synchronizedUptime),
  );
  const evidenceRecords = healthRecentRecords(records, 8);
  const restarts = restartEvents(evidenceRecords);
  const gaps = monitoringGaps(evidenceRecords, healthNumber(snapshot?.raw_history?.sampleIntervalSeconds) ?? 300);
  const rawHealth = useRuntimeReport ? runtimeState?.raw_health : snapshot?.raw_health;
  const api = healthRecord(rawHealth?.api);
  const reportTime = (useRuntimeReport ? runtimeAt : snapshotAt) ?? clockNowMs;
  const pairings = pairingReport(rawHealth, runtimeFresh ? clockNowMs : reportTime);
  const incompletePairings = api.pairingReadings != null && !pairings;
  const pi = healthRecord(rawHealth?.piLocal);
  const ethernet = pi.available === true ? healthRecord(pi.ethernet) : healthRecord(rawHealth?.confirmedPiEthernet);
  const speed = healthNumber(ethernet.speed);
  const duplex = healthString(ethernet.duplex);
  const undervoltageCurrent = healthBoolean(healthOwnerValue(snapshot, runtimeState, "undervoltage_current")) ?? snapshot?.undervoltage ?? null;
  const currentCpuTemp = healthNumber(healthOwnerValue(snapshot, runtimeState, "cpu_temp_c")) ?? snapshot?.cpu_temp_c ?? null;
  const ethernetLink = healthBoolean(healthOwnerValue(snapshot, runtimeState, "ethernet_link")) ?? snapshot?.ethernet_link ?? null;
  const summary = useRuntimeReport ? runtimeState : snapshot;
  const currentSensors = incompletePairings ? null : pairings?.current ?? summary?.sensors_current;
  const expectedSensors = incompletePairings ? null : pairings?.total ?? summary?.sensors_expected;
  const staleMissing = incompletePairings ? null : pairings?.review.length ?? sumKnownCounts(summary?.sensors_stale, summary?.sensors_missing);
  const restartEvidenceKnown = records.length >= 2 && currentUptime != null;
  const reportingHealthy = runtimeFresh && runtimeState?.pi_online === true && runtimeState.api_status?.toUpperCase() === "OK";
  const historicalOutageStatus = restartOutagePresentation(
    restartEvidenceKnown,
    restarts.length,
    gaps.length,
    reportingHealthy,
  );
  const restartOutageStatus = runtimeFresh ? historicalOutageStatus : {
    detail: `${connection.status === "offline" ? "Controller offline. " : "Connection status unavailable. "}${lastReport} Showing recorded history.`,
    badge: connection.status === "offline" ? "Offline" : "Not synced",
    badgeTone: "warning" as const,
  };
  const sensorEvidenceKnown = currentSensors != null && expectedSensors != null && staleMissing != null;

  const upText = spanText(currentUptime);
  const stale = "at last report";
  const speedText = speed != null && speed > 0 ? `${speed} Mbps${duplex ? " · " + duplex + " duplex" : ""}` : null;
  const series = (key: string) => records.map((record) => healthChartPoint(record, key));
  // Every restart in the history shown, at the moment the controller came back up.
  const restartMarks = restartEvents(records).flatMap((restart) => {
    const at = healthTimestampMs(restart.t);
    return at == null ? [] : [{ t: at, label: "Restart" }];
  });

  return (
    <section className="system-health-main sh-page" aria-label={systemName ? `${systemName} system health` : "System health"}>
      <PortalHomeButton onClick={onBackHome} />

      {error ? (
        <div className="banner error">
          <AlertTriangle size={18} />
          {error}
        </div>
      ) : null}

      <h1 className="px-title">{systemName ? `${systemName} system health` : "System health"}</h1>
      <p className="px-subtitle">{runtimeFresh ? "Online. " : connection.status === "offline" ? "Offline. " : ""}{lastReport}</p>

      <div className="sh-stats">
        <Stat label={runtimeFresh ? "Controller" : "Last uptime"} value={currentUptime == null ? "Not synced" : runtimeFresh ? `Up ${upText}` : upText}
          note={restartOutageStatus.badge} tone={restartOutageStatus.badgeTone} />
        <Stat label="Sensors" value={currentSensors == null || expectedSensors == null ? "Not synced" : `${currentSensors} / ${expectedSensors}`}
          note={!runtimeFresh ? stale : !sensorEvidenceKnown ? "Not synced" : staleMissing > 0 ? `${staleMissing} not reporting` : "All reporting"}
          tone={!runtimeFresh || !sensorEvidenceKnown ? "unknown" : staleMissing > 0 ? "warning" : "ok"} />
        <Stat label="Temperature" value={formatHealthNumber(currentCpuTemp, 1, " °C")}
          note={!runtimeFresh ? stale : undervoltageCurrent == null ? "Power not reported" : undervoltageCurrent ? "Undervoltage now" : "Power normal"}
          tone={!runtimeFresh || undervoltageCurrent == null ? "unknown" : undervoltageCurrent ? "warning" : "ok"} />
        <Stat label="Network" value={ethernetLink == null ? "Not synced" : ethernetLink ? "Connected" : "Disconnected"}
          note={!runtimeFresh ? stale : speedText ?? "Speed not reported"}
          tone={!runtimeFresh || ethernetLink == null ? "unknown" : ethernetLink ? "ok" : "bad"} />
      </div>

      <Card title="Temperature">
        <HealthLineChart label="Temperature" unit=" °C" digits={1} points={series("cpuTempC")} marks={restartMarks} />
      </Card>
    </section>
  );
}
