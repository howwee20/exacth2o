import { useCallback, useEffect, useMemo, useState } from "react";
import { experimentFactors } from "../experimentFactors";
import { experimentIsCompleted } from "../experimentMeasurement";
import type { PortalExperiment } from "../experimentRegistry";
import { formatMeasurementTime } from "../measurementFreshness";
import { navigatePortal, portalRouteUrl } from "../portalRoute";
import { loadAlignmentEvents, type AlignmentEvent } from "../recordClient";
import type { PairingRow } from "../types";
import { measures, type Measure } from "../waterline";
import {
  addExclusion,
  createComparison,
  emptyStats,
  listComparisons,
  loadComparison,
  loadExclusions,
  loadReadingBuckets,
  revokeExclusion,
  updateComparison,
  type ComparisonRow,
  type FetchStats,
} from "../workbenchClient";
import {
  activeExclusions,
  comparisonCsv,
  comparisonGroups,
  comparisonSidecar,
  comparisonSvg,
  computeComparison,
  defaultDefinition,
  eventDayTicks,
  exclusionRanges,
  exclusionScopeText,
  gapStatement,
  parseDefinition,
  potsText,
  rangeStatement,
  resolveWindow,
  seriesSegments,
  significanceStatement,
  valueDomain,
  weightingStatement,
  type ComparisonDefinition,
  type Exclusion,
  type PotBucket,
} from "../workbenchModel";
import { useCopyRoute } from "./PortalLink";
import { TimeSeriesChart, timeTicks, type ChartBand, type ChartLine } from "./TimeSeriesChart";
import { GroupGlyph } from "./WaterlineOverview";
import "./product.css";

const day = 86_400_000;
const windowPresets = [
  { id: "3", label: "72 h", days: 3 },
  { id: "7", label: "7 days", days: 7 },
  { id: "14", label: "14 days", days: 14 },
  { id: "30", label: "30 days", days: 30 },
];

function download(name: string, type: string, body: string) {
  const url = URL.createObjectURL(new Blob([body], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function fileStem(question: string, atMs: number) {
  const slug = question.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "comparison";
  return `${slug}-${new Date(atMs).toISOString().slice(0, 10)}`;
}

const isoDate = (ms: number) => new Date(ms - new Date(ms).getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
const formatTime = (iso: string) => formatMeasurementTime(iso) ?? iso;

export function WorkbenchView({
  projectId,
  deviceId,
  userId,
  authorLabel,
  experiments,
  pairings,
  comparisonId,
  experimentId,
  canSave,
  build,
}: {
  projectId: string;
  deviceId: string;
  userId: string | null;
  authorLabel: string;
  experiments: readonly PortalExperiment[];
  pairings: readonly PairingRow[];
  comparisonId: string | null;
  experimentId: string | null;
  canSave: boolean;
  build: string;
}) {
  const [saved, setSaved] = useState<ComparisonRow[]>([]);
  const [savedError, setSavedError] = useState<string | null>(null);
  const [current, setCurrent] = useState<ComparisonRow | null>(null);
  const [missing, setMissing] = useState(false);
  const [question, setQuestion] = useState("");
  const [definition, setDefinition] = useState<ComparisonDefinition | null>(null);
  const [sharing, setSharing] = useState<"private" | "project">("private");
  const [exclusions, setExclusions] = useState<Exclusion[]>([]);
  const [anchorMs, setAnchorMs] = useState(() => Date.now());
  const [buckets, setBuckets] = useState<PotBucket[]>([]);
  const [stats, setStats] = useState<FetchStats>(emptyStats());
  const [loading, setLoading] = useState(false);
  const [loadedQueryKey, setLoadedQueryKey] = useState<string | null>(null);
  const [events, setEvents] = useState<AlignmentEvent[]>([]);
  const [eventsError, setEventsError] = useState<string | null>(null);
  const [loadedEventKey, setLoadedEventKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const { copied, copy } = useCopyRoute();

  const refreshSaved = useCallback(async () => {
    try {
      setSaved(await listComparisons(projectId));
      setSavedError(null);
    } catch (error) {
      setSavedError(error instanceof Error ? error.message : "Saved comparisons could not be loaded.");
    }
  }, [projectId]);

  useEffect(() => {
    void refreshSaved();
  }, [refreshSaved]);

  // Open a saved comparison, or start a new one for the chosen (or first) experiment.
  useEffect(() => {
    let cancelled = false;
    setProblem(null);
    setNotice(null);
    setDefinition(null);
    setCurrent(null);
    setExclusions([]);
    if (comparisonId) {
      setMissing(false);
      void loadComparison(comparisonId).then(async (row) => {
        if (cancelled) return;
        const parsed = row ? parseDefinition(row.definition) : null;
        if (!row || !parsed || !experiments.some((experiment) => experiment.id === parsed.experimentId)) {
          setMissing(true);
          setCurrent(null);
          return;
        }
        const nextExclusions = await loadExclusions(row.id);
        if (cancelled) return;
        setCurrent(row);
        setQuestion(row.question);
        setDefinition(parsed);
        setSharing(row.sharing);
        setAnchorMs(Date.now());
        setExclusions(nextExclusions);
      }).catch((error) => {
        if (!cancelled) setProblem(`Comparison could not be opened: ${error instanceof Error ? error.message : "read failed"}. Its exclusions have not been verified. Reopen it to retry.`);
      });
    } else {
      const now = Date.now();
      const experiment = experiments.find((item) => item.id === experimentId)
        ?? experiments.find((item) => !experimentIsCompleted(item, now))
        ?? experiments[0];
      setCurrent(null);
      setMissing(false);
      setExclusions([]);
      setQuestion("");
      setSharing("private");
      setDefinition(experiment ? defaultDefinition(experiment, experimentIsCompleted(experiment, now)) : null);
    }
    return () => {
      cancelled = true;
    };
  }, [comparisonId, experimentId, experiments]);

  const experiment = definition ? experiments.find((item) => item.id === definition.experimentId) ?? null : null;
  const factors = useMemo(() => experimentFactors(experiment), [experiment]);
  const groups = useMemo(() => (experiment && definition ? comparisonGroups(experiment, definition.grouping) : []), [definition, experiment]);
  const range = useMemo(() => (definition ? resolveWindow(definition, anchorMs) : null), [anchorMs, definition]);
  const activeRanges = useMemo(() => exclusionRanges(exclusions), [exclusions]);
  const potNames = useMemo(() => (experiment ? [...experiment.pairingNames] : []), [experiment]);
  const eventKey = experiment ? JSON.stringify([projectId, deviceId, experiment.id, experiment.startedAt, potNames]) : null;

  useEffect(() => {
    if (!experiment) return;
    let cancelled = false;
    setEventsError(null);
    void loadAlignmentEvents({
      projectId,
      deviceId,
      experimentDatabaseId: experiment.databaseId ?? null,
      startedAt: experiment.startedAt ?? null,
      pairingNames: experiment.pairingNames,
    }).then((list) => {
      if (cancelled) return;
      setEvents(list);
      setLoadedEventKey(eventKey);
    }).catch((error) => {
      if (cancelled) return;
      setEvents([]);
      setEventsError(`Plan and calibration history could not be verified (${error instanceof Error ? error.message : "read failed"}). Reopen the comparison to retry.`);
    });
    return () => {
      cancelled = true;
    };
  }, [deviceId, experiment, projectId, eventKey]);

  const queryKey = range && potNames.length ? JSON.stringify([projectId, deviceId, comparisonId, potNames, range.queryStartMs, range.endMs, range.bucketMs, activeRanges]) : null;
  useEffect(() => {
    if (!queryKey || !range) return;
    let cancelled = false;
    const nextStats = emptyStats();
    setLoading(true);
    void loadReadingBuckets({ projectId, deviceId, pairingNames: potNames, window: range, exclusions: activeRanges }, nextStats)
      .then((rows) => {
        if (cancelled) return;
        setBuckets(rows);
        setStats(nextStats);
        setLoadedQueryKey(queryKey);
      })
      .catch((error) => {
        if (cancelled) return;
        nextStats.failed += 1;
        setStats(nextStats);
        setBuckets([]);
        setProblem(`Readings could not be loaded (${error instanceof Error ? error.message : "read failed"}).`);
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
    // The key captures every input of the query.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryKey]);

  const result = useMemo(
    () => (definition && range && queryKey === loadedQueryKey ? computeComparison({ groups, buckets, measure: definition.measure, window: range, hiddenGroups: definition.hiddenGroups }) : null),
    [buckets, definition, groups, range, queryKey, loadedQueryKey],
  );
  const exportReady = Boolean(result && !loading && stats.failed === 0 && !eventsError && eventKey === loadedEventKey);

  if (!experiments.length) {
    return <section className="px-page"><h1 className="px-title">Workbench</h1><p className="px-empty">No experiment is visible to this account, so there is nothing to compare.</p></section>;
  }

  const owner = Boolean(current && userId && current.created_by === userId);
  const editable = canSave && (!current || owner);
  const dirty = Boolean(current && definition && (current.question !== question.trim() || current.sharing !== sharing || JSON.stringify(parseDefinition(current.definition)) !== JSON.stringify(definition)));
  const update = (patch: Partial<ComparisonDefinition>) => setDefinition((value) => (value ? { ...value, ...patch } : value));
  const info = definition ? measures[definition.measure] : null;
  const aligned = definition?.alignment.kind === "event";
  const questionOk = question.trim().length >= 3;

  const save = async (asNew: boolean) => {
    if (!definition || !experiment) return;
    setBusy(true);
    setProblem(null);
    try {
      if (current && owner && !asNew) {
        const row = await updateComparison(current.id, { question: question.trim(), definition, sharing });
        setCurrent(row);
        setNotice("Saved.");
      } else {
        const row = await createComparison({ projectId, deviceId, experimentDatabaseId: experiment.databaseId ?? null, question: question.trim(), definition, sharing, authorLabel });
        setNotice("Saved. Exclusions can now be recorded for this comparison.");
        navigatePortal({ view: "workbench", comparison: row.id, experiment: null });
      }
      await refreshSaved();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "The comparison could not be saved.");
    } finally {
      setBusy(false);
    }
  };

  const chart = (() => {
    if (!result || !range || !definition) return null;
    const lines: ChartLine[] = [];
    const bands: ChartBand[] = [];
    for (const { group, buckets: groupBuckets } of result.series) {
      if (definition.hiddenGroups.includes(group.id)) continue;
      const segments = seriesSegments(groupBuckets, range.bucketMs);
      bands.push({ id: `${group.id}-band`, color: group.pattern.color, opacity: 0.14, segments: segments.bands });
      lines.push({ id: group.id, label: group.label, color: group.pattern.color, dash: group.pattern.dash, width: 2, segments: segments.lines });
    }
    return { lines, bands, yDomain: valueDomain(result, definition.hiddenGroups) };
  })();
  const xAxis = aligned && range ? (domain: { startMs: number; endMs: number }, width: number) => eventDayTicks(domain, range.originMs, width) : undefined;

  const exportFooter = () => {
    if (!definition || !range || !result) return [];
    const active = activeExclusions(exclusions);
    return [
      `${weightingStatement.split(". ")[0]}. Median across pots; band = lowest to highest pot (not a confidence interval). ${range.bucketMs / 60_000}-minute buckets.`,
      `${result.totals.readings} readings used; ${result.totals.excluded} excluded by ${active.length} recorded ${active.length === 1 ? "exclusion" : "exclusions"}${active.length ? ` (${active.map((item) => item.reason).join("; ").slice(0, 120)})` : ""}.`,
      `${definition.hiddenGroups.length ? `Hidden from this figure only: ${result.summaries.filter((summary) => summary.hidden).map((summary) => summary.label).join(", ")}. ` : ""}No significance test computed. Exact H2O research portal, ${new Date().toISOString().slice(0, 16)}Z.`,
    ];
  };
  const subtitle = () => experiment && definition && range
    ? `${experiment.name} · ${measures[definition.measure].label} (${measures[definition.measure].unit}) · ${formatTime(new Date(range.queryStartMs).toISOString())} – ${formatTime(new Date(range.endMs).toISOString())}${definition.alignment.kind === "event" ? ` · aligned to ${definition.alignment.label}` : ""}`
    : "";
  const sidecar = () => experiment && definition && range && result
    ? comparisonSidecar({
      question: question.trim() || "(untitled comparison)",
      comparisonId: current?.id ?? null,
      sharing: current?.sharing ?? null,
      authorLabel: current?.author_label ?? null,
      generatedAtIso: new Date().toISOString(),
      build,
      projectId,
      deviceId,
      experiment: { id: experiment.id, databaseId: experiment.databaseId ?? null, name: experiment.name, revision: experiment.currentVersion ?? null },
      pots: groups.flatMap((group) => group.pairingNames.map((name, index) => {
        const pairing = pairings.find((item) => item.name === name);
        return { pairingName: name, potNumber: group.potNumbers[index] ?? pairing?.pot_number ?? 0, groupId: group.id, calibrationNow: pairing?.calibration_name || pairing?.calibration_label || pairing?.calibration || null };
      })),
      definition,
      window: range,
      exclusions,
      result,
      calibrationEvents: events.filter((event) => event.kind === "calibration" && Date.parse(event.atIso) >= range.queryStartMs && Date.parse(event.atIso) <= range.endMs).map((event) => ({ atIso: event.atIso, label: event.label, pots: event.pairingNames ?? [] })),
      query: { requests: stats.requests, rows: stats.rows, bytes: stats.bytes, failed: stats.failed },
    })
    : null;

  return (
    <section className="px-page is-wide" aria-label="Workbench">
      <div className="px-exp-head">
        <h1 className="px-title">Workbench</h1>
        <p className="px-subtitle"><span>Compare groups of pots over time. A saved comparison keeps its question, settings and exclusions, and can be shared with the project.</span></p>
      </div>
      <div className="px-wb">
        <aside className="px-wb-list" aria-label="Saved comparisons">
          <h2 className="px-section-label">Saved comparisons</h2>
          <button type="button" className="px-button is-small" onClick={() => navigatePortal({ view: "workbench", comparison: null, experiment: experiment?.id ?? null })}>New comparison</button>
          {savedError ? <p className="px-notice is-bad">{savedError}</p> : null}
          {saved.length ? (
            <ul>
              {saved.map((row) => (
                <li key={row.id}>
                  <a
                    href={portalRouteUrl({ view: "workbench", comparison: row.id, experiment: null })}
                    aria-current={row.id === current?.id ? "page" : undefined}
                    onClick={(event) => {
                      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
                      event.preventDefault();
                      navigatePortal({ view: "workbench", comparison: row.id, experiment: null });
                    }}
                  >
                    {row.question}
                  </a>
                  <span className="px-muted px-small">{row.created_by === userId ? "Yours" : row.author_label} · {row.sharing === "project" ? "shared" : "only you"} · {formatTime(row.updated_at)}</span>
                </li>
              ))}
            </ul>
          ) : <p className="px-muted px-small">None yet.</p>}
        </aside>

        <div className="px-wb-main">
          {eventsError ? <p className="px-notice is-bad" role="alert">{eventsError} Exports are paused until the history can be loaded.</p> : null}
          {problem && !definition ? <p className="px-notice is-bad" role="alert">{problem}</p> : null}
          {missing ? (
            <p className="px-empty" role="alert">This comparison is not shared with this account, its experiment is not visible to this account, or it no longer exists.</p>
          ) : !definition || !experiment || !range ? (
            <p className="px-empty">{problem ? "No comparison has been opened." : "Loading…"}</p>
          ) : (
            <>
              <label className="px-wb-question">
                <span>Question</span>
                <input
                  value={question}
                  maxLength={200}
                  readOnly={!editable}
                  placeholder="What are you asking? e.g. Did the deficit pots dry faster after the plan change?"
                  onChange={(event) => setQuestion(event.target.value)}
                />
              </label>
              {current && !owner ? <p className="px-muted px-small">Saved by {current.author_label} and shared with the project. You can explore and export it; only they can change it or its exclusions.</p> : null}

              <div className="px-toolbar px-wb-controls">
                <label className="px-select">
                  Experiment
                  <select value={experiment.id} disabled={Boolean(current)} onChange={(event) => {
                    const next = experiments.find((item) => item.id === event.target.value);
                    if (next) setDefinition(defaultDefinition(next, experimentIsCompleted(next, Date.now())));
                  }}>
                    {experiments.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                  </select>
                </label>
                <label className="px-select">
                  Group by
                  <select value={definition.grouping} onChange={(event) => update({ grouping: event.target.value, hiddenGroups: [] })}>
                    {factors.some((factor) => factor.key === "treatment") && factors.some((factor) => factor.key === "crop") ? <option value="treatment,crop">Treatment × crop</option> : null}
                    {factors.map((factor) => <option key={factor.key} value={factor.key}>{factor.label}</option>)}
                    <option value="none">All pots together</option>
                    <option value="pot">Each pot</option>
                  </select>
                </label>
                <label className="px-select">
                  Measure
                  <select value={definition.measure} onChange={(event) => update({ measure: event.target.value as Measure })}>
                    {(Object.keys(measures) as Measure[]).map((item) => <option key={item} value={item}>{measures[item].label}</option>)}
                  </select>
                </label>
              </div>

              <div className="px-toolbar px-wb-controls">
                <div className="px-segmented" role="group" aria-label="Time axis">
                  <button type="button" aria-pressed={!aligned} onClick={() => update({ alignment: { kind: "calendar" }, window: definition.window.kind === "around" ? { kind: "last", days: 7 } : definition.window })}>Calendar time</button>
                  <button type="button" aria-pressed={aligned} disabled={!events.length} onClick={() => {
                    const event = events[events.length - 1];
                    if (event) update({ alignment: { kind: "event", eventKey: event.key, label: event.label, atIso: event.atIso }, window: { kind: "around", beforeDays: 2, afterDays: 7 } });
                  }}>Days since an event</button>
                </div>
                {aligned && definition.alignment.kind === "event" ? (
                  <>
                    <label className="px-select">
                      Event
                      <select value={definition.alignment.eventKey} onChange={(event) => {
                        const chosen = events.find((item) => item.key === event.target.value);
                        if (chosen) update({ alignment: { kind: "event", eventKey: chosen.key, label: chosen.label, atIso: chosen.atIso } });
                      }}>
                        {events.map((item) => <option key={item.key} value={item.key}>{item.label} · {formatTime(item.atIso)}</option>)}
                      </select>
                    </label>
                    {definition.window.kind === "around" ? (
                      <>
                        <label className="px-select">Days before <input type="number" min={0} max={60} value={definition.window.beforeDays} onChange={(event) => update({ window: { kind: "around", beforeDays: Math.max(0, Math.min(60, Number(event.target.value) || 0)), afterDays: definition.window.kind === "around" ? definition.window.afterDays : 7 } })} style={{ width: 64 }} /></label>
                        <label className="px-select">after <input type="number" min={1} max={60} value={definition.window.afterDays} onChange={(event) => update({ window: { kind: "around", beforeDays: definition.window.kind === "around" ? definition.window.beforeDays : 2, afterDays: Math.max(1, Math.min(60, Number(event.target.value) || 1)) } })} style={{ width: 64 }} /></label>
                      </>
                    ) : null}
                  </>
                ) : (
                  <>
                    <div className="px-segmented" role="group" aria-label="Window">
                      {windowPresets.map((preset) => (
                        <button key={preset.id} type="button" aria-pressed={definition.window.kind === "last" && definition.window.days === preset.days} onClick={() => update({ window: { kind: "last", days: preset.days } })}>{preset.label}</button>
                      ))}
                      {experiment.startedAt ? (
                        <button type="button" aria-pressed={definition.window.kind === "range"} onClick={() => update({ window: { kind: "range", startIso: experiment.startedAt as string, endIso: experiment.endedAt ?? new Date(anchorMs).toISOString() } })}>Since start</button>
                      ) : null}
                    </div>
                    {definition.window.kind === "range" ? (
                      <>
                        <label className="px-select">From <input type="date" value={isoDate(Date.parse(definition.window.startIso))} onChange={(event) => event.target.value && update({ window: { kind: "range", startIso: new Date(`${event.target.value}T00:00`).toISOString(), endIso: definition.window.kind === "range" ? definition.window.endIso : new Date(anchorMs).toISOString() } })} /></label>
                        <label className="px-select">to <input type="date" value={isoDate(Date.parse(definition.window.endIso))} onChange={(event) => event.target.value && update({ window: { kind: "range", startIso: definition.window.kind === "range" ? definition.window.startIso : new Date(anchorMs - 7 * day).toISOString(), endIso: new Date(`${event.target.value}T23:59`).toISOString() } })} /></label>
                      </>
                    ) : null}
                  </>
                )}
                <label className="px-select">
                  Buckets
                  <select value={definition.bucketMinutes ?? ""} onChange={(event) => update({ bucketMinutes: event.target.value ? Number(event.target.value) : null })}>
                    <option value="">Automatic ({range.bucketMs / 60_000 >= 60 ? `${range.bucketMs / 3_600_000} h` : `${range.bucketMs / 60_000} min`})</option>
                    {[30, 60, 120, 360, 720, 1440].map((minutes) => <option key={minutes} value={minutes}>{minutes >= 60 ? `${minutes / 60} h` : `${minutes} min`}</option>)}
                  </select>
                </label>
                <button type="button" className="px-button is-small is-quiet" onClick={() => setAnchorMs(Date.now())}>Refresh to now</button>
              </div>

              <p className="px-muted px-small" role="status" aria-live="polite">
                {loading ? "Loading…" : `${formatTime(new Date(range.queryStartMs).toISOString())} – ${formatTime(new Date(range.endMs).toISOString())} · ${range.bucketMs >= 3_600_000 ? `${range.bucketMs / 3_600_000}-hour` : `${range.bucketMs / 60_000}-minute`} buckets · ${stats.requests} ${stats.requests === 1 ? "request" : "requests"}, ${stats.rows.toLocaleString()} rows (${Math.round(stats.bytes / 1024)} kB)`}
              </p>
              {range.clipped ? <p className="px-notice" role="status">The range was cut to the most recent 120 days, the longest one comparison covers.</p> : null}
              {stats.failed ? <p className="px-notice is-bad" role="alert">{stats.failed} of {stats.requests} data requests failed, so the figure, statistics and exports are incomplete. <button type="button" className="px-link-button" onClick={() => setAnchorMs(Date.now())}>Try again</button></p> : null}

              {chart ? (
                <TimeSeriesChart
                  lines={chart.lines}
                  bands={chart.bands}
                  domain={{ startMs: range.queryStartMs, endMs: range.endMs }}
                  yDomain={chart.yDomain}
                  height={320}
                  xAxis={xAxis}
                  ariaLabel={`${info?.label} by ${groups.length} groups`}
                  description={<>Lines are the median across each group's pots; bands run from the lowest to the highest pot. Empty stretches are gaps where fewer than half the group reported.</>}
                  emptyText={loading ? "Loading…" : "No readings in this range."}
                  readout={(at) => {
                    const index = result?.bucketStarts.findIndex((start) => at >= start && at < start + range.bucketMs) ?? -1;
                    if (!result || index < 0) return null;
                    return {
                      title: aligned ? `${formatTime(new Date(result.bucketStarts[index]).toISOString())}` : formatTime(new Date(result.bucketStarts[index]).toISOString()) ?? "",
                      rows: result.series.filter(({ group }) => !definition.hiddenGroups.includes(group.id)).map(({ group, buckets: groupBuckets }) => {
                        const bucket = groupBuckets[index];
                        return {
                          label: group.label,
                          value: bucket.gap ? `gap (${bucket.reporting} of ${bucket.planned} pots)` : `${bucket.median?.toFixed(info?.digits ?? 1)} (${bucket.low?.toFixed(info?.digits ?? 1)}–${bucket.high?.toFixed(info?.digits ?? 1)}), ${bucket.reporting}/${bucket.planned} pots`,
                        };
                      }),
                    };
                  }}
                />
              ) : null}

              {result ? (
                <div className="px-table-wrap">
                  <table className="px-table px-wb-stats">
                    <caption className="px-sr-only">Statistics for each group over the window</caption>
                    <thead>
                      <tr>
                        <th scope="col">Group</th>
                        <th scope="col">In figure</th>
                        <th scope="col">Pots with data</th>
                        <th scope="col">Window value: median (lowest–highest pot)</th>
                        <th scope="col">Coverage</th>
                        <th scope="col">Readings used</th>
                        <th scope="col">Excluded</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.series.map(({ group }, index) => {
                        const summary = result.summaries[index];
                        return (
                          <tr key={group.id}>
                            <th scope="row"><span className="px-legend-item"><GroupGlyph group={group} /> {group.label}</span></th>
                            <td>
                              <input
                                type="checkbox"
                                aria-label={`Show ${group.label} in the figure`}
                                checked={!summary.hidden}
                                onChange={(event) => update({ hiddenGroups: event.target.checked ? definition.hiddenGroups.filter((id) => id !== group.id) : [...definition.hiddenGroups, group.id] })}
                              />
                            </td>
                            <td className="px-num">{summary.contributing} of {summary.planned}{summary.potsWithoutData.length ? <span className="px-muted"> · none from {potsText(group.pairingNames.filter((_, i) => summary.potsWithoutData.includes(group.potNumbers[i])))}</span> : null}</td>
                            <td className="px-num">{summary.windowMedian == null ? "—" : `${summary.windowMedian.toFixed(info?.digits ?? 1)} (${summary.windowLow?.toFixed(info?.digits ?? 1)}–${summary.windowHigh?.toFixed(info?.digits ?? 1)})`} {info?.shortUnit}</td>
                            <td className="px-num">{Math.round(summary.coverage * 100)}%</td>
                            <td className="px-num">{summary.readings.toLocaleString()}</td>
                            <td className="px-num">{summary.excluded.toLocaleString()}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : null}
              {definition.hiddenGroups.length ? <p className="px-muted px-small">Hiding a group only changes the figure. Its statistics stay above and its data stays in every export.</p> : null}

              <details className="px-definition">
                <summary>How these numbers are made</summary>
                <dl>
                  <dt>Weighting</dt><dd>{weightingStatement}</dd>
                  <dt>Band</dt><dd>{rangeStatement}</dd>
                  <dt>Gaps</dt><dd>{gapStatement}</dd>
                  <dt>Coverage</dt><dd>The share of buckets in which at least half of the group's pots reported.</dd>
                  <dt>Significance</dt><dd>{significanceStatement}</dd>
                  <dt>Measure</dt><dd>{info?.definition}</dd>
                  <dt>Time axis</dt><dd>{definition.alignment.kind === "event" ? `Days since “${definition.alignment.label}” (${formatTime(definition.alignment.atIso)}); buckets start at that moment.` : "Calendar time; buckets start at local midnight."}</dd>
                </dl>
              </details>

              <ExclusionsPanel
                exclusions={exclusions}
                saved={Boolean(current)}
                canEdit={Boolean(current && owner && canSave)}
                pots={experiment.pairingNames}
                defaultStartMs={range.queryStartMs}
                defaultEndMs={range.endMs}
                onAdd={async (input) => {
                  if (!current) return;
                  const row = await addExclusion({ ...input, comparisonId: current.id, projectId, authorLabel });
                  setExclusions((list) => [...list, row]);
                }}
                onRevoke={async (id, reason) => {
                  const row = await revokeExclusion(id, reason);
                  setExclusions((list) => list.map((item) => (item.id === id ? row : item)));
                }}
              />

              <div className="px-wb-actions">
                {editable ? (
                  <>
                    <label className="px-select">
                      Sharing
                      <select value={sharing} onChange={(event) => setSharing(event.target.value as "private" | "project")}>
                        <option value="private">Only me</option>
                        <option value="project">Everyone on this project</option>
                      </select>
                    </label>
                    <button type="button" className="px-button is-primary" disabled={busy || !questionOk || (Boolean(current) && !dirty)} onClick={() => void save(false)}>
                      {busy ? "Saving…" : current ? (dirty ? "Save changes" : "Saved") : "Save comparison"}
                    </button>
                    {current ? <button type="button" className="px-button is-small is-quiet" disabled={busy || !questionOk} onClick={() => void save(true)}>Save as new</button> : null}
                    {current && owner ? <button type="button" className="px-button is-small is-quiet" disabled={busy} onClick={async () => {
                      if (!window.confirm("Archive this comparison? It disappears from the list; its exclusions stay in the database.")) return;
                      await updateComparison(current.id, { archived_at: new Date().toISOString() });
                      await refreshSaved();
                      navigatePortal({ view: "workbench", comparison: null, experiment: experiment.id });
                    }}>Archive</button> : null}
                  </>
                ) : canSave && current ? (
                  <button type="button" className="px-button is-small" disabled={busy || !questionOk} onClick={() => void save(true)}>Save a copy as mine</button>
                ) : null}
                {!questionOk && editable ? <span className="px-muted px-small">Write the question first; it is the comparison's title.</span> : null}
                {current ? <button type="button" className="px-button is-small is-quiet" onClick={() => void copy({ view: "workbench", comparison: current.id, experiment: null })}>{copied ?? "Copy link"}</button> : null}
              </div>
              <div className="px-wb-actions" role="group" aria-label="Export">
                <span className="px-muted px-small">{stats.failed ? "Exports paused: retry the incomplete reading load." : "Export what is shown, with the same exclusions:"}</span>
                <button type="button" className="px-button is-small" disabled={!exportReady} onClick={() => {
                  if (!result) return;
                  const ticks = aligned ? eventDayTicks({ startMs: range.queryStartMs, endMs: range.endMs }, range.originMs, 872) : timeTicks({ startMs: range.queryStartMs, endMs: range.endMs }, 872);
                  download(`${fileStem(question, anchorMs)}.svg`, "image/svg+xml", comparisonSvg({ question: question.trim() || "Untitled comparison", subtitle: subtitle(), result, window: range, measure: definition.measure, hiddenGroups: definition.hiddenGroups, xTicks: ticks, footer: exportFooter() }));
                }}>Figure (SVG)</button>
                <button type="button" className="px-button is-small" disabled={!exportReady} onClick={() => result && download(`${fileStem(question, anchorMs)}.csv`, "text/csv", comparisonCsv(result, definition.measure, range))}>Data (CSV)</button>
                <button type="button" className="px-button is-small" disabled={!exportReady} onClick={() => {
                  const body = sidecar();
                  if (body) download(`${fileStem(question, anchorMs)}.methods.json`, "application/json", `${JSON.stringify(body, null, 2)}\n`);
                }}>Methods (JSON)</button>
              </div>
              {notice ? <p className="px-notice is-info" role="status">{notice}</p> : null}
              {problem ? <p className="px-notice is-bad" role="alert">{problem}</p> : null}
            </>
          )}
        </div>
      </div>
    </section>
  );
}

function ExclusionsPanel({
  exclusions,
  saved,
  canEdit,
  pots,
  defaultStartMs,
  defaultEndMs,
  onAdd,
  onRevoke,
}: {
  exclusions: readonly Exclusion[];
  saved: boolean;
  canEdit: boolean;
  pots: readonly string[];
  defaultStartMs: number;
  defaultEndMs: number;
  onAdd: (input: { pairingName: string | null; startsAt: string | null; endsAt: string | null; reason: string }) => Promise<void>;
  onRevoke: (id: string, reason: string) => Promise<void>;
}) {
  const local = (ms: number) => new Date(ms - new Date(ms).getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  const [open, setOpen] = useState(false);
  const [pot, setPot] = useState("");
  const [from, setFrom] = useState(() => local(defaultStartMs));
  // Open-ended by default: a fault excluded "from then" stays excluded until revoked.
  const [to, setTo] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const active = activeExclusions(exclusions);
  const revoked = exclusions.filter((item) => item.revokedAt);
  return (
    <section className="px-card px-wb-exclusions" aria-label="Exclusions">
      <div className="px-toolbar">
        <h2 className="px-section-label">Exclusions</h2>
        <span className="px-muted px-small">{active.length ? `${active.length} applied to the statistics, figure and every export` : "None applied"}</span>
        <span className="px-spacer" />
        {canEdit ? <button type="button" className="px-button is-small" onClick={() => setOpen((value) => !value)}>{open ? "Close" : "Exclude readings…"}</button> : null}
      </div>
      {!saved ? <p className="px-muted px-small">Save the comparison to record exclusions. Each one keeps its scope, reason, author and time, and can be revoked later without losing the record.</p> : null}
      {open && canEdit ? (
        <form className="px-wb-exclusion-form" onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await onAdd({ pairingName: pot || null, startsAt: from ? new Date(from).toISOString() : null, endsAt: to ? new Date(to).toISOString() : null, reason: reason.trim() });
            setReason("");
            setOpen(false);
          } catch (nextError) {
            setError(nextError instanceof Error ? nextError.message : "The exclusion could not be recorded.");
          } finally {
            setBusy(false);
          }
        }}>
          <label className="px-select">Pots <select value={pot} onChange={(event) => setPot(event.target.value)}><option value="">Every pot in the comparison</option>{pots.map((name) => <option key={name} value={name}>{potsText([name])}</option>)}</select></label>
          <label className="px-select">From <input type="datetime-local" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
          <label className="px-select">to <input type="datetime-local" value={to} max={local(defaultEndMs)} onChange={(event) => setTo(event.target.value)} /><span className="px-muted px-small">{to ? "" : "empty: until revoked"}</span></label>
          <label className="px-select px-wb-reason">Reason <input value={reason} minLength={3} maxLength={500} required placeholder="e.g. Sensor unseated after the pot was moved" onChange={(event) => setReason(event.target.value)} /></label>
          <button type="submit" className="px-button is-primary is-small" disabled={busy || reason.trim().length < 3}>{busy ? "Recording…" : "Record exclusion"}</button>
          {error ? <p className="px-notice is-bad" role="alert">{error}</p> : null}
        </form>
      ) : null}
      {exclusions.length ? (
        <ol className="px-wb-exclusion-list">
          {active.map((item) => <ExclusionEntry key={item.id} item={item} canEdit={canEdit} onRevoke={onRevoke} />)}
          {revoked.map((item) => <ExclusionEntry key={item.id} item={item} canEdit={false} onRevoke={onRevoke} />)}
        </ol>
      ) : null}
    </section>
  );
}

function ExclusionEntry({ item, canEdit, onRevoke }: { item: Exclusion; canEdit: boolean; onRevoke: (id: string, reason: string) => Promise<void> }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <li className={item.revokedAt ? "is-revoked" : ""}>
      <p><b>{exclusionScopeText(item, formatTime)}</b> — {item.reason}</p>
      <p className="px-muted px-small">
        Added by {item.authorLabel}, {formatTime(item.createdAt)}
        {item.revokedAt ? ` · revoked by ${item.revokedByLabel ?? "a member"}, ${formatTime(item.revokedAt)}: ${item.revokeReason}` : ""}
      </p>
      {canEdit && !item.revokedAt ? (
        <button type="button" className="px-link-button" onClick={async () => {
          const reason = window.prompt("Why revoke this exclusion? The original stays in the record.");
          if (!reason || reason.trim().length < 3) return;
          try {
            await onRevoke(item.id, reason.trim());
          } catch (nextError) {
            setError(nextError instanceof Error ? nextError.message : "Could not revoke.");
          }
        }}>Revoke…</button>
      ) : null}
      {error ? <p className="px-notice is-bad" role="alert">{error}</p> : null}
    </li>
  );
}
