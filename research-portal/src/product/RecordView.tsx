import { useEffect, useMemo, useRef, useState } from "react";
import type { PortalExperiment } from "../experimentRegistry";
import { formatMeasurementTime } from "../measurementFreshness";
import { loadAround, loadRecordSources, markExperimentSeen, type RecordSources } from "../recordClient";
import {
  calibrationRequestItems,
  calibrationStep,
  calibrationSegments,
  filterRecord,
  gapItems,
  newSince,
  noteItems,
  planItems,
  potsText,
  recordKinds,
  settingsItems,
  sortRecord,
  wateringItems,
  type RecordItem,
  type RecordKind,
} from "../recordModel";
import type { PairingRow } from "../types";
import type { PotBucket } from "../workbenchModel";
import { TimeSeriesChart, useElementWidth } from "./TimeSeriesChart";
import "./product.css";

const day = 86_400_000;
const spans = [
  { id: "14", label: "14 days", days: 14 },
  { id: "30", label: "30 days", days: 30 },
  { id: "60", label: "60 days", days: 60 },
  { id: "120", label: "120 days", days: 120 },
];
const allKinds = new Set<RecordKind>(recordKinds.map((item) => item.kind));
const dayHeading = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric" });
const clock = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });

function localDay(ms: number) {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** The experiment's Record: what happened, when, and when it was recorded. */
export function RecordView({
  experiment,
  projectId,
  deviceId,
  pairings,
  nowMs,
  userId,
}: {
  experiment: PortalExperiment;
  projectId: string;
  deviceId: string;
  pairings: readonly PairingRow[];
  nowMs: number;
  userId: string | null;
}) {
  const [spanDays, setSpanDays] = useState(14);
  const [kinds, setKinds] = useState<Set<RecordKind>>(() => new Set(allKinds));
  const [pot, setPot] = useState<string>("");
  const [sources, setSources] = useState<RecordSources | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The mark from before this visit decides what is new; the database mark moves on load.
  const previousMark = useRef<{ experiment: string; value: string | null } | null>(null);
  const [anchorMs] = useState(() => Math.min(nowMs, experiment.endedAt ? Date.parse(experiment.endedAt) : nowMs));

  useEffect(() => {
    if (!experiment.databaseId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    const startMs = anchorMs - spanDays * day;
    void loadRecordSources({
      projectId,
      deviceId,
      experimentDatabaseId: experiment.databaseId,
      pairingNames: experiment.pairingNames,
      startMs,
      endMs: anchorMs,
    })
      .then(async (next) => {
        if (cancelled) return;
        if (!previousMark.current || previousMark.current.experiment !== experiment.id) {
          previousMark.current = { experiment: experiment.id, value: next.lastSeenAt };
        }
        if (!next.problems.length && next.stats.failed === 0) {
          await markExperimentSeen(projectId, experiment.databaseId as string, new Date(anchorMs).toISOString()).catch(() => undefined);
        }
        if (!cancelled) setSources(next);
      })
      .catch((nextError) => !cancelled && setError(nextError instanceof Error ? nextError.message : "The record could not be loaded."))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [anchorMs, deviceId, experiment.databaseId, experiment.id, experiment.pairingNames, projectId, spanDays]);

  const experimentPairings = useMemo(() => pairings.filter((pairing) => experiment.pairingNames.includes(pairing.name)), [experiment.pairingNames, pairings]);
  const items = useMemo(() => {
    if (!sources) return [] as RecordItem[];
    return sortRecord([
      ...planItems(sources.revisions, sources.audits, sources.assignments),
      ...settingsItems(sources.commands, experiment.pairingNames, experiment.databaseId ?? null),
      ...calibrationRequestItems(sources.calibrationRequests, experiment.pairingNames),
      ...noteItems(sources.notes),
      ...gapItems(sources.gaps, experimentPairings),
      ...wateringItems(sources.daily),
    ].filter((item) => item.happenedAt >= anchorMs - spanDays * day && item.happenedAt <= anchorMs));
  }, [anchorMs, spanDays, experiment.databaseId, experiment.pairingNames, experimentPairings, sources]);
  const lastSeenMs = previousMark.current?.value ? Date.parse(previousMark.current.value) : null;
  const fresh = useMemo(() => newSince(items, lastSeenMs, userId), [items, lastSeenMs, userId]);
  const shown = useMemo(() => filterRecord(items, kinds, pot || null), [items, kinds, pot]);
  const byDay = useMemo(() => {
    const groups = new Map<number, RecordItem[]>();
    for (const item of shown) groups.set(localDay(item.happenedAt), [...(groups.get(localDay(item.happenedAt)) ?? []), item]);
    return Array.from(groups.entries());
  }, [shown]);

  if (!experiment.databaseId) {
    return <p className="px-empty">This experiment has no saved history yet (plan versions, controller commands, notes), so the Record is empty.</p>;
  }

  return (
    <section className="px-record" aria-label="Record">
      <div className="px-toolbar">
        <div className="px-record-kinds" role="group" aria-label="Show in the record">
          {recordKinds.map((entry) => (
            <button
              key={entry.kind}
              type="button"
              aria-pressed={kinds.has(entry.kind)}
              onClick={() => setKinds((current) => {
                const next = new Set(current);
                if (next.has(entry.kind)) next.delete(entry.kind);
                else next.add(entry.kind);
                return next;
              })}
            >
              <span className={`px-record-mark is-${entry.kind}`} aria-hidden="true">{entry.mark}</span> {entry.label}
            </button>
          ))}
        </div>
        <label className="px-select">
          Pot
          <select value={pot} onChange={(event) => setPot(event.target.value)}>
            <option value="">All pots</option>
            {experimentPairings.slice().sort((a, b) => a.pot_number - b.pot_number).map((pairing) => <option key={pairing.name} value={pairing.name}>Pot {pairing.pot_number}</option>)}
          </select>
        </label>
        <div className="px-segmented" role="group" aria-label="How far back">
          {spans.map((span) => <button key={span.id} type="button" aria-pressed={span.days === spanDays} onClick={() => setSpanDays(span.days)}>{span.label}</button>)}
        </div>
      </div>

      {lastSeenMs != null && fresh.size ? (
        <p className="px-notice is-info" role="status"><b>{fresh.size} new</b> since you last looked ({formatMeasurementTime(lastSeenMs)}). They are marked below.</p>
      ) : null}
      {error ? <p className="px-notice is-bad" role="alert">{error}</p> : null}
      {sources?.problems.map((problem) => <p key={problem} className="px-notice is-bad" role="alert">{problem} The rest of the record is shown.</p>)}

      {sources ? <RecordLane items={shown} startMs={anchorMs - spanDays * day} endMs={anchorMs} kinds={kinds} /> : null}

      {loading && !sources ? <p className="px-empty">Loading the record…</p> : null}
      {sources && !shown.length ? <p className="px-empty">Nothing of the selected kinds in the last {spanDays} days{pot ? ` for ${potsText([pot])}` : ""}.</p> : null}

      {byDay.map(([dayMs, list]) => (
        <section key={dayMs} className="px-record-day" aria-label={dayHeading.format(dayMs)}>
          <h3>{dayHeading.format(dayMs)}</h3>
          <ol>
            {list.map((item) => (
              <RecordEntry key={item.id} item={item} isNew={fresh.has(item.id)} projectId={projectId} deviceId={deviceId} focusPot={pot || null} />
            ))}
          </ol>
        </section>
      ))}

      {sources ? (
        <p className="px-muted px-small">
          {sources.stats.requests} requests, {sources.stats.rows.toLocaleString()} rows ({Math.round(sources.stats.bytes / 1024)} kB) for {spanDays} days. Gaps and valve openings are derived from readings and controller events; everything else is a recorded row.
        </p>
      ) : null}
    </section>
  );
}

function RecordLane({ items, startMs, endMs, kinds }: { items: readonly RecordItem[]; startMs: number; endMs: number; kinds: ReadonlySet<RecordKind> }) {
  const [ref, width] = useElementWidth<HTMLDivElement>();
  const rows = recordKinds.filter((entry) => kinds.has(entry.kind));
  const left = width < 520 ? 0 : 150;
  const plot = Math.max(10, width - left - 12);
  const x = (t: number) => left + ((Math.min(endMs, Math.max(startMs, t)) - startMs) / Math.max(1, endMs - startMs)) * plot;
  const rowH = 22;
  const maxOpenings = Math.max(1, ...items.filter((item) => item.kind === "watering").map((item) => item.value ?? 0));
  return (
    <div className="px-record-lane" aria-hidden="true">
      <div ref={ref}>
      {width ? (
        <svg width={width} height={rows.length * rowH + 18}>
          {rows.map((row, index) => {
            const y = index * rowH + 4;
            const labelX = left ? 0 : 2;
            const rowItems = items.filter((item) => item.kind === row.kind);
            return (
              <g key={row.kind}>
                {left ? <text x={labelX} y={y + 14} className="px-record-lane-label">{row.label}</text> : null}
                <line x1={left} x2={left + plot} y1={y + 10} y2={y + 10} className="px-record-lane-rule" />
                {rowItems.map((item) => {
                  if (item.kind === "gap") {
                    const end = item.endAt ?? endMs;
                    return <rect key={item.id} x={x(item.happenedAt)} y={y + 4} width={Math.max(2, x(end) - x(item.happenedAt))} height={12} className="px-record-lane-gap" />;
                  }
                  if (item.kind === "watering") {
                    const openings = item.value ?? 0;
                    const h = 3 + (openings / maxOpenings) * 13;
                    return <rect key={item.id} x={x(item.happenedAt) + 1} y={y + 18 - h} width={Math.max(2, x(item.happenedAt + day) - x(item.happenedAt) - 2)} height={h} className="px-record-lane-water" />;
                  }
                  return <circle key={item.id} cx={x(item.happenedAt)} cy={y + 10} r={4} className={`px-record-lane-dot is-${item.kind}${item.status === "failed" ? " is-failed" : ""}`} />;
                })}
              </g>
            );
          })}
          <text x={left} y={rows.length * rowH + 14} className="px-record-lane-label">{formatMeasurementTime(startMs)}</text>
          <text x={left + plot} y={rows.length * rowH + 14} textAnchor="end" className="px-record-lane-label">now</text>
        </svg>
      ) : null}
      </div>
    </div>
  );
}

function RecordEntry({ item, isNew, projectId, deviceId, focusPot }: { item: RecordItem; isNew: boolean; projectId: string; deviceId: string; focusPot: string | null }) {
  const [explain, setExplain] = useState(false);
  const kind = recordKinds.find((entry) => entry.kind === item.kind);
  const timeText = item.kind === "watering" ? "all day" : clock.format(item.happenedAt);
  return (
    <li className={`px-record-item is-${item.kind}${item.status === "failed" ? " is-failed" : ""}${isNew ? " is-new" : ""}`}>
      <span className="px-record-time">{timeText}</span>
      <span className={`px-record-mark is-${item.kind}`} aria-hidden="true">{kind?.mark}</span>
      <div className="px-record-body">
        <p className="px-record-title">
          {isNew ? <span className="px-record-new">New</span> : null}
          <span className="px-sr-only">{kind?.label}: </span>
          {item.title}
        </p>
        {item.detail ? <p className="px-record-detail">{item.detail}</p> : null}
        <p className="px-record-meta">
          {item.pots.length && item.kind !== "gap" ? <span>{potsText(item.pots)}</span> : null}
          {item.actor ? <span>{item.actor}</span> : null}
          {item.kind === "gap" ? <span>{item.ongoing ? "ongoing" : `until ${formatMeasurementTime(item.endAt ?? null)}`}</span> : null}
          {item.recordedAt != null ? <span>{item.kind === "note" ? "written" : "happened"} {formatMeasurementTime(item.happenedAt)} · {item.kind === "note" ? "received" : "requested"} {formatMeasurementTime(item.recordedAt)}</span> : null}
          <span>{item.basis === "derived" ? "derived" : "recorded"} · {item.source}</span>
        </p>
        {item.calibration && item.calibration.pairingNames.length ? (
          <>
            <button type="button" className="px-link-button" aria-expanded={explain} onClick={() => setExplain((value) => !value)}>
              {explain ? "Hide raw output" : "Show raw output around this change"}
            </button>
            {explain ? (
              <CalibrationExplainer
                key={`${projectId}:${deviceId}:${focusPot ?? ""}:${item.calibration.atMs}`}
                projectId={projectId}
                deviceId={deviceId}
                pairingName={focusPot && item.calibration.pairingNames.includes(focusPot) ? focusPot : item.calibration.pairingNames[0]}
                atMs={item.calibration.atMs}
                name={item.calibration.name}
              />
            ) : null}
          </>
        ) : null}
      </div>
    </li>
  );
}

function CalibrationExplainer({ projectId, deviceId, pairingName, atMs, name }: { projectId: string; deviceId: string; pairingName: string; atMs: number; name: string | null }) {
  const [buckets, setBuckets] = useState<PotBucket[] | null>(null);
  const [openings, setOpenings] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void loadAround({ projectId, deviceId, pairingName, atMs })
      .then((loaded) => {
        if (cancelled) return;
        setBuckets(loaded.buckets);
        setOpenings(loaded.openings);
      })
      .catch((nextError) => !cancelled && setError(nextError instanceof Error ? nextError.message : "Readings could not be loaded."));
    return () => {
      cancelled = true;
    };
  }, [atMs, deviceId, pairingName, projectId]);
  if (error) return <p className="px-notice is-bad">{error}</p>;
  if (!buckets) return <p className="px-muted px-small">Loading readings around the change…</p>;
  const step = calibrationStep(buckets, atMs);
  const domain = { startMs: atMs - 6 * 3_600_000, endMs: atMs + 6 * 3_600_000 };
  const series = (key: "vwc" | "raw") => calibrationSegments(buckets, key);
  const extent = (key: "vwc" | "raw"): [number, number] => {
    const values = series(key).flatMap((segment) => segment.map((point) => point.value));
    if (!values.length) return [0, 1];
    const low = Math.min(...values);
    const high = Math.max(...values);
    const pad = Math.max((high - low) * 0.1, Math.abs(high) * 0.01, 0.5);
    return [low - pad, high + pad];
  };
  const shade = [{ startMs: atMs - 60_000, endMs: atMs + 60_000, label: "calibration applied" }];
  const ticks = openings.map((timestampMs) => ({ timestampMs }));
  return (
    <div className="px-record-explain">
      <p className="px-record-detail">
        {step == null
          ? "There are not enough readings on both sides of the change to compare."
          : step.conclusion === "calibration"
            ? `On ${potsText([pairingName])}, calibrated VWC moved from ${step.calibratedBefore.toFixed(1)}% to ${step.calibratedAfter.toFixed(1)}% while the raw sensor output changed by only ${step.rawChangePercent.toFixed(1)}%. The ratio of calibrated VWC to raw output changed by ${step.ratioChangePercent >= 0 ? "+" : ""}${step.ratioChangePercent.toFixed(1)}%: this is consistent with a calibration change${name ? ` (${name})` : ""}. These readings alone cannot establish whether water changed in the pot.`
            : step.conclusion === "physical-too"
              ? `The calibrated/raw ratio changed by ${step.ratioChangePercent.toFixed(1)}%, but the raw output also moved by ${step.rawChangePercent.toFixed(1)}%: something physical may have happened at the same time. Check notes and valve openings.`
              : `The calibrated/raw ratio did not change noticeably here (${step.ratioChangePercent.toFixed(1)}%).`}
      </p>
      <div className="px-record-explain-charts">
        <TimeSeriesChart compact height={130} lines={[{ id: "vwc", label: "Calibrated VWC", color: "#1f6f4a", segments: series("vwc") }]} shades={shade} ticks={ticks} domain={domain} yDomain={extent("vwc")} ariaLabel={`Calibrated VWC around the change, ${potsText([pairingName])}`} />
        <TimeSeriesChart compact height={130} lines={[{ id: "raw", label: "Raw sensor output", color: "#5b4a8a", dash: "5 3", segments: series("raw") }]} shades={shade} ticks={ticks} domain={domain} yDomain={extent("raw")} ariaLabel={`Raw sensor output around the change, ${potsText([pairingName])}`} />
      </div>
      <p className="px-muted px-small">Left: calibrated VWC (% VWC). Right: raw sensor output (sensor units, its own scale). 10-minute means, 6 hours either side; the shaded line marks when the controller confirmed the calibration{openings.length ? `, and ticks along the bottom are valve openings the controller recorded for this pot (${openings.length}) — controller events, not measured water` : ""}.</p>
    </div>
  );
}
