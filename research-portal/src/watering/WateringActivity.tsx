import { useEffect, useMemo, useState } from "react";
import { HealthMiniFact } from "../health/HealthPanels";
import { HealthChartControls, healthChartWindow } from "../health/healthHistory";
import { healthAgeText, healthFirstText, healthNumber, healthString, healthTimestampMs } from "../healthValues";
import { formatHealthInteger, formatSettingsTimestamp } from "../portalFormat";
import { colorForPairing, plantGroupForPairing, plantGroupLabel, treatmentForPairing, treatmentLabel } from "../portalPresentation";
import { type HealthSelectedDetail, type HealthWateringEvent } from "../portalTypes";
import { type PairingRow } from "../types";
import { buildWateringPairingIndex, pairingLabel, recentWateringEvents, resolveWateringEventPairing, wateringAxisLabel, wateringEventLabel, wateringEventsLastDay } from "../wateringEvents";

export function HealthWateringChart({
  events,
  pairings,
  onSelectDetail,
}: {
  events: HealthWateringEvent[];
  pairings: PairingRow[];
  onSelectDetail?: (detail: HealthSelectedDetail) => void;
}) {
  const [windowOffset, setWindowOffset] = useState(0);
  // A wider viewBox prevents the row chart from ballooning vertically on wide
  // desktop canvases while leaving the VWC chart geometry entirely untouched.
  const width = 1040;
  const pairingIndex = useMemo(() => buildWateringPairingIndex(pairings), [pairings]);
  const rowLabels = useMemo(() => {
    return pairings.map((pairing) => ({
      key: pairingLabel(pairing),
      label: wateringAxisLabel(pairing),
    }));
  }, [pairings]);
  const height = Math.max(240, Math.min(520, 76 + Math.max(rowLabels.length, 1) * 19));
  const padLeft = 84;
  const padRight = 16;
  const padTop = 26;
  const padBottom = 36;
  const times = events.map((event) => healthTimestampMs(event.t)).filter((value): value is number => value != null);
  const windowInfo = useMemo(
    () => healthChartWindow(times, windowOffset),
    [times, windowOffset],
  );
  const minTime = windowInfo.startMs;
  const maxTime = windowInfo.endMs;
  const labels = rowLabels.length ? rowLabels : [{ key: "Valve", label: "Valve" }];
  const labelIndex = new Map(labels.map((row, index) => [row.key, index]));
  const visibleEvents = events.filter((event) => {
    const time = healthTimestampMs(event.t);
    const label = wateringEventLabel(event);
    return time != null && labelIndex.has(label) && time >= windowInfo.startMs && time <= windowInfo.endMs;
  });
  const plotWidth = width - padLeft - padRight;
  const plotHeight = height - padTop - padBottom;
  const xFor = (time: number) => padLeft + ((time - minTime) / Math.max(maxTime - minTime, 1)) * plotWidth;
  const yFor = (label: string) => labels.length === 1
    ? padTop + plotHeight / 2
    : padTop + ((labelIndex.get(label) ?? 0) / Math.max(labels.length - 1, 1)) * plotHeight;
  const tickRows = labels.length <= 24
    ? labels
    : Array.from(new Set([labels[0], labels[Math.floor(labels.length / 2)], labels[labels.length - 1]].filter(Boolean)));

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
        <span><i className="series" />Marker color matches VWC line</span>
        <span><i className="secondary" />{visibleEvents.length} shown</span>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Watering events by sensor or pot">
        {tickRows.map((row) => (
          <g key={row.key}>
            <line x1={padLeft} y1={yFor(row.key)} x2={width - padRight} y2={yFor(row.key)} className="health-chart-grid" />
            <text x={padLeft - 8} y={yFor(row.key) + 4} textAnchor="end" className="health-chart-axis-text">{row.label}</text>
          </g>
        ))}
        <line x1={padLeft} y1={height - padBottom} x2={width - padRight} y2={height - padBottom} className="health-chart-axis" />
        <line x1={padLeft} y1={padTop} x2={padLeft} y2={height - padBottom} className="health-chart-axis" />
        <text x={padLeft} y={16} className="health-chart-axis-title">Watering events</text>
        {visibleEvents.map((event) => {
          const time = healthTimestampMs(event.t) ?? minTime;
          const label = wateringEventLabel(event);
          const duration = healthNumber(event.valveOpenTimeMs);
          const eventRecord = event as Record<string, unknown>;
          const durationText = duration == null ? "--" : `${Math.round(duration / 1000)} sec`;
          const pairingName = event.pairingName ?? healthString(event.pairing) ?? label;
          const pairing = resolveWateringEventPairing(event, pairingIndex);
          const treatment = pairing ? treatmentForPairing(pairing) : "unknown";
          const plantGroup = pairing ? plantGroupForPairing(pairing) : "unknown";
          const seriesColor = pairing ? colorForPairing(pairing) : "#64748b";
          const openDetail = () => {
            onSelectDetail?.({
              title: label,
              rows: [
                { label: "Event", value: "Valve opened" },
                { label: "Time", value: formatSettingsTimestamp(event.t) },
                { label: "Age", value: healthAgeText(event.t) },
                { label: "Pot", value: label },
                { label: "Plant", value: plantGroupLabel(plantGroup) },
                { label: "Treatment", value: treatmentLabel(treatment) },
                { label: "Pairing", value: pairingName },
                { label: "Sensor", value: event.sensor ?? healthFirstText(eventRecord, ["sensor", "sensorKey", "sensor_key", "sensorId", "sensor_id"]) },
                { label: "Valve", value: event.valve ?? healthFirstText(eventRecord, ["valve", "valveKey", "valve_key", "valveId", "valve_id"]) },
                { label: "Duration", value: durationText },
              ],
            });
          };
          return (
            <circle
              key={`${event.id ?? event.t}-${label}-${event.t}`}
              cx={xFor(time)}
              cy={yFor(label)}
              r={4.4}
              className="watering-event-dot"
              style={{ fill: seriesColor, stroke: seriesColor }}
              role="button"
              tabIndex={0}
              onClick={openDetail}
              onKeyDown={(keyboardEvent) => {
                if (keyboardEvent.key === "Enter" || keyboardEvent.key === " ") {
                  keyboardEvent.preventDefault();
                  openDetail();
                }
              }}
            >
              <title>{`${label} opened ${formatSettingsTimestamp(event.t)}${duration == null ? "" : ` for ${Math.round(duration / 1000)} sec`}`}</title>
            </circle>
          );
        })}
        {!visibleEvents.length ? <text x={width / 2} y={height / 2} textAnchor="middle" className="health-chart-empty">No valve fires in this window</text> : null}
        <text x={padLeft} y={height - 12} className="health-chart-axis-text">{formatSettingsTimestamp(new Date(minTime).toISOString())}</text>
        <text x={(padLeft + width - padRight) / 2} y={height - 12} textAnchor="middle" className="health-chart-axis-text">{formatSettingsTimestamp(new Date((minTime + maxTime) / 2).toISOString())}</text>
        <text x={width - padRight} y={height - 12} textAnchor="end" className="health-chart-axis-text">{formatSettingsTimestamp(new Date(maxTime).toISOString())}</text>
      </svg>
    </div>
  );
}

export function wateringEventMatchesPairings(event: HealthWateringEvent, pairings: PairingRow[]) {
  const visibleLabels = new Set(pairings.map(pairingLabel));
  return visibleLabels.has(wateringEventLabel(event));
}

export function ResearchWateringActivity({
  events,
  pairings,
  onSelectDetail,
}: {
  events: HealthWateringEvent[];
  pairings: PairingRow[];
  onSelectDetail: (detail: HealthSelectedDetail) => void;
}) {
  const visibleEvents = useMemo(
    () => events.filter((event) => wateringEventMatchesPairings(event, pairings)),
    [events, pairings],
  );
  const visibleEvents24h = wateringEventsLastDay(visibleEvents);
  const latestWatering = visibleEvents[visibleEvents.length - 1] ?? null;
  const latestWateringTime = latestWatering ? formatSettingsTimestamp(latestWatering.t) : "none";
  const shownWateringEvents = recentWateringEvents(visibleEvents, 8);

  return (
    <section className="research-watering-activity" aria-label="Watering activity">
      <div className="health-mini-grid research-watering-summary">
        <HealthMiniFact label="24h fires" value={formatHealthInteger(visibleEvents24h.length)} />
        <HealthMiniFact label="Latest fire" value={latestWateringTime} />
        <HealthMiniFact label="Visible pots" value={String(pairings.length)} />
        <HealthMiniFact label="Event rows" value={String(visibleEvents.length)} />
      </div>
      <HealthWateringChart
        events={visibleEvents}
        pairings={pairings}
        onSelectDetail={onSelectDetail}
      />
      {shownWateringEvents.length ? (
        <div className="health-event-list research-watering-list">
          {shownWateringEvents.slice().reverse().slice(0, 8).map((event) => {
            const duration = healthNumber(event.valveOpenTimeMs);
            return (
              <div
                className="health-event-row"
                key={`${event.id ?? event.t}-${event.pairing ?? wateringEventLabel(event)}-${event.t}`}
              >
                <strong>{wateringEventLabel(event)}</strong>
                <span>{formatSettingsTimestamp(event.t)}</span>
                <em>{duration == null ? "--" : `${Math.round(duration / 1000)} sec`}</em>
              </div>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}
