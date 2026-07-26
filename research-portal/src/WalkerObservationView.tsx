import {
  Activity,
  AlertTriangle,
  Archive,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Database,
  Loader2,
  Maximize2,
  Minimize2,
  Search,
  Server,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  filterWalkerSensors,
  isWalkerAccessDenied,
  walkerSmallMultipleGroups,
  type WalkerOverview,
  type WalkerSensor,
  type WalkerTraceSeries,
} from "./walkerObservation";
import {
  loadWalkerOverview,
  loadWalkerTraces,
} from "./walkerObservationClient";

const tracePalette = [
  "#0f766e",
  "#2563eb",
  "#c2410c",
  "#7c3aed",
  "#ca8a04",
  "#0891b2",
  "#db2777",
  "#16a34a",
  "#4f46e5",
  "#dc2626",
  "#65a30d",
  "#9333ea",
  "#0284c7",
  "#d97706",
  "#0d9488",
  "#be123c",
];

function dateTime(value?: string | null) {
  if (!value) return "Unavailable";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(value));
}

function compactNumber(value: number) {
  return new Intl.NumberFormat(undefined, { notation: "compact" }).format(value);
}

function TraceChart({
  series,
  label,
  allTraces = false,
}: {
  series: WalkerTraceSeries[];
  label: string;
  allTraces?: boolean;
}) {
  const points = series.flatMap((trace) => trace.points);
  if (!points.length) {
    return <div className="walker-chart-empty">No imported trace points.</div>;
  }
  const times = points.map((point) => Date.parse(point.at)).filter(Number.isFinite);
  const values = points
    .flatMap((point) => [point.minimum, point.maximum])
    .filter(Number.isFinite);
  const minTime = Math.min(...times);
  const maxTime = Math.max(...times);
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const padding = Math.max(1, (rawMax - rawMin) * 0.08);
  const minValue = rawMin - padding;
  const maxValue = rawMax + padding;
  const x = (at: string) =>
    48 + ((Date.parse(at) - minTime) / Math.max(1, maxTime - minTime)) * 724;
  const y = (value: number) =>
    188 - ((value - minValue) / Math.max(1, maxValue - minValue)) * 158;

  return (
    <div className={`walker-trace-chart${allTraces ? " is-all" : ""}`}>
      <svg viewBox="0 0 800 220" role="img" aria-label={label}>
        <title>{label}</title>
        {[0, 0.25, 0.5, 0.75, 1].map((fraction) => {
          const value = minValue + (maxValue - minValue) * fraction;
          const chartY = y(value);
          return (
            <g key={fraction}>
              <line x1="48" x2="772" y1={chartY} y2={chartY} className="walker-grid-line" />
              <text x="40" y={chartY + 4} textAnchor="end" className="walker-axis-label">
                {value.toFixed(0)}
              </text>
            </g>
          );
        })}
        {series.map((trace, index) => (
          <polyline
            key={trace.source_sensor_id}
            points={trace.points
              .map((point) => `${x(point.at).toFixed(1)},${y(point.average).toFixed(1)}`)
              .join(" ")}
            fill="none"
            stroke={tracePalette[index % tracePalette.length]}
            strokeWidth={allTraces ? 0.9 : 1.8}
            strokeOpacity={allTraces ? 0.42 : 0.88}
            vectorEffect="non-scaling-stroke"
          />
        ))}
        <text x="15" y="110" transform="rotate(-90 15 110)" className="walker-axis-title">
          Calibrated VWC (%)
        </text>
        <text x="48" y="211" className="walker-axis-label">
          {dateTime(new Date(minTime).toISOString())}
        </text>
        <text x="772" y="211" textAnchor="end" className="walker-axis-label">
          {dateTime(new Date(maxTime).toISOString())}
        </text>
      </svg>
    </div>
  );
}

function VirtualTraceCatalog({
  sensors,
  selected,
  onToggle,
}: {
  sensors: WalkerSensor[];
  selected: Set<number>;
  onToggle: (sensorId: number) => void;
}) {
  const rowHeight = 56;
  const viewportHeight = 448;
  const [scrollTop, setScrollTop] = useState(0);
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - 3);
  const visibleCount = Math.ceil(viewportHeight / rowHeight) + 6;
  const end = Math.min(sensors.length, start + visibleCount);

  return (
    <div
      className="walker-catalog-scroll"
      style={{ height: viewportHeight }}
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
    >
      <div style={{ height: sensors.length * rowHeight, position: "relative" }}>
        {sensors.slice(start, end).map((sensor, localIndex) => {
          const index = start + localIndex;
          return (
            <label
              className="walker-catalog-row"
              key={sensor.source_sensor_id}
              style={{ top: index * rowHeight, height: rowHeight }}
            >
              <input
                type="checkbox"
                checked={selected.has(sensor.source_sensor_id)}
                onChange={() => onToggle(sensor.source_sensor_id)}
              />
              <span className="walker-catalog-identity">
                <strong>{sensor.display_label}</strong>
                <small>{sensor.board_serial_id} · {sensor.sensor_address}</small>
              </span>
              <span className="walker-catalog-reading">
                <strong>
                  {sensor.latest_calibrated_value == null
                    ? "—"
                    : `${sensor.latest_calibrated_value.toFixed(1)}%`}
                </strong>
                <small>{compactNumber(sensor.reading_count)} rows</small>
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

export function WalkerAdminTile({ onOpen }: { onOpen: () => void }) {
  const [overview, setOverview] = useState<WalkerOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    let active = true;
    loadWalkerOverview()
      .then((nextOverview) => {
        if (active) setOverview(nextOverview);
      })
      .catch((error: { code?: string; message?: string }) => {
        if (active && isWalkerAccessDenied(error)) setVisible(false);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  if (!visible) return null;
  return (
    <button
      type="button"
      className="portal-launch-card is-walker"
      onClick={onOpen}
      disabled={loading || !overview}
    >
      <span className="portal-launch-top">
        <span className="portal-launch-icon">
          <Activity size={20} />
        </span>
        <span className="portal-status-pill is-warning">HISTORICAL</span>
      </span>
      <span className="portal-launch-copy">
        <span className="portal-launch-title">Walker Pi 5</span>
        <strong>
          {loading
            ? "Checking access..."
            : `${overview?.evidenced_sensor_count ?? 0} / ${overview?.expected_sensor_count ?? 100} traces`}
        </strong>
        <em>Last verified {dateTime(overview?.latest_verified_reading_at)}</em>
      </span>
      <span className="portal-launch-action">
        Open <ChevronRight size={14} />
      </span>
    </button>
  );
}

export function WalkerObservationView({ onBack }: { onBack: () => void }) {
  const [overview, setOverview] = useState<WalkerOverview | null>(null);
  const [series, setSeries] = useState<WalkerTraceSeries[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [board, setBoard] = useState("all");
  const [group, setGroup] = useState("all");
  const [mode, setMode] = useState<"groups" | "compare" | "all">("groups");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [comparisonExpanded, setComparisonExpanded] = useState(false);
  const initializedSelection = useRef(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    loadWalkerOverview()
      .then(async (nextOverview) => {
        if (!active) return;
        setOverview(nextOverview);
        if (!initializedSelection.current) {
          initializedSelection.current = true;
          setSelected(new Set(nextOverview.sensors.slice(0, 8).map((item) => item.source_sensor_id)));
        }
        const traces = await loadWalkerTraces(
          nextOverview.sensors.map((sensor) => sensor.source_sensor_id),
          240,
        );
        if (active) setSeries(traces.series);
      })
      .catch((reason: { message?: string }) => {
        if (active) setError(reason.message ?? "Walker historical data is unavailable.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const boards = useMemo(
    () => Array.from(new Set(overview?.sensors.map((sensor) => sensor.board_serial_id) ?? [])).sort(),
    [overview],
  );
  const groups = useMemo(
    () =>
      Array.from(
        new Set(overview?.sensors.map((sensor) => sensor.historical_group ?? "Ungrouped") ?? []),
      ).sort(),
    [overview],
  );
  const filteredSensors = useMemo(
    () => filterWalkerSensors(overview?.sensors ?? [], query, board, group),
    [board, group, overview, query],
  );
  const selectedSeries = useMemo(
    () => series.filter((trace) => selected.has(trace.source_sensor_id)),
    [selected, series],
  );
  const smallMultiples = useMemo(() => walkerSmallMultipleGroups(series), [series]);
  const sensorById = useMemo(
    () => new Map((overview?.sensors ?? []).map((sensor) => [sensor.source_sensor_id, sensor])),
    [overview],
  );

  const toggleSensor = (sensorId: number) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(sensorId)) {
        next.delete(sensorId);
      } else if (next.size < 12) {
        next.add(sensorId);
      }
      return next;
    });
  };

  if (loading) {
    return (
      <section className="walker-load-state" aria-live="polite">
        <Loader2 className="chart-loading-spinner" size={30} />
        <p>Loading verified Walker history...</p>
      </section>
    );
  }
  if (error || !overview) {
    return (
      <section className="walker-load-state" aria-live="polite">
        <AlertTriangle size={28} />
        <h1>Walker history is unavailable</h1>
        <p>{error}</p>
        <button type="button" className="header-action" onClick={onBack}>Home</button>
      </section>
    );
  }

  const missing = overview.inventory_discrepancy.missing_numeric_positions.join(", ");
  return (
    <section className="walker-observation" aria-label="Walker Pi 5 historical observation">
      <div className="walker-heading">
        <div>
          <span className="walker-eyebrow">SYSTEM ADMIN · HISTORICAL</span>
          <h1>Walker Pi 5</h1>
          <p>Verified archive · last reading {dateTime(overview.latest_verified_reading_at)}</p>
        </div>
        <div className="walker-heading-actions">
          <span className="walker-state-pill is-stale"><Clock3 size={14} /> Stale</span>
          <button type="button" className="header-action" onClick={onBack}>Home</button>
        </div>
      </div>

      <div className="walker-summary-grid">
        <article>
          <Server size={18} />
          <span>Trace inventory</span>
          <strong>{overview.evidenced_sensor_count} / {overview.expected_sensor_count}</strong>
          <small>Missing positions {missing}</small>
        </article>
        <article>
          <Database size={18} />
          <span>Verified readings</span>
          <strong>{overview.archive.imported_reading_count.toLocaleString()}</strong>
          <small>{dateTime(overview.archive.expected_first_at)} – {dateTime(overview.archive.expected_last_at)}</small>
        </article>
        <article>
          <Archive size={18} />
          <span>Completed archive</span>
          <strong>{overview.workspaces.find((item) => item.workspace_type === "completed_archive")?.name}</strong>
          <small>Immutable history</small>
        </article>
        <article>
          <Activity size={18} />
          <span>Algorithm workspace</span>
          <strong>{overview.workspaces.find((item) => item.workspace_type === "planned_validation")?.name}</strong>
          <small>Planned · no controller binding</small>
        </article>
      </div>

      <div className="walker-integrity-note" role="status">
        <AlertTriangle size={17} />
        <span>
          The archive contains 96 evidenced traces. Four expected numeric positions are absent;
          no records were invented. This page is read-only and is not a live device connection.
        </span>
      </div>

      <div className="walker-toolbar">
        <div className="walker-view-tabs" role="tablist" aria-label="Walker trace view">
          <button type="button" className={mode === "groups" ? "is-active" : ""} onClick={() => setMode("groups")}>
            Groups
          </button>
          <button type="button" className={mode === "compare" ? "is-active" : ""} onClick={() => setMode("compare")}>
            Compare {selected.size ? `(${selected.size})` : ""}
          </button>
          <button type="button" className={mode === "all" ? "is-active" : ""} onClick={() => setMode("all")}>
            All 96
          </button>
        </div>
        <span>{series.length} imported traces · calibrated VWC</span>
      </div>

      <div className="walker-data-layout">
        <aside className="walker-catalog">
          <div className="walker-catalog-title">
            <div>
              <strong>Trace catalog</strong>
              <small>{filteredSensors.length} shown · select up to 12</small>
            </div>
          </div>
          <label className="walker-search">
            <Search size={15} />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search label, ID, board"
            />
          </label>
          <div className="walker-filter-row">
            <select aria-label="Filter Walker board" value={board} onChange={(event) => setBoard(event.target.value)}>
              <option value="all">All boards</option>
              {boards.map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
            <select aria-label="Filter Walker historical group" value={group} onChange={(event) => setGroup(event.target.value)}>
              <option value="all">All groups</option>
              {groups.map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
          </div>
          <VirtualTraceCatalog sensors={filteredSensors} selected={selected} onToggle={toggleSensor} />
        </aside>

        <main className="walker-visuals">
          {mode === "groups" ? (
            <div className="walker-small-multiples">
              {smallMultiples.map((panel) => (
                <article key={panel.id}>
                  <header>
                    <strong>{panel.label}</strong>
                    <span>{panel.series.length} traces</span>
                  </header>
                  <TraceChart series={panel.series} label={`${panel.label} historical VWC`} />
                </article>
              ))}
            </div>
          ) : null}
          {mode === "compare" ? (
            <article className={`walker-comparison${comparisonExpanded ? " is-expanded" : ""}`}>
              <header>
                <div>
                  <strong>Selected trace comparison</strong>
                  <span>{selectedSeries.length} of 12 selected</span>
                </div>
                <button
                  type="button"
                  className="walker-expand"
                  onClick={() => setComparisonExpanded((current) => !current)}
                  aria-label={comparisonExpanded ? "Close fullscreen comparison" : "Open fullscreen comparison"}
                >
                  {comparisonExpanded ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
                </button>
              </header>
              {selectedSeries.length ? (
                <>
                  <div className="walker-legend">
                    {selectedSeries.map((trace, index) => (
                      <span key={trace.source_sensor_id}>
                        <i style={{ "--trace-color": tracePalette[index % tracePalette.length] } as CSSProperties} />
                        {sensorById.get(trace.source_sensor_id)?.display_label ?? trace.display_label}
                      </span>
                    ))}
                  </div>
                  <TraceChart series={selectedSeries} label="Selected Walker historical traces" />
                </>
              ) : (
                <div className="walker-chart-empty">Select traces from the catalog.</div>
              )}
            </article>
          ) : null}
          {mode === "all" ? (
            <article className="walker-comparison">
              <header>
                <div>
                  <strong>All evidenced traces</strong>
                  <span>Diagnostic view · {series.length} traces</span>
                </div>
                <CheckCircle2 size={17} />
              </header>
              <TraceChart series={series} label="All 96 Walker historical traces" allTraces />
            </article>
          ) : null}
        </main>
      </div>
    </section>
  );
}
