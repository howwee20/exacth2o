import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Database,
  LogOut,
  RefreshCw,
  UserCircle,
  Wifi,
  WifiOff,
} from "lucide-react";
import { supabase } from "./supabase";
import type { LatestState, PairingRow, SensorReading, ValveEvent } from "./types";

const defaultEmail = "";

const graphReadLimit = 5000;
const pageSize = 1000;
const autoRefreshMs = 15_000;
const staleAfterMs = 15 * 60 * 1000;
const maxPointsPerSeries = 260;

const importedPrefix = "balena-export-v2:%";
const livePrefix = "live-device:%";
const rememberEmailKey = "exacth2o.portal.rememberEmail";
const controlPots = new Set([41, 43, 45, 47, 49, 91, 93, 95, 97, 99]);
const droughtPots = new Set([42, 44, 46, 48, 50, 92, 94, 96, 98, 100]);

const zone2Palette = [
  "#2563eb",
  "#0891b2",
  "#0284c7",
  "#0ea5e9",
  "#14b8a6",
  "#1d4ed8",
  "#0f766e",
  "#38bdf8",
  "#6366f1",
  "#3b82f6",
];

const zone4Palette = [
  "#16a34a",
  "#65a30d",
  "#84cc16",
  "#f59e0b",
  "#ea580c",
  "#dc2626",
  "#9333ea",
  "#a855f7",
  "#c026d3",
  "#db2777",
];

type DataMode = "auto" | "live" | "snapshot" | "combined";
type EffectiveMode = Exclude<DataMode, "auto">;

type LoadState = {
  pairings: PairingRow[];
  latestState: LatestState | null;
  readings: SensorReading[];
  totalImportedReadings: number;
  totalLiveReadings: number;
  latestLiveReading: SensorReading | null;
  latestValveEvent: ValveEvent | null;
  latestIngestTime: string | null;
  lastCheckedAt: string | null;
  lastNewDataAt: string | null;
  effectiveMode: EffectiveMode;
};

type ChartPoint = {
  timestampMs: number;
  value: number;
  reading: SensorReading;
};

type ChartSeries = {
  name: string;
  zone: number;
  potNumber: number;
  treatment: Treatment;
  crop: Crop;
  color: string;
  points: ChartPoint[];
  rawPointCount: number;
};

type Treatment = "control" | "drought" | "unknown";

type Crop = "maize" | "sorghum" | "unknown";

type PotPreset = "all" | "control" | "drought" | "maize" | "sorghum" | "zone2" | "zone4" | "custom";

type TooltipState = {
  x: number;
  y: number;
  seriesName: string;
  color: string;
  zone: number;
  potNumber: number;
  point: ChartPoint;
};

const initialLoadState: LoadState = {
  pairings: [],
  latestState: null,
  readings: [],
  totalImportedReadings: 0,
  totalLiveReadings: 0,
  latestLiveReading: null,
  latestValveEvent: null,
  latestIngestTime: null,
  lastCheckedAt: null,
  lastNewDataAt: null,
  effectiveMode: "snapshot",
};

function orderedPairings(pairings: PairingRow[]) {
  return pairings.slice().sort((a, b) => {
    if (a.zone !== b.zone) return a.zone - b.zone;
    if (a.pot_number !== b.pot_number) return a.pot_number - b.pot_number;
    return a.name.localeCompare(b.name);
  });
}

function colorForPairing(pairing: PairingRow) {
  if (pairing.zone === 2) {
    return zone2Palette[Math.max(0, pairing.pot_number - 41) % zone2Palette.length];
  }
  if (pairing.zone === 4) {
    return zone4Palette[Math.max(0, pairing.pot_number - 91) % zone4Palette.length];
  }
  return "#475569";
}

function treatmentForPot(potNumber?: number | null): Treatment {
  if (typeof potNumber !== "number") return "unknown";
  if (controlPots.has(potNumber)) return "control";
  if (droughtPots.has(potNumber)) return "drought";
  return "unknown";
}

function treatmentForPairing(pairing: PairingRow): Treatment {
  return treatmentForPot(pairing.pot_number);
}

function cropForPot(potNumber?: number | null): Crop {
  if (typeof potNumber !== "number") return "unknown";
  if (potNumber >= 41 && potNumber <= 50) return "maize";
  if (potNumber >= 91 && potNumber <= 100) return "sorghum";
  return "unknown";
}

function cropForPairing(pairing: PairingRow): Crop {
  return cropForPot(pairing.pot_number);
}

function treatmentLabel(treatment: Treatment) {
  if (treatment === "control") return "Control";
  if (treatment === "drought") return "Drought";
  return "Unassigned";
}

function cropLabel(crop: Crop) {
  if (crop === "maize") return "Maize";
  if (crop === "sorghum") return "Sorghum";
  return "Unassigned";
}

function metricValue(reading: SensorReading) {
  const value = reading.calibrated_value;
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Number(value.toFixed(3));
}

function samplePoints(points: ChartPoint[]) {
  if (points.length <= maxPointsPerSeries) return points;
  const sampled: ChartPoint[] = [];
  const stride = (points.length - 1) / (maxPointsPerSeries - 1);
  for (let index = 0; index < maxPointsPerSeries; index += 1) {
    sampled.push(points[Math.round(index * stride)]);
  }
  return sampled;
}

function chartSeries(pairings: PairingRow[], readings: SensorReading[]): ChartSeries[] {
  const grouped = new Map<string, ChartPoint[]>();

  for (const reading of readings) {
    if (!reading.pairing_name) continue;
    const value = metricValue(reading);
    if (value == null) continue;
    const timestampMs = new Date(reading.device_recorded_at).getTime();
    if (!Number.isFinite(timestampMs)) continue;

    const points = grouped.get(reading.pairing_name) ?? [];
    points.push({ timestampMs, value, reading });
    grouped.set(reading.pairing_name, points);
  }

  return pairings.map((pairing) => {
    const points = (grouped.get(pairing.name) ?? []).sort(
      (a, b) => a.timestampMs - b.timestampMs,
    );

    return {
      name: pairing.name,
      zone: pairing.zone,
      potNumber: pairing.pot_number,
      treatment: treatmentForPairing(pairing),
      crop: cropForPairing(pairing),
      color: colorForPairing(pairing),
      points: samplePoints(points),
      rawPointCount: points.length,
    };
  });
}

function formatDateTime(value?: string | number | null) {
  if (!value) return "none";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "none";
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatClock(value?: string | number | null) {
  if (!value) return "not checked";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "not checked";
  return date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

function axisLabel(timestampMs: number, spanMs: number) {
  const date = new Date(timestampMs);
  if (spanMs > 36 * 60 * 60 * 1000) {
    return date.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }
  return date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}

function ageLabel(iso?: string | null) {
  if (!iso) return "none";
  const timestamp = new Date(iso).getTime();
  if (!Number.isFinite(timestamp)) return "none";
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function newestByTime<T extends { device_recorded_at: string }>(items: T[]) {
  return (
    items.slice().sort(
      (a, b) =>
        new Date(b.device_recorded_at).getTime() -
        new Date(a.device_recorded_at).getTime(),
    )[0] ?? null
  );
}

function newestReadingTimestamp(readings: SensorReading[]) {
  const newest = newestByTime(readings);
  return newest?.device_recorded_at ?? null;
}

function resolveEffectiveMode(mode: DataMode, totalLiveReadings: number): EffectiveMode {
  if (mode === "auto") {
    return totalLiveReadings > 0 ? "live" : "snapshot";
  }
  return mode;
}

function modeLabel(mode: EffectiveMode) {
  if (mode === "live") return "Live data";
  if (mode === "combined") return "All data";
  return "Saved snapshot";
}

function dataStatus(data: LoadState) {
  if (data.effectiveMode === "snapshot") {
    return {
      label: "Snapshot",
      detail: "Imported dataset",
      className: "status-snapshot",
      icon: WifiOff,
    };
  }

  if (data.totalLiveReadings === 0) {
    return {
      label: "Waiting",
      detail: "No live feed yet",
      className: "status-stale",
      icon: WifiOff,
    };
  }

  const liveTimestamp =
    data.latestLiveReading?.server_received_at ?? data.latestLiveReading?.device_recorded_at;
  const liveAge = liveTimestamp ? Date.now() - new Date(liveTimestamp).getTime() : Infinity;
  if (liveAge <= staleAfterMs) {
    return {
      label: "Live",
      detail: `Last live ingest ${ageLabel(liveTimestamp)}`,
      className: "status-live",
      icon: Wifi,
    };
  }

  return {
    label: "Stale",
    detail: `Last live ingest ${ageLabel(liveTimestamp)}`,
    className: "status-stale",
    icon: WifiOff,
  };
}

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message) return message;
  }
  return "Request failed. Please try again.";
}

function dedupeReadings(readings: SensorReading[]) {
  const byKey = new Map<string, SensorReading>();
  for (const reading of readings) {
    byKey.set(reading.event_id || String(reading.id), reading);
  }

  return Array.from(byKey.values())
    .sort(
      (a, b) =>
        new Date(b.device_recorded_at).getTime() -
        new Date(a.device_recorded_at).getTime(),
    )
    .slice(0, graphReadLimit);
}

function mergeReadings(base: SensorReading[], incoming: SensorReading[]) {
  return dedupeReadings([...incoming, ...base]);
}

async function fetchReadingsByPrefix(prefix: string, maxRows: number, newerThan?: string | null) {
  if (newerThan) {
    const response = await supabase
      .from("sensor_readings")
      .select("*")
      .like("event_id", prefix)
      .gt("device_recorded_at", newerThan)
      .order("device_recorded_at", { ascending: false })
      .limit(Math.min(pageSize, maxRows));

    if (response.error) throw response.error;
    return (response.data ?? []) as SensorReading[];
  }

  const pageCount = Math.ceil(maxRows / pageSize);
  const responses = await Promise.all(
    Array.from({ length: pageCount }, (_, page) =>
      supabase
        .from("sensor_readings")
        .select("*")
        .like("event_id", prefix)
        .order("device_recorded_at", { ascending: false })
        .range(page * pageSize, Math.min(maxRows, (page + 1) * pageSize) - 1),
    ),
  );

  for (const response of responses) {
    if (response.error) throw response.error;
  }

  return responses.flatMap((response) => response.data ?? []) as SensorReading[];
}

async function fetchReadingsForMode(mode: EffectiveMode, newerThan?: string | null) {
  if (mode === "live") {
    return fetchReadingsByPrefix(livePrefix, graphReadLimit, newerThan);
  }

  if (mode === "snapshot") {
    return fetchReadingsByPrefix(importedPrefix, graphReadLimit, newerThan);
  }

  const [liveReadings, importedReadings] = await Promise.all([
    fetchReadingsByPrefix(livePrefix, graphReadLimit, newerThan),
    fetchReadingsByPrefix(importedPrefix, graphReadLimit, newerThan),
  ]);

  return dedupeReadings([...liveReadings, ...importedReadings]);
}

async function countReadings(prefix: string) {
  const response = await supabase
    .from("sensor_readings")
    .select("id", { count: "exact", head: true })
    .like("event_id", prefix);
  if (response.error) throw response.error;
  return response.count ?? 0;
}

function chartBounds(series: ChartSeries[], width: number, height: number) {
  const margin = { top: 22, right: 24, bottom: 54, left: 68 };
  const plotWidth = Math.max(1, width - margin.left - margin.right);
  const plotHeight = Math.max(1, height - margin.top - margin.bottom);
  const allPoints = series.flatMap((item) => item.points);
  const minX = allPoints.length ? Math.min(...allPoints.map((point) => point.timestampMs)) : 0;
  const maxX = allPoints.length ? Math.max(...allPoints.map((point) => point.timestampMs)) : 1;
  const spanX = Math.max(1, maxX - minX);

  const xScale = (timestampMs: number) =>
    margin.left + ((timestampMs - minX) / spanX) * plotWidth;
  const yScale = (value: number) =>
    margin.top + ((60 - Math.max(0, Math.min(60, value))) / 60) * plotHeight;

  return {
    margin,
    plotWidth,
    plotHeight,
    minX,
    maxX,
    spanX,
    xScale,
    yScale,
  };
}

function SensorCanvasChart({
  series,
  visibleNames,
}: {
  series: ChartSeries[];
  visibleNames: Set<string>;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);

  const visibleSeries = useMemo(
    () => series.filter((item) => visibleNames.has(item.name) && item.points.length > 0),
    [series, visibleNames],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrapper = wrapperRef.current;
    if (!canvas || !wrapper) return undefined;

    let animationFrame = 0;

    const draw = () => {
      const rect = wrapper.getBoundingClientRect();
      const width = Math.max(320, rect.width);
      const height = Math.max(360, rect.height);
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;

      const context = canvas.getContext("2d");
      if (!context) return;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, width, height);
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, width, height);

      const bounds = chartBounds(visibleSeries, width, height);
      const { margin, plotWidth, plotHeight, minX, spanX, xScale, yScale } = bounds;

      context.save();
      context.strokeStyle = "#e2e8f0";
      context.lineWidth = 1;
      context.setLineDash([4, 4]);
      context.fillStyle = "#64748b";
      context.font = "12px Inter, Arial, sans-serif";
      context.textAlign = "right";
      context.textBaseline = "middle";

      for (const tick of [0, 15, 30, 45, 60]) {
        const y = yScale(tick);
        context.beginPath();
        context.moveTo(margin.left, y);
        context.lineTo(margin.left + plotWidth, y);
        context.stroke();
        context.fillText(String(tick), margin.left - 10, y);
      }

      const xTickCount = width < 720 ? 4 : 6;
      context.textAlign = "center";
      context.textBaseline = "top";
      for (let index = 0; index <= xTickCount; index += 1) {
        const timestamp = minX + (spanX * index) / xTickCount;
        const x = xScale(timestamp);
        context.beginPath();
        context.moveTo(x, margin.top);
        context.lineTo(x, margin.top + plotHeight);
        context.stroke();
        context.fillText(axisLabel(timestamp, spanX), x, margin.top + plotHeight + 12);
      }

      context.setLineDash([]);
      context.strokeStyle = "#94a3b8";
      context.beginPath();
      context.moveTo(margin.left, margin.top);
      context.lineTo(margin.left, margin.top + plotHeight);
      context.lineTo(margin.left + plotWidth, margin.top + plotHeight);
      context.stroke();

      context.save();
      context.translate(18, margin.top + plotHeight / 2);
      context.rotate(-Math.PI / 2);
      context.fillStyle = "#475569";
      context.font = "13px Inter, Arial, sans-serif";
      context.textAlign = "center";
      context.fillText("Soil moisture (% VWC)", 0, 0);
      context.restore();

      context.beginPath();
      context.rect(margin.left, margin.top, plotWidth, plotHeight);
      context.clip();

      for (const item of visibleSeries) {
        if (item.points.length < 2) continue;
        context.setLineDash(item.treatment === "drought" ? [7, 5] : []);
        context.strokeStyle = item.color;
        context.lineWidth = 2.2;
        context.lineJoin = "round";
        context.lineCap = "round";
        context.beginPath();
        item.points.forEach((point, index) => {
          const x = xScale(point.timestampMs);
          const y = yScale(point.value);
          if (index === 0) context.moveTo(x, y);
          else context.lineTo(x, y);
        });
        context.stroke();
        context.setLineDash([]);

        const latest = item.points[item.points.length - 1];
        context.fillStyle = item.color;
        context.beginPath();
        context.arc(xScale(latest.timestampMs), yScale(latest.value), 3.2, 0, Math.PI * 2);
        context.fill();
      }

      context.restore();

      if (visibleSeries.length === 0) {
        context.fillStyle = "#64748b";
        context.font = "15px Inter, Arial, sans-serif";
        context.textAlign = "center";
        context.fillText("No readings for the selected pots and data mode.", width / 2, height / 2);
      }
    };

    const scheduleDraw = () => {
      window.cancelAnimationFrame(animationFrame);
      animationFrame = window.requestAnimationFrame(draw);
    };

    const observer = new ResizeObserver(scheduleDraw);
    observer.observe(wrapper);
    scheduleDraw();

    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(animationFrame);
    };
  }, [visibleSeries]);

  function updateTooltip(event: React.MouseEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const bounds = chartBounds(visibleSeries, rect.width, rect.height);
    const { margin, plotWidth, plotHeight, xScale, yScale } = bounds;

    if (
      x < margin.left ||
      x > margin.left + plotWidth ||
      y < margin.top ||
      y > margin.top + plotHeight
    ) {
      setTooltip(null);
      return;
    }

    let nearest: TooltipState | null = null;
    let nearestDistance = Infinity;

    for (const item of visibleSeries) {
      for (const point of item.points) {
        const pointX = xScale(point.timestampMs);
        const pointY = yScale(point.value);
        const distance = Math.abs(pointX - x) * 1.4 + Math.abs(pointY - y);
        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearest = {
            x: pointX,
            y: pointY,
            seriesName: item.name,
            color: item.color,
            zone: item.zone,
            potNumber: item.potNumber,
            point,
          };
        }
      }
    }

    setTooltip(nearest && nearestDistance < 48 ? nearest : null);
  }

  return (
    <div ref={wrapperRef} className="canvas-chart">
      <canvas
        ref={canvasRef}
        onMouseMove={updateTooltip}
        onMouseLeave={() => setTooltip(null)}
        aria-label="Soil moisture chart"
      />
      {tooltip ? (
        <div
          className="chart-tooltip"
          style={{
            left: Math.min(Math.max(tooltip.x + 14, 10), 760),
            top: Math.max(tooltip.y - 72, 10),
            borderColor: tooltip.color,
          }}
        >
          <strong>{tooltip.seriesName}</strong>
          <span>{formatDateTime(tooltip.point.timestampMs)}</span>
          <span>
            {cropLabel(cropForPot(tooltip.potNumber))} / Zone {tooltip.zone} / Pot {tooltip.potNumber} /{" "}
            {treatmentLabel(treatmentForPot(tooltip.potNumber))}
          </span>
          <b>{tooltip.point.value.toFixed(1)}% VWC</b>
        </div>
      ) : null}
    </div>
  );
}

export default function App() {
  const [email, setEmail] = useState(defaultEmail);
  const [password, setPassword] = useState("");
  const [rememberDevice, setRememberDevice] = useState(false);
  const [sessionReady, setSessionReady] = useState(false);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedMode, setSelectedMode] = useState<DataMode>("auto");
  const [potPreset, setPotPreset] = useState<PotPreset>("all");
  const [hiddenPots, setHiddenPots] = useState<Set<string>>(() => new Set());
  const [data, setData] = useState<LoadState>(initialLoadState);

  const dataRef = useRef(data);
  const loadTokenRef = useRef(0);

  useEffect(() => {
    dataRef.current = data;
  }, [data]);

  const sortedPairings = useMemo(() => orderedPairings(data.pairings), [data.pairings]);
  const series = useMemo(() => chartSeries(sortedPairings, data.readings), [sortedPairings, data.readings]);
  const visibleNames = useMemo(
    () => new Set(sortedPairings.filter((pairing) => !hiddenPots.has(pairing.name)).map((pairing) => pairing.name)),
    [sortedPairings, hiddenPots],
  );

  const latestDisplayedReading = useMemo(() => newestByTime(data.readings), [data.readings]);
  const status = dataStatus(data);
  const StatusIcon = status.icon;
  const activePotCount = series.filter((item) => item.rawPointCount > 0).length;
  const visiblePotCount = series.filter(
    (item) => visibleNames.has(item.name) && item.rawPointCount > 0,
  ).length;
  const plottedPointCount = series
    .filter((item) => visibleNames.has(item.name))
    .reduce((sum, item) => sum + item.points.length, 0);
  const rawPointCount = series.reduce((sum, item) => sum + item.rawPointCount, 0);
  const noNewDataMessage =
    data.lastCheckedAt && data.lastNewDataAt && data.lastCheckedAt !== data.lastNewDataAt
      ? `No new data since ${formatClock(data.lastNewDataAt)}`
      : null;

  const refresh = useCallback(
    async ({ incremental }: { incremental: boolean }) => {
      const token = loadTokenRef.current + 1;
      loadTokenRef.current = token;
      setError(null);
      setLoading(!incremental);
      setRefreshing(incremental);

      try {
        const [
          pairings,
          latestState,
          totalImportedReadings,
          totalLiveReadings,
          latestLiveReadings,
          latestValveEvents,
        ] = await Promise.all([
          supabase.from("pairings").select("*").limit(1000),
          supabase.from("latest_device_state").select("*").limit(1).maybeSingle(),
          countReadings(importedPrefix),
          countReadings(livePrefix),
          supabase
            .from("sensor_readings")
            .select("*")
            .like("event_id", livePrefix)
            .order("device_recorded_at", { ascending: false })
            .limit(1),
          supabase
            .from("valve_events")
            .select("*")
            .order("device_recorded_at", { ascending: false })
            .limit(1),
        ]);

        for (const result of [pairings, latestState, latestLiveReadings, latestValveEvents]) {
          if (result.error) throw result.error;
        }

        const previous = dataRef.current;
        const effectiveMode = resolveEffectiveMode(selectedMode, totalLiveReadings);
        const canIncrement = incremental && previous.effectiveMode === effectiveMode;
        const newerThan = canIncrement ? newestReadingTimestamp(previous.readings) : null;
        const incomingReadings = await fetchReadingsForMode(effectiveMode, newerThan);
        const nowIso = new Date().toISOString();

        if (token !== loadTokenRef.current) return;

        setData((current) => {
          const sameMode = current.effectiveMode === effectiveMode;
          const base = incremental && sameMode ? current.readings : [];
          const readings = mergeReadings(base, incomingReadings);
          const hasNewRows = incomingReadings.length > 0;

          return {
            pairings: pairings.data ?? [],
            latestState: latestState.data ?? null,
            readings,
            totalImportedReadings,
            totalLiveReadings,
            latestLiveReading: latestLiveReadings.data?.[0] ?? null,
            latestValveEvent: latestValveEvents.data?.[0] ?? null,
            latestIngestTime:
              latestLiveReadings.data?.[0]?.server_received_at ??
              latestState.data?.updated_at ??
              null,
            lastCheckedAt: nowIso,
            lastNewDataAt: hasNewRows ? nowIso : current.lastNewDataAt ?? (readings.length ? nowIso : null),
            effectiveMode,
          };
        });
      } catch (err) {
        if (token === loadTokenRef.current) {
          setError(errorMessage(err));
        }
      } finally {
        if (token === loadTokenRef.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [selectedMode],
  );

  async function signIn(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    setLoading(true);
    setError(null);
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    setLoading(false);
    if (signInError) {
      setError(errorMessage(signInError));
      return;
    }
    if (rememberDevice) {
      window.localStorage.setItem(rememberEmailKey, email);
    } else {
      window.localStorage.removeItem(rememberEmailKey);
    }
    setSessionReady(true);
  }

  async function signOut() {
    await supabase.auth.signOut();
    setSessionReady(false);
    setData(initialLoadState);
    dataRef.current = initialLoadState;
  }

  function applyPotPreset(preset: Exclude<PotPreset, "custom">) {
    setPotPreset(preset);
    setHiddenPots(() => {
      if (preset === "all") return new Set();
      const hidden = new Set<string>();
      for (const pairing of sortedPairings) {
        const treatment = treatmentForPairing(pairing);
        const crop = cropForPairing(pairing);
        if (preset === "control" && treatment !== "control") hidden.add(pairing.name);
        if (preset === "drought" && treatment !== "drought") hidden.add(pairing.name);
        if (preset === "maize" && crop !== "maize") hidden.add(pairing.name);
        if (preset === "sorghum" && crop !== "sorghum") hidden.add(pairing.name);
        if (preset === "zone2" && pairing.zone !== 2) hidden.add(pairing.name);
        if (preset === "zone4" && pairing.zone !== 4) hidden.add(pairing.name);
      }
      return hidden;
    });
  }

  function togglePot(name: string) {
    setPotPreset("custom");
    setHiddenPots((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  useEffect(() => {
    const rememberedEmail = window.localStorage.getItem(rememberEmailKey);
    if (rememberedEmail) {
      setEmail(rememberedEmail);
      setRememberDevice(true);
    }
    supabase.auth.getSession().then(({ data: sessionData }) => {
      setSessionReady(Boolean(sessionData.session));
    });
  }, []);

  useEffect(() => {
    if (!sessionReady) return;
    void refresh({ incremental: false });
  }, [sessionReady, selectedMode, refresh]);

  useEffect(() => {
    if (!sessionReady) return undefined;
    const intervalId = window.setInterval(() => {
      void refresh({ incremental: true });
    }, autoRefreshMs);
    return () => window.clearInterval(intervalId);
  }, [sessionReady, refresh]);

  if (!sessionReady) {
    return (
      <main className="portal-login-shell">
        <header className="portal-topbar">
          <a href="index.html?v=20260630-1355" className="portal-logo">
            exact<span>H</span>2<span>O</span>
          </a>
          <div className="portal-top-links">
            <a href="index.html?v=20260630-1355">Website</a>
            <a href="support.html">Support</a>
          </div>
        </header>

        <section className="portal-context-panel" aria-label="Portal context">
          <div className="portal-photo-wall" aria-hidden="true">
            <img src="product1.jpg" alt="" />
            <img src="product2.jpg" alt="" />
            <img src="product3.jpg" alt="" />
            <img src="dashboard.jpg" alt="" />
            <img src="scheduling.jpg" alt="" />
            <img src="sensor.jpg" alt="" />
          </div>
          <div className="portal-context-copy">
            <h1>exactH2O Data Portal</h1>
          </div>
        </section>

        <section className="portal-login-panel" aria-label="Portal sign in">
          <div className="portal-login-card">
            <h2>Sign In</h2>
            <p className="portal-login-note">
              Use your exactH2O account.
            </p>

            <form onSubmit={signIn}>
              <div className="portal-form-group">
                <label htmlFor="portalEmail">Username or Email</label>
                <input
                  id="portalEmail"
                  name="email"
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  autoComplete="username"
                  required
                />
              </div>
              <div className="portal-form-group">
                <label htmlFor="portalPassword">Password</label>
                <input
                  id="portalPassword"
                  name="password"
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="current-password"
                  required
                />
              </div>
              <div className="portal-form-row">
                <label className="portal-check">
                  <input
                    type="checkbox"
                    name="remember"
                    checked={rememberDevice}
                    onChange={(event) => setRememberDevice(event.target.checked)}
                  />
                  <span>Remember this device</span>
                </label>
                <a href="mailto:bslbinod@gmail.com?subject=exactH2O Portal Access">
                  Need access?
                </a>
              </div>
              <button
                className="portal-submit-btn"
                type="submit"
                disabled={loading || !email || !password}
              >
                {loading ? "Signing in..." : "Open Dashboard"}
              </button>
              {error ? <p className="portal-error-line">{error}</p> : null}
            </form>

            <div className="portal-support-line">
              Trouble signing in? Contact{" "}
              <a href="mailto:bslbinod@gmail.com">bslbinod@gmail.com</a>.
            </div>
          </div>
        </section>
      </main>
    );
  }

  const groupedPairings = {
    zone2: sortedPairings.filter((pairing) => pairing.zone === 2),
    zone4: sortedPairings.filter((pairing) => pairing.zone === 4),
  };

  return (
    <main className="dashboard-shell">
      <header className="dashboard-header">
        <a className="dashboard-logo" href="index.html?v=20260630-1355" aria-label="exactH2O home">
          exact<span>H</span>2<span>O</span>
        </a>
        <div className="header-actions">
          <a className="outline-btn" href="index.html?v=20260630-1355">
            Website
          </a>
          <button className="outline-btn" type="button" onClick={() => refresh({ incremental: false })} disabled={loading || refreshing}>
            <RefreshCw size={17} className={loading || refreshing ? "spin" : ""} />
            Refresh
          </button>
          <button className="outline-btn" type="button" onClick={signOut}>
            <LogOut size={20} />
            Sign out
          </button>
        </div>
      </header>

      {error ? (
        <div className="banner error">
          <AlertTriangle size={18} />
          {error}
        </div>
      ) : null}

      <section className="summary-strip" aria-label="Dashboard summary">
        <div className="summary-main">
          <strong>20 plants</strong>
          <span>Maize 41-50 · Sorghum 91-100 · Control odd pots · Drought even pots</span>
        </div>
        <div>
          <span>Showing</span>
          <strong>{visiblePotCount} / {activePotCount}</strong>
        </div>
        <div>
          <span>Readings</span>
          <strong>{data.readings.length.toLocaleString()}</strong>
        </div>
        <div>
          <span>Last reading</span>
          <strong>{formatDateTime(latestDisplayedReading?.device_recorded_at)}</strong>
          <small>{ageLabel(latestDisplayedReading?.device_recorded_at)}</small>
        </div>
        <div className={status.className}>
          <span>Status</span>
          <strong>
            <StatusIcon size={16} />
            {status.label}
          </strong>
          <small>{status.label === "Live" ? "Updating" : noNewDataMessage ?? status.detail}</small>
        </div>
      </section>

      <section className="dashboard-main">
        <section className="chart-card">
          <div className="chart-card-head">
            <div>
              <h2>Soil Moisture (% VWC)</h2>
              <p>
                Control vs drought · {modeLabel(data.effectiveMode)} · {data.readings.length.toLocaleString()} readings
              </p>
            </div>
            <div className={`mode-pill ${status.className}`}>
              <StatusIcon size={16} />
              {status.label}
            </div>
          </div>
          <SensorCanvasChart series={series} visibleNames={visibleNames} />
        </section>

        <aside className="control-panel">
          <section>
            <div className="control-heading">
              <h2>Data mode</h2>
              <span>{selectedMode === "auto" ? `Auto -> ${modeLabel(data.effectiveMode)}` : modeLabel(data.effectiveMode)}</span>
            </div>
            <div className="mode-buttons">
              {[
                ["auto", "Auto"],
                ["live", "Live data"],
                ["snapshot", "Saved snapshot"],
                ["combined", "All data"],
              ].map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={selectedMode === value ? "is-selected" : ""}
                  onClick={() => setSelectedMode(value as DataMode)}
                >
                  {label}
                </button>
              ))}
            </div>
          </section>

          <section>
            <div className="control-heading">
              <h2>Research view</h2>
              <span>{visiblePotCount} showing</span>
            </div>
            <div className="preset-buttons research-presets">
              <button
                type="button"
                className={potPreset === "all" ? "is-selected" : ""}
                onClick={() => applyPotPreset("all")}
              >
                All
              </button>
              <button
                type="button"
                className={potPreset === "control" ? "is-selected" : ""}
                onClick={() => applyPotPreset("control")}
              >
                Control
              </button>
              <button
                type="button"
                className={potPreset === "drought" ? "is-selected" : ""}
                onClick={() => applyPotPreset("drought")}
              >
                Drought
              </button>
              <button
                type="button"
                className={potPreset === "maize" ? "is-selected" : ""}
                onClick={() => applyPotPreset("maize")}
              >
                Maize
              </button>
              <button
                type="button"
                className={potPreset === "sorghum" ? "is-selected" : ""}
                onClick={() => applyPotPreset("sorghum")}
              >
                Sorghum
              </button>
              <button
                type="button"
                className={potPreset === "zone2" ? "is-selected" : ""}
                onClick={() => applyPotPreset("zone2")}
              >
                Zone 2
              </button>
              <button
                type="button"
                className={potPreset === "zone4" ? "is-selected" : ""}
                onClick={() => applyPotPreset("zone4")}
              >
                Zone 4
              </button>
            </div>
          </section>

          {[
            ["Maize / Zone 2", groupedPairings.zone2],
            ["Sorghum / Zone 4", groupedPairings.zone4],
          ].map(([label, pairings]) => (
            <section className="pot-group" key={label as string}>
              <h3>{label as string}</h3>
              <div>
                {(pairings as PairingRow[]).map((pairing) => {
                  const item = series.find((entry) => entry.name === pairing.name);
                  const visible = !hiddenPots.has(pairing.name);
                  return (
                    <button
                      key={pairing.name}
                      type="button"
                      className={`pot-toggle ${visible ? "is-on" : ""}`}
                      onClick={() => togglePot(pairing.name)}
                    >
                      <span className="color-dot" style={{ background: colorForPairing(pairing) }} />
                      <span>Pot {pairing.pot_number}</span>
                      <em className={`treatment-dot ${treatmentForPairing(pairing)}`}>
                        {treatmentForPairing(pairing) === "control" ? "C" : "D"}
                      </em>
                      <small>{(item?.rawPointCount ?? 0).toLocaleString()}</small>
                    </button>
                  );
                })}
              </div>
            </section>
          ))}
        </aside>
      </section>

      <details className="proof-details">
        <summary>
          <Database size={17} />
          Data details
        </summary>
        <dl>
          <div>
            <dt>Device</dt>
            <dd>plain-feather</dd>
          </div>
          <div>
            <dt>Dataset</dt>
            <dd>{modeLabel(data.effectiveMode)}</dd>
          </div>
          <div>
            <dt>Treatment Groups</dt>
            <dd>10 control / 10 droughted</dd>
          </div>
          <div>
            <dt>Crop Groups</dt>
            <dd>Maize pots 41-50 / sorghum pots 91-100</dd>
          </div>
          <div>
            <dt>Imported Rows in Database</dt>
            <dd>{data.totalImportedReadings.toLocaleString()}</dd>
          </div>
          <div>
            <dt>Live Device Rows</dt>
            <dd>{data.totalLiveReadings.toLocaleString()}</dd>
          </div>
          <div>
            <dt>Rows Displayed</dt>
            <dd>{data.readings.length.toLocaleString()} recent readings</dd>
          </div>
          <div>
            <dt>Points Plotted</dt>
            <dd>{plottedPointCount.toLocaleString()} of {rawPointCount.toLocaleString()}</dd>
          </div>
          <div>
            <dt>Pots</dt>
            <dd>{sortedPairings.length}</dd>
          </div>
        </dl>
      </details>
    </main>
  );
}
