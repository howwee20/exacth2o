import { useEffect, useMemo, useState } from "react";
import { HealthMiniFact } from "../health/HealthPanels";
import { HealthChartControls, healthChartWindow } from "../health/healthHistory";
import { healthAgeText, healthFirstText, healthNumber, healthString, healthTimestampMs } from "../healthValues";
import { formatHealthInteger, formatSettingsTimestamp } from "../portalFormat";
import { colorForPairing, plantGroupForPairing, plantGroupLabel, treatmentForPairing, treatmentLabel } from "../portalPresentation";
import { type PortalExperiment } from "../experimentRegistry";
import { type HealthSelectedDetail, type HealthWateringEvent, type TimeBounds } from "../portalTypes";
import { type PairingRow } from "../types";
import { buildWateringPairingIndex, pairingLabel, resolveWateringEventPairing, wateringAxisLabel, wateringEventLabel } from "../wateringEvents";
import { wateringTimelineMarkers, wateringZoomBounds } from "./wateringTimeline";

function eventTime(event: HealthWateringEvent) {
  const time = healthTimestampMs(event.t);
  return time == null ? "—" : new Date(time).toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit",
  });
}

function eventDuration(event: HealthWateringEvent) {
  const duration = healthNumber(event.valveOpenTimeMs);
  return duration == null ? "—" : `${Number((duration / 1000).toFixed(2))} sec`;
}

function wateringDetail(event: HealthWateringEvent, pairings: PairingRow[], experiment?: PortalExperiment): HealthSelectedDetail {
  const label = wateringEventLabel(event);
  const pairing = resolveWateringEventPairing(event, buildWateringPairingIndex(pairings));
  const record = event as Record<string, unknown>;
  return {
    title: label,
    rows: [
      { label: "Event", value: "Valve opened" },
      { label: "Time", value: eventTime(event) },
      { label: "Age", value: healthAgeText(event.t) },
      { label: "Pot", value: label },
      { label: "Plant", value: plantGroupLabel(pairing ? plantGroupForPairing(pairing, experiment) : "unknown") },
      { label: "Treatment", value: treatmentLabel(pairing ? treatmentForPairing(pairing, experiment) : "unknown") },
      { label: "Pairing", value: event.pairingName ?? healthString(event.pairing) ?? label },
      { label: "Sensor", value: event.sensor ?? healthFirstText(record, ["sensor", "sensorKey", "sensor_key", "sensorId", "sensor_id"]) },
      { label: "Valve", value: event.valve ?? healthFirstText(record, ["valve", "valveKey", "valve_key", "valveId", "valve_id"]) },
      { label: "Duration", value: eventDuration(event) },
    ],
  };
}

export function HealthWateringChart({ events, pairings, experiment, onSelectDetail, windowOverride, onZoom }: {
  events: HealthWateringEvent[];
  pairings: PairingRow[];
  experiment?: PortalExperiment;
  onSelectDetail?: (detail: HealthSelectedDetail) => void;
  windowOverride?: TimeBounds;
  onZoom?: (bounds: TimeBounds, pot: string) => void;
}) {
  const [windowOffset, setWindowOffset] = useState(0);
  const width = 1040;
  const padLeft = 84;
  const padRight = 16;
  const padTop = 26;
  const padBottom = 38;
  const plotWidth = width - padLeft - padRight;
  const pairingIndex = useMemo(() => buildWateringPairingIndex(pairings), [pairings]);
  const labels = pairings.length ? pairings.map(pairing => ({ key: pairingLabel(pairing), label: wateringAxisLabel(pairing, experiment) })) : [{ key: "Valve", label: "Valve" }];
  const height = Math.max(190, padTop + padBottom + labels.length * 28);
  const times = useMemo(() => events.map(event => healthTimestampMs(event.t)).filter((time): time is number => time != null), [events]);
  const inferredWindow = useMemo(() => healthChartWindow(times, windowOffset), [times, windowOffset]);
  const windowInfo = windowOverride ? { ...inferredWindow, ...windowOverride } : inferredWindow;
  const labelIndex = new Map(labels.map((row, index) => [row.key, index]));
  const visibleEvents = events.filter(event => labelIndex.has(wateringEventLabel(event)));
  const markers = wateringTimelineMarkers(visibleEvents, windowInfo, plotWidth);
  const shownCount = markers.reduce((count, marker) => count + marker.events.length, 0);
  const yFor = (label: string) => padTop + 14 + (labelIndex.get(label) ?? 0) * 28;

  useEffect(() => {
    if (windowOffset > windowInfo.maxOffset) setWindowOffset(windowInfo.maxOffset);
  }, [windowInfo.maxOffset, windowOffset]);

  return (
    <div className="portal-health-chart watering-timeline">
      {!windowOverride ? <HealthChartControls windowOffset={windowOffset} maxOffset={windowInfo.maxOffset} onChange={setWindowOffset} /> : null}
      <div className="watering-timeline-legend">
        <span><i />One dot = one opening</span>
        <span>Number = grouped openings{onZoom ? " · click to zoom" : ""}</span>
        <strong>{formatHealthInteger(shownCount)} openings</strong>
      </div>
      <div className="watering-timeline-scroll">
        <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Watering events by pot. Numbered markers group nearby openings.">
          {Array.from({ length: 5 }, (_, index) => {
            const fraction = index / 4;
            const x = padLeft + fraction * plotWidth;
            return <g key={index}>
              <line x1={x} y1={padTop} x2={x} y2={height - padBottom} className="health-chart-grid" />
              <text x={x} y={height - 12} textAnchor={index === 0 ? "start" : index === 4 ? "end" : "middle"} className="health-chart-axis-text">{formatSettingsTimestamp(new Date(windowInfo.startMs + fraction * (windowInfo.endMs - windowInfo.startMs)).toISOString())}</text>
            </g>;
          })}
          {labels.map(row => <g key={row.key}>
            <line x1={padLeft} y1={yFor(row.key)} x2={width - padRight} y2={yFor(row.key)} className="health-chart-grid" />
            <text x={padLeft - 10} y={yFor(row.key) + 4} textAnchor="end" className="health-chart-axis-text">{row.label}</text>
          </g>)}
          {markers.map(marker => {
            const event = marker.events[0];
            const pairing = resolveWateringEventPairing(event, pairingIndex);
            const color = pairing ? colorForPairing(pairing) : "#64748b";
            const grouped = marker.events.length > 1;
            const x = padLeft + marker.fraction * plotWidth;
            const y = yFor(marker.label);
            const description = grouped ? `${marker.label}: ${marker.events.length} openings. Click to zoom in.` : `${marker.label} opened ${eventTime(event)} for ${eventDuration(event)}. Click for details.`;
            const activate = () => {
              if (grouped && onZoom) onZoom(wateringZoomBounds(marker.events, windowInfo), marker.label);
              else onSelectDetail?.(wateringDetail(event, pairings, experiment));
            };
            return <g key={marker.key} className={`watering-marker${grouped ? " is-grouped" : ""}`} role="button" tabIndex={0} aria-label={description} onClick={activate} onKeyDown={keyboardEvent => {
              if (keyboardEvent.key === "Enter" || keyboardEvent.key === " ") { keyboardEvent.preventDefault(); activate(); }
            }}>
              <title>{description}</title>
              {grouped ? <>
                <rect x={x - 14} y={y - 9} width={28} height={18} rx={5} fill={color} fillOpacity={0.12} stroke={color} strokeWidth={1.5} />
                <text x={x} y={y + 4} textAnchor="middle" className="watering-marker-count">{marker.events.length > 999 ? "999+" : marker.events.length}</text>
              </> : <>
                <circle cx={x} cy={y} r={9} fill="transparent" />
                <circle cx={x} cy={y} r={3.5} fill={color} stroke="white" strokeWidth={1} />
              </>}
            </g>;
          })}
          {!shownCount ? <text x={width / 2} y={height / 2} textAnchor="middle" className="health-chart-empty">No openings in this range</text> : null}
        </svg>
      </div>
    </div>
  );
}

export function wateringEventMatchesPairings(event: HealthWateringEvent, pairings: PairingRow[]) {
  return pairings.some(pairing => pairingLabel(pairing) === wateringEventLabel(event));
}

const pageSize = 10;

export function ResearchWateringActivity({ events, pairings, experiment, onSelectDetail, windowOverride, onZoom }: {
  events: HealthWateringEvent[];
  pairings: PairingRow[];
  experiment?: PortalExperiment;
  onSelectDetail: (detail: HealthSelectedDetail) => void;
  windowOverride?: TimeBounds;
  onZoom?: (bounds: TimeBounds) => void;
}) {
  const [potFilter, setPotFilter] = useState("all");
  const [page, setPage] = useState(0);
  const visibleEvents = useMemo(() => events.filter(event => {
    const at = healthTimestampMs(event.t);
    return wateringEventMatchesPairings(event, pairings) && at != null && (!windowOverride || (at >= windowOverride.startMs && at <= windowOverride.endMs));
  }).sort((a, b) => (healthTimestampMs(a.t) ?? 0) - (healthTimestampMs(b.t) ?? 0)), [events, pairings, windowOverride]);
  const activeFilter = pairings.some(pairing => pairingLabel(pairing) === potFilter) ? potFilter : "all";
  const filteredEvents = visibleEvents.filter(event => activeFilter === "all" || wateringEventLabel(event) === activeFilter).slice().reverse();
  const lastPage = Math.max(0, Math.ceil(filteredEvents.length / pageSize) - 1);
  const currentPage = Math.min(page, lastPage);
  const shownEvents = filteredEvents.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
  const latest = visibleEvents.at(-1);

  return (
    <section className="research-watering-activity" aria-label="Watering activity">
      <div className="health-mini-grid research-watering-summary">
        <HealthMiniFact label="Openings in range" value={formatHealthInteger(visibleEvents.length)} />
        <HealthMiniFact label="Latest opening" value={latest ? formatSettingsTimestamp(latest.t) : "None"} />
        <HealthMiniFact label="Visible pots" value={String(pairings.length)} />
      </div>
      <HealthWateringChart events={visibleEvents} pairings={pairings} experiment={experiment} onSelectDetail={onSelectDetail} windowOverride={windowOverride} onZoom={onZoom ? (bounds, pot) => { setPotFilter(pot); setPage(0); onZoom(bounds); } : undefined} />
      <div className="watering-event-log">
        <div className="watering-log-heading">
          <h3>Individual openings</h3>
          <select aria-label="Filter watering events by pot" value={activeFilter} onChange={event => { setPotFilter(event.target.value); setPage(0); }}>
            <option value="all">All visible pots</option>
            {pairings.map(pairing => <option key={pairing.name} value={pairingLabel(pairing)}>{pairingLabel(pairing)}</option>)}
          </select>
        </div>
        <div className="watering-log-columns" aria-hidden="true"><span>Pot</span><span>Opened (local time)</span><span>Duration</span></div>
        {shownEvents.map((event, index) => <button type="button" className="watering-log-row" key={`${event.id ?? event.t}-${wateringEventLabel(event)}-${index}`} onClick={() => onSelectDetail(wateringDetail(event, pairings, experiment))}>
          <strong>{wateringEventLabel(event)}</strong><span>{eventTime(event)}</span><span>{eventDuration(event)} <span aria-hidden="true">↗</span></span>
        </button>)}
        {!shownEvents.length ? <p className="watering-log-empty">No openings in this range.</p> : null}
        <div className="watering-log-pagination">
          <span role="status">{filteredEvents.length ? `${currentPage * pageSize + 1}–${Math.min((currentPage + 1) * pageSize, filteredEvents.length)} of ${formatHealthInteger(filteredEvents.length)}` : "0 openings"}</span>
          <button type="button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Newer</button>
          <button type="button" disabled={currentPage >= lastPage} onClick={() => setPage(currentPage + 1)}>Older</button>
        </div>
      </div>
    </section>
  );
}
