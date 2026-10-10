import { AlertTriangle, ArrowLeft } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { advanceCurrentBootUptime, reconstructCurrentBootUptime, restartOutagePresentation } from "../healthUptime";
import { formatHealthDetailValue, healthBoolean, healthDateWithAge, healthNumber, healthString, healthTimestampMs } from "../healthValues";
import { booleanMarker, sumKnownCounts } from "../portalData";
import { formatHealthBoolean, formatHealthInteger, formatHealthNumber, formatSettingsTimestamp, runtimeStateIsFresh } from "../portalFormat";
import { type DeviceHealthSnapshot, type DeviceRuntimeState, type HealthChartPoint, type HealthChartSeries, type HealthSelectedDetail } from "../portalTypes";
import { HealthMiniFact, HealthPanel, HealthSelectedDetailDrawer } from "./HealthPanels";
import { currentHealthObservation, currentUptimeSeconds, HealthChartControls, healthChartPoint, healthChartWindow, healthCompactDuration, healthDurationText, healthHistoryRecords, healthOwnerValue, healthRecentRecords, mergeHealthObservation, monitoringGaps, restartEvents } from "./healthHistory";

export function HealthTrendChart({
  series,
  yMin = 0,
  yMax,
  yTitle,
  unit = "",
  onSelectDetail,
}: {
  series: HealthChartSeries[];
  yMin?: number;
  yMax?: number;
  yTitle: string;
  unit?: string;
  onSelectDetail?: (detail: HealthSelectedDetail) => void;
}) {
  const [windowOffset, setWindowOffset] = useState(0);
  const width = 760;
  const height = 210;
  const padLeft = 56;
  const padRight = 16;
  const padTop = 26;
  const padBottom = 36;
  const allTimes = series.flatMap((item) => item.points.map((point) => point.t));
  const windowInfo = useMemo(
    () => healthChartWindow(allTimes, windowOffset),
    [allTimes, windowOffset],
  );
  const visibleSeries = useMemo(
    () => series.map((item) => ({
      ...item,
      points: item.points.filter((point) => point.t >= windowInfo.startMs && point.t <= windowInfo.endMs),
    })),
    [series, windowInfo.endMs, windowInfo.startMs],
  );
  const allPoints = visibleSeries.flatMap((item) => item.points).filter((point) => point.value != null);
  const values = allPoints.map((point) => point.value as number);
  const minTime = windowInfo.startMs;
  const maxTime = windowInfo.endMs;
  const computedMax = Math.max(yMax ?? Math.max(yMin + 1, ...values, 1), yMin + 1);
  const plotWidth = width - padLeft - padRight;
  const plotHeight = height - padTop - padBottom;
  const xFor = (time: number) => padLeft + ((time - minTime) / Math.max(maxTime - minTime, 1)) * plotWidth;
  const yFor = (value: number) => height - padBottom - ((value - yMin) / Math.max(computedMax - yMin, 1)) * plotHeight;
  const linePath = (points: HealthChartPoint[]) => points
    .filter((point) => point.value != null)
    .map((point) => `${Math.max(padLeft, Math.min(width - padRight, xFor(point.t))).toFixed(1)},${Math.max(padTop, Math.min(height - padBottom, yFor(point.value as number))).toFixed(1)}`)
    .join(" ");
  const midValue = yMin + (computedMax - yMin) / 2;
  const axisValue = (value: number) => unit ? `${Math.round(value)}${unit}` : Number.isInteger(value) ? String(value) : value.toFixed(1);

  useEffect(() => {
    if (windowOffset > windowInfo.maxOffset) {
      setWindowOffset(windowInfo.maxOffset);
    }
  }, [windowInfo.maxOffset, windowOffset]);

  return (
    <div className="portal-health-chart">
      <HealthChartControls
        windowOffset={windowOffset}
        maxOffset={windowInfo.maxOffset}
        onChange={setWindowOffset}
      />
      <div className="health-chart-legend">
        {series.map((item) => (
          <span key={item.label}><i className={item.tone} />{item.label}</span>
        ))}
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={yTitle}>
        <line x1={padLeft} y1={padTop} x2={width - padRight} y2={padTop} className="health-chart-grid" />
        <line x1={padLeft} y1={padTop + plotHeight / 2} x2={width - padRight} y2={padTop + plotHeight / 2} className="health-chart-grid" />
        <line x1={padLeft} y1={height - padBottom} x2={width - padRight} y2={height - padBottom} className="health-chart-axis" />
        <line x1={padLeft} y1={padTop} x2={padLeft} y2={height - padBottom} className="health-chart-axis" />
        <text x={padLeft - 9} y={padTop + 4} textAnchor="end" className="health-chart-axis-text">{axisValue(computedMax)}</text>
        <text x={padLeft - 9} y={padTop + plotHeight / 2 + 4} textAnchor="end" className="health-chart-axis-text">{axisValue(midValue)}</text>
        <text x={padLeft - 9} y={height - padBottom + 4} textAnchor="end" className="health-chart-axis-text">{axisValue(yMin)}</text>
        <text x={padLeft} y={16} className="health-chart-axis-title">{yTitle}</text>
        {visibleSeries.map((item) => (
          <polyline key={item.label} points={linePath(item.points)} className={`health-chart-line is-${item.tone}`} />
        ))}
        {visibleSeries.flatMap((item) => item.points
          .filter((point, index, points) => point.value != null && (index === points.length - 1 || index % Math.max(1, Math.ceil(points.length / 48)) === 0))
          .map((point) => {
            const openDetail = () => {
              onSelectDetail?.({
                title: item.label,
                rows: [
                  { label: "Value", value: formatHealthDetailValue(point.value, unit) },
                  { label: "Sample time", value: formatSettingsTimestamp(point.iso) },
                  { label: "Series", value: item.label },
                ],
              });
            };
            return (
              <circle
                key={`${item.label}-${point.iso}`}
                cx={Math.max(padLeft, Math.min(width - padRight, xFor(point.t)))}
                cy={Math.max(padTop, Math.min(height - padBottom, yFor(point.value as number)))}
                r={3}
                className={`health-chart-dot is-${item.tone}`}
                role="button"
                tabIndex={0}
                onClick={openDetail}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    openDetail();
                  }
                }}
              >
                <title>{`${item.label}: ${point.value} at ${formatSettingsTimestamp(point.iso)}`}</title>
              </circle>
            );
          }))}
        <text x={padLeft} y={height - 12} className="health-chart-axis-text">{formatSettingsTimestamp(new Date(minTime).toISOString())}</text>
        <text x={(padLeft + width - padRight) / 2} y={height - 12} textAnchor="middle" className="health-chart-axis-text">{formatSettingsTimestamp(new Date((minTime + maxTime) / 2).toISOString())}</text>
        <text x={width - padRight} y={height - 12} textAnchor="end" className="health-chart-axis-text">{formatSettingsTimestamp(new Date(maxTime).toISOString())}</text>
        {!values.length ? <text x={width / 2} y={height / 2} textAnchor="middle" className="health-chart-empty">No samples yet</text> : null}
      </svg>
    </div>
  );
}
export function SystemHealthView({
  snapshot,
  history,
  runtimeState,
  error,
  onBackHome,
}: {
  snapshot: DeviceHealthSnapshot | null;
  history: DeviceHealthSnapshot[];
  runtimeState: DeviceRuntimeState | null;
  error: string | null;
  onBackHome: () => void;
}) {
  const [selectedDetail, setSelectedDetail] = useState<HealthSelectedDetail | null>(null);
  const [clockNowMs, setClockNowMs] = useState(() => Date.now());

  useEffect(() => {
    const intervalId = window.setInterval(() => setClockNowMs(Date.now()), 30_000);
    return () => window.clearInterval(intervalId);
  }, []);

  const rawRecords = healthHistoryRecords(snapshot, history);
  const synchronizedUptime = currentUptimeSeconds(snapshot, runtimeState, rawRecords);
  const runtimeFresh = runtimeStateIsFresh(runtimeState);
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
  const allRestarts = restartEvents(records);
  const gaps = monitoringGaps(evidenceRecords, healthNumber(snapshot?.raw_history?.sampleIntervalSeconds) ?? 300);
  const lastRestart = restarts[restarts.length - 1] ?? null;
  const lastGap = gaps[gaps.length - 1] ?? null;
  const currentBootStartMs = healthTimestampMs(lastRestart?.t);
  let uptimeChartRecords = currentBootStartMs == null
    ? records
    : records.filter((record) => (healthTimestampMs(record.t) ?? 0) >= currentBootStartMs);
  if (lastRestart) {
    uptimeChartRecords = mergeHealthObservation(uptimeChartRecords, {
      t: lastRestart.t,
      uptimeSeconds: 0,
    });
  }
  if (runtimeFresh && currentUptime != null) {
    uptimeChartRecords = mergeHealthObservation(uptimeChartRecords, {
      t: new Date(clockNowMs).toISOString(),
      uptimeSeconds: currentUptime,
    });
  }
  const latestRecord = records[records.length - 1] ?? null;
  const undervoltageCurrent = healthBoolean(healthOwnerValue(snapshot, runtimeState, "undervoltage_current")) ?? snapshot?.undervoltage ?? null;
  const undervoltageOccurred = healthBoolean(healthOwnerValue(snapshot, runtimeState, "undervoltage_occurred"));
  const throttleFlags = healthString(healthOwnerValue(snapshot, runtimeState, "throttled_flags"));
  const currentCpuTemp = healthNumber(healthOwnerValue(snapshot, runtimeState, "cpu_temp_c")) ?? snapshot?.cpu_temp_c ?? null;
  const ethernetLink = healthBoolean(healthOwnerValue(snapshot, runtimeState, "ethernet_link")) ?? snapshot?.ethernet_link ?? null;
  const ethernetIp = healthString(healthOwnerValue(snapshot, runtimeState, "ethernet_ip")) ?? snapshot?.ethernet_ip ?? null;
  const gatewayPingMs = healthNumber(healthOwnerValue(snapshot, runtimeState, "gateway_ping_ms")) ?? snapshot?.gateway_ping_ms ?? null;
  const currentSensors = (runtimeFresh ? runtimeState?.sensors_current : null) ?? snapshot?.sensors_current ?? healthNumber(latestRecord?.sensorRows);
  const expectedSensors = (runtimeFresh ? runtimeState?.sensors_expected : null) ?? snapshot?.sensors_expected ?? null;
  const staleMissing = sumKnownCounts(
    (runtimeFresh ? runtimeState?.sensors_stale : null) ?? snapshot?.sensors_stale,
    (runtimeFresh ? runtimeState?.sensors_missing : null) ?? snapshot?.sensors_missing,
  );
  const lastSensorReadingAt = (runtimeFresh ? runtimeState?.last_sensor_reading_at : null) ?? snapshot?.last_sensor_reading_at ?? null;
  const restartEvidenceKnown = records.length >= 2 && currentUptime != null;
  const reportingHealthy = runtimeFresh && runtimeState?.pi_online === true && runtimeState.api_status?.toUpperCase() === "OK";
  const restartOutageStatus = restartOutagePresentation(
    restartEvidenceKnown,
    restarts.length,
    gaps.length,
    reportingHealthy,
  );
  const sensorEvidenceKnown = currentSensors != null && expectedSensors != null && staleMissing != null;

  return (
    <section className="system-health-main" aria-label="System health">
      <HealthSelectedDetailDrawer
        detail={selectedDetail}
        onClose={() => setSelectedDetail(null)}
      />
      <button type="button" className="support-back-button" onClick={onBackHome}>
        <ArrowLeft size={15} />
        Home
      </button>

      {error ? (
        <div className="banner error">
          <AlertTriangle size={18} />
          {error}
        </div>
      ) : null}

      <h1 className="px-title">System health</h1>
      <p className="px-subtitle">Research controller · connection and recent interruptions</p>
      <HealthPanel
        title="Recent interruptions"
        detail={restartOutageStatus.detail}
        badge={restartOutageStatus.badge}
        badgeTone={restartOutageStatus.badgeTone}
      >
        <div className="health-mini-grid is-five">
          <HealthMiniFact label="Now" value={currentUptime == null ? "Not synced" : `up; ${healthDurationText(currentUptime)}`} />
          <HealthMiniFact label="Latest restart" value={!restartEvidenceKnown ? "Not synced" : lastRestart ? formatSettingsTimestamp(lastRestart.t) : "none detected"} />
          <HealthMiniFact label="Telemetry stopped" value={!restartEvidenceKnown ? "Not synced" : lastGap ? formatSettingsTimestamp(lastGap.start) : "none detected"} />
          <HealthMiniFact label="Service restored" value={!restartEvidenceKnown ? "Not synced" : lastGap ? formatSettingsTimestamp(lastGap.end) : "none detected"} />
          <HealthMiniFact label="Outage duration" value={!restartEvidenceKnown ? "Not synced" : lastGap ? healthCompactDuration(lastGap.durationMs) : "none detected"} />
        </div>
        <details className="px-diagnostics"><summary>Uptime history</summary>
        <HealthTrendChart
          yTitle="Uptime minutes"
          onSelectDetail={setSelectedDetail}
          series={[
            {
              label: "Current boot uptime",
              tone: "primary",
              points: uptimeChartRecords.map((record) => {
                const point = healthChartPoint(record, "uptimeSeconds");
                return { ...point, value: point.value == null ? null : point.value / 60 };
              }),
            },
            {
              label: "Restart detected",
              tone: "danger",
              points: restarts.map((restart) => ({
                t: healthTimestampMs(restart.t) ?? Date.now(),
                iso: restart.t,
                value: 0,
              })),
            },
            {
              label: "Observed telemetry gap",
              tone: "warning",
              points: gaps.flatMap((gap) => [
                { t: healthTimestampMs(gap.start) ?? Date.now(), iso: gap.start, value: 0 },
                { t: healthTimestampMs(gap.end) ?? Date.now(), iso: gap.end, value: 0 },
              ]),
            },
          ]}
        />
        </details>
      </HealthPanel>

      <div className="health-evidence-grid">
        <HealthPanel
          title="Power Evidence"
          detail={`${formatHealthNumber(currentCpuTemp, 1, " C")} now; undervoltage ${formatHealthBoolean(undervoltageCurrent, "on", "off")}.`}
          badge={formatHealthNumber(currentCpuTemp, 1, " C")}
          badgeTone={undervoltageCurrent == null ? "unknown" : undervoltageCurrent ? "warning" : "ok"}
        >
          <div className="health-mini-grid">
            <HealthMiniFact label="CPU temp" value={formatHealthNumber(currentCpuTemp, 1, " C")} />
            <HealthMiniFact label="Current undervoltage" value={formatHealthBoolean(undervoltageCurrent)} />
            <HealthMiniFact label="Since boot" value={formatHealthBoolean(undervoltageOccurred)} />
            <HealthMiniFact label="Throttle flags" value={throttleFlags ?? "Not synced"} />
          </div>
          <HealthTrendChart
            yTitle="Temperature C / flag marker"
            yMax={85}
            unit="C"
            onSelectDetail={setSelectedDetail}
            series={[
              { label: "CPU temp", tone: "primary", points: records.map((record) => healthChartPoint(record, "cpuTempC")) },
              {
                label: "Current undervoltage marker",
                tone: "danger",
                points: records.map((record) => {
                  const point = healthChartPoint(record, "undervoltage");
                  return { ...point, value: booleanMarker(record.undervoltage, 85, 0) };
                }),
              },
              {
                label: "Since boot marker",
                tone: "warning",
                points: records.map((record) => {
                  const point = healthChartPoint(record, "undervoltageOccurred");
                  return { ...point, value: booleanMarker(record.undervoltageOccurred, 85, 0) };
                }),
              },
              {
                label: "Restart evidence",
                tone: "secondary",
                points: allRestarts.map((restart) => ({
                  t: healthTimestampMs(restart.t) ?? Date.now(),
                  iso: restart.t,
                  value: 0,
                })),
              },
            ]}
          />
        </HealthPanel>

        <HealthPanel
          title="Ethernet Link"
          detail={ethernetLink == null
            ? "Ethernet state has not been synchronized."
            : `${ethernetIp ?? "No IP reported"}; gateway ${formatHealthNumber(gatewayPingMs, 3, " ms")}.`}
          badge={formatHealthBoolean(ethernetLink, "Link up", "Link down")}
          badgeTone={ethernetLink == null ? "unknown" : ethernetLink ? "ok" : "bad"}
        >
          <div className="health-mini-grid">
            <HealthMiniFact label="Ethernet link" value={formatHealthBoolean(ethernetLink, "up", "down")} />
            <HealthMiniFact label="Speed" value="Not synced" />
            <HealthMiniFact label="Gateway ping" value={formatHealthNumber(gatewayPingMs, 3, " ms")} />
          </div>
          <HealthTrendChart
            yTitle="Ethernet link"
            yMax={1}
            onSelectDetail={setSelectedDetail}
            series={[
              {
                label: "Ethernet link",
                tone: "primary",
                points: records.map((record) => {
                  const point = healthChartPoint(record, "ethUp");
                  return { ...point, value: booleanMarker(record.ethUp) };
                }),
              },
            ]}
          />
        </HealthPanel>
      </div>

      <HealthPanel
        title="Sensor Freshness"
        detail={`${formatHealthInteger(currentSensors)} / ${formatHealthInteger(expectedSensors)} current; latest read ${healthDateWithAge(lastSensorReadingAt)}.`}
        badge={!sensorEvidenceKnown
          ? "Not synced"
          : `${formatHealthInteger(currentSensors)}/${formatHealthInteger(expectedSensors)} ${staleMissing > 0 ? "Review" : "OK"}`}
        badgeTone={!sensorEvidenceKnown ? "unknown" : staleMissing > 0 ? "warning" : "ok"}
      >
        <div className="health-mini-grid">
          <HealthMiniFact label="Last sensor read" value={healthDateWithAge(lastSensorReadingAt)} />
          <HealthMiniFact label="Current" value={`${formatHealthInteger(currentSensors)}/${formatHealthInteger(expectedSensors)}`} />
          <HealthMiniFact label="Stale/missing" value={formatHealthInteger(staleMissing)} />
          <HealthMiniFact label="Node2" value="Not synced" />
          <HealthMiniFact label="Node4" value="Not synced" />
        </div>
        <HealthTrendChart
          yTitle="Sensor count"
          yMax={Math.max(20, expectedSensors ?? 20)}
          onSelectDetail={setSelectedDetail}
          series={[
            { label: "Not updating or missing", tone: "warning", points: records.map((record) => healthChartPoint(record, "staleOrMissingSensors")) },
            { label: "Total mapped sensors", tone: "secondary", points: records.map((record) => healthChartPoint(record, "sensorRows")) },
          ]}
        />
      </HealthPanel>
    </section>
  );
}
