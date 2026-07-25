import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  CheckCircle2,
  CircleAlert,
  Database,
  Droplets,
  ExternalLink,
} from "lucide-react";
import type {
  AssistantDeliveryEvidenceArtifact,
  AssistantEvidenceArtifact,
  AssistantEvidenceBundle,
  AssistantExperimentChartArtifact,
  AssistantExperimentEvidenceGroup,
  AssistantOperationReceiptArtifact,
  AssistantStatusArtifact,
} from "./assistantEvidence";
import { colorForPotNumber } from "./potColors";
import { supabase } from "./supabase";

type EvidenceReading = {
  event_id: string;
  pairing_name: string;
  calibrated_value: number | null;
  device_recorded_at: string;
};

type EvidenceWaterEvent = {
  event_id: string;
  pairing_name: string;
  action: string;
  device_recorded_at: string;
};

type EvidencePoint = {
  timestamp: number;
  value: number;
};

function formatEvidenceTime(value: string | null | undefined) {
  if (!value) return "Unavailable";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Unavailable";
  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function potNumberFromPairing(name: string) {
  const match = /Pot(\d+)$/i.exec(name);
  return match ? Number(match[1]) : 0;
}

function downsample(points: EvidencePoint[], maximum = 72) {
  if (points.length <= maximum) return points;
  const selected: EvidencePoint[] = [];
  for (let index = 0; index < maximum; index += 1) {
    const sourceIndex = Math.round((index * (points.length - 1)) / (maximum - 1));
    selected.push(points[sourceIndex]);
  }
  return selected;
}

function evidenceSourcePriority(eventId: string) {
  if (eventId.startsWith("live-device:")) return 2;
  if (eventId.startsWith("balena-export-v2:")) return 1;
  return 0;
}

function dedupeEvidenceReadings(rows: EvidenceReading[]) {
  const byMeasurement = new Map<string, EvidenceReading>();
  for (const row of rows) {
    const key = [
      row.pairing_name,
      row.device_recorded_at,
      row.calibrated_value ?? "",
    ].join("\u001f");
    const current = byMeasurement.get(key);
    if (!current || evidenceSourcePriority(row.event_id) > evidenceSourcePriority(current.event_id)) {
      byMeasurement.set(key, row);
    }
  }
  return Array.from(byMeasurement.values());
}

function dedupeEvidenceWaterEvents(rows: EvidenceWaterEvent[]) {
  const byEvent = new Map<string, EvidenceWaterEvent>();
  for (const row of rows) {
    const key = [row.pairing_name, row.action, row.device_recorded_at].join("\u001f");
    const current = byEvent.get(key);
    if (!current || evidenceSourcePriority(row.event_id) > evidenceSourcePriority(current.event_id)) {
      byEvent.set(key, row);
    }
  }
  return Array.from(byEvent.values());
}

function MiniEvidenceChart({
  group,
  readings,
  waterEvents,
}: {
  group: AssistantExperimentEvidenceGroup;
  readings: EvidenceReading[];
  waterEvents: EvidenceWaterEvent[];
}) {
  const width = 640;
  const height = 190;
  const margin = { top: 18, right: 16, bottom: 28, left: 42 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const series = useMemo(() => {
    const allowed = new Set(group.pairing_names);
    const byPairing = new Map<string, EvidencePoint[]>();
    for (const reading of readings) {
      if (!allowed.has(reading.pairing_name) || reading.calibrated_value == null) continue;
      const timestamp = Date.parse(reading.device_recorded_at);
      if (!Number.isFinite(timestamp) || !Number.isFinite(reading.calibrated_value)) continue;
      const current = byPairing.get(reading.pairing_name) ?? [];
      current.push({ timestamp, value: reading.calibrated_value });
      byPairing.set(reading.pairing_name, current);
    }
    return Array.from(byPairing.entries()).map(([name, points]) => ({
      name,
      potNumber: potNumberFromPairing(name),
      points: downsample(points.sort((left, right) => left.timestamp - right.timestamp)),
    })).filter((item) => item.points.length);
  }, [group.pairing_names, readings]);

  const bounds = useMemo(() => {
    const allPoints = series.flatMap((item) => item.points);
    if (!allPoints.length) return null;
    const times = allPoints.map((point) => point.timestamp);
    const values = allPoints.map((point) => point.value);
    if (group.target_vwc_percent != null) values.push(group.target_vwc_percent);
    const minTime = Math.min(...times);
    const maxTime = Math.max(...times);
    const rawMin = Math.min(...values);
    const rawMax = Math.max(...values);
    const padding = Math.max(2, (rawMax - rawMin) * 0.12);
    return {
      minTime,
      maxTime,
      minValue: Math.max(0, rawMin - padding),
      maxValue: rawMax + padding,
    };
  }, [group.target_vwc_percent, series]);

  if (!bounds) {
    return <div className="assistant-evidence-chart-empty">No readings in this window.</div>;
  }

  const x = (timestamp: number) =>
    margin.left +
    ((timestamp - bounds.minTime) / Math.max(1, bounds.maxTime - bounds.minTime)) * plotWidth;
  const y = (value: number) =>
    margin.top +
    (1 - (value - bounds.minValue) / Math.max(1, bounds.maxValue - bounds.minValue)) * plotHeight;
  const yTicks = Array.from({ length: 4 }, (_, index) =>
    bounds.minValue + ((bounds.maxValue - bounds.minValue) * index) / 3
  );
  const groupEvents = waterEvents.filter((event) =>
    group.pairing_names.includes(event.pairing_name) &&
    event.action.toLowerCase() === "open"
  );

  return (
    <div className="assistant-evidence-mini-chart">
      <header>
        <strong>{group.label}</strong>
        <span>
          {group.pairing_names.length} pots
          {group.target_vwc_percent == null ? "" : ` · ${group.target_vwc_percent}%`}
        </span>
      </header>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`${group.label} VWC evidence`}
        preserveAspectRatio="none"
      >
        {yTicks.map((tick) => (
          <g key={tick}>
            <line
              x1={margin.left}
              x2={width - margin.right}
              y1={y(tick)}
              y2={y(tick)}
              className="assistant-evidence-grid-line"
            />
            <text x={margin.left - 8} y={y(tick) + 4} textAnchor="end">
              {tick.toFixed(0)}
            </text>
          </g>
        ))}
        {group.target_vwc_percent != null ? (
          <g>
            <line
              x1={margin.left}
              x2={width - margin.right}
              y1={y(group.target_vwc_percent)}
              y2={y(group.target_vwc_percent)}
              className="assistant-evidence-target-line"
            />
            <text
              x={width - margin.right}
              y={y(group.target_vwc_percent) - 5}
              textAnchor="end"
              className="assistant-evidence-target-label"
            >
              target
            </text>
          </g>
        ) : null}
        {groupEvents.slice(-40).map((event, index) => {
          const timestamp = Date.parse(event.device_recorded_at);
          if (!Number.isFinite(timestamp)) return null;
          return (
            <line
              key={`${event.pairing_name}-${event.device_recorded_at}-${index}`}
              x1={x(timestamp)}
              x2={x(timestamp)}
              y1={margin.top}
              y2={height - margin.bottom}
              className="assistant-evidence-water-line"
            />
          );
        })}
        {series.map((item) => {
          const path = item.points
            .map((point, index) => `${index ? "L" : "M"} ${x(point.timestamp)} ${y(point.value)}`)
            .join(" ");
          const latest = item.points[item.points.length - 1];
          return (
            <g key={item.name}>
              <path
                d={path}
                fill="none"
                stroke={colorForPotNumber(item.potNumber)}
                strokeWidth="2.1"
                strokeDasharray={group.label.toLowerCase().includes("drought") ? "7 5" : undefined}
                vectorEffect="non-scaling-stroke"
              />
              <circle
                cx={x(latest.timestamp)}
                cy={y(latest.value)}
                r="2.8"
                fill={colorForPotNumber(item.potNumber)}
              />
            </g>
          );
        })}
        <text x={margin.left} y={height - 7}>{formatEvidenceTime(new Date(bounds.minTime).toISOString())}</text>
        <text x={width - margin.right} y={height - 7} textAnchor="end">
          {formatEvidenceTime(new Date(bounds.maxTime).toISOString())}
        </text>
      </svg>
    </div>
  );
}

function ExperimentChartArtifact({
  projectId,
  artifact,
  onOpenExperiment,
}: {
  projectId: string;
  artifact: AssistantExperimentChartArtifact;
  onOpenExperiment?: (slug: string) => void;
}) {
  const [readings, setReadings] = useState<EvidenceReading[]>([]);
  const [waterEvents, setWaterEvents] = useState<EvidenceWaterEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const pairingNames = artifact.pairings.map((item) => item.pairing_name);
    if (!pairingNames.length || !artifact.start_at) {
      setLoading(false);
      return () => {
        active = false;
      };
    }
    setLoading(true);
    setError(null);
    let readingQuery = supabase
      .from("sensor_readings")
      .select("event_id,pairing_name,calibrated_value,device_recorded_at")
      .eq("project_id", projectId)
      .in("pairing_name", pairingNames)
      .gte("device_recorded_at", artifact.start_at)
      .order("device_recorded_at", { ascending: true })
      .limit(5_000);
    let waterQuery = supabase
      .from("valve_events")
      .select("event_id,pairing_name,action,device_recorded_at")
      .eq("project_id", projectId)
      .in("pairing_name", pairingNames)
      .gte("device_recorded_at", artifact.start_at)
      .order("device_recorded_at", { ascending: true })
      .limit(1_000);
    if (artifact.end_at) {
      readingQuery = readingQuery.lte("device_recorded_at", artifact.end_at);
      waterQuery = waterQuery.lte("device_recorded_at", artifact.end_at);
    }
    void Promise.all([readingQuery, waterQuery])
      .then(([readingResult, waterResult]) => {
        if (!active) return;
        if (readingResult.error) throw readingResult.error;
        setReadings(dedupeEvidenceReadings((readingResult.data ?? []) as EvidenceReading[]));
        if (!waterResult.error) {
          setWaterEvents(
            dedupeEvidenceWaterEvents((waterResult.data ?? []) as EvidenceWaterEvent[]),
          );
        }
      })
      .catch(() => {
        if (active) setError("The evidence graph could not be loaded.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [artifact.end_at, artifact.pairings, artifact.start_at, projectId]);

  return (
    <section className="assistant-evidence-card assistant-evidence-chart-card">
      <header className="assistant-evidence-card-head">
        <div>
          <span><Activity size={15} /> Live evidence</span>
          <strong>{artifact.title}</strong>
        </div>
        {artifact.experiment_slug && onOpenExperiment ? (
          <button type="button" onClick={() => onOpenExperiment(artifact.experiment_slug ?? "")}>
            Open graph <ExternalLink size={14} />
          </button>
        ) : null}
      </header>
      <div className="assistant-evidence-facts">
        <span>{artifact.pairings.length}/{artifact.expected_pots ?? artifact.pairings.length} pots</span>
        <span>{artifact.reading_count ?? 0} readings</span>
        <span>{artifact.recorded_water_events ?? 0} valve events</span>
        <span>Through {formatEvidenceTime(artifact.observed_at)}</span>
      </div>
      {loading ? (
        <div className="assistant-evidence-chart-empty">Loading evidence…</div>
      ) : error ? (
        <div className="assistant-evidence-chart-empty is-error">{error}</div>
      ) : (
        <div className={`assistant-evidence-chart-grid ${artifact.groups.length === 1 ? "is-single" : ""}`}>
          {artifact.groups.map((group) => (
            <MiniEvidenceChart
              key={group.id}
              group={group}
              readings={readings}
              waterEvents={waterEvents}
            />
          ))}
        </div>
      )}
      {artifact.limitations.length ? (
        <p className="assistant-evidence-limit">{artifact.limitations[artifact.limitations.length - 1]}</p>
      ) : null}
    </section>
  );
}

function OperationReceipt({ artifact }: { artifact: AssistantOperationReceiptArtifact }) {
  const rows = artifact.operations.length
    ? artifact.operations.slice(0, 6).map((operation) => ({
      key: operation.id,
      label: operation.intent,
      state: operation.execution_state,
      verified: operation.verification_state,
      time: operation.completed_at ?? operation.created_at,
    }))
    : artifact.commands.slice(0, 6).map((command, index) => ({
      key: `${command.command_type}-${command.requested_at}-${index}`,
      label: command.experiment
        ? `${command.command_type.replace(/_/g, " ")} · ${command.experiment}`
        : command.command_type.replace(/_/g, " "),
      state: command.status,
      verified: command.error ? "failed" : "",
      time: command.completed_at ?? command.requested_at,
    }));
  return (
    <section className="assistant-evidence-card assistant-operation-receipt">
      <header className="assistant-evidence-card-head">
        <div>
          <span><CheckCircle2 size={15} /> Proof of work</span>
          <strong>{artifact.title}</strong>
        </div>
      </header>
      <div>
        {rows.map((row) => (
          <article key={row.key}>
            <span className={`assistant-receipt-dot is-${row.state}`} />
            <strong>{row.label}</strong>
            <time>{formatEvidenceTime(row.time)}</time>
            <em>{row.verified === "verified" ? "Verified" : row.state.replace(/_/g, " ")}</em>
          </article>
        ))}
      </div>
    </section>
  );
}

function StatusArtifact({ artifact }: { artifact: AssistantStatusArtifact }) {
  return (
    <section className="assistant-evidence-card assistant-status-evidence">
      <header className="assistant-evidence-card-head">
        <div>
          <span><Database size={15} /> Checked {formatEvidenceTime(artifact.observed_at)}</span>
          <strong>{artifact.title}</strong>
        </div>
      </header>
      <div>
        {artifact.facts.map((fact) => (
          <article key={fact.label}>
            <span>{fact.label}</span>
            <strong>{fact.value}</strong>
          </article>
        ))}
      </div>
    </section>
  );
}

function DeliveryEvidence({ artifact }: { artifact: AssistantDeliveryEvidenceArtifact }) {
  return (
    <section className="assistant-evidence-card assistant-delivery-evidence">
      <header className="assistant-evidence-card-head">
        <div>
          <span>
            {artifact.physical_evidence_available
              ? <CheckCircle2 size={15} />
              : <CircleAlert size={15} />}
            Physical delivery
          </span>
          <strong>{artifact.title}</strong>
        </div>
      </header>
      <p>
        {artifact.physical_evidence_available
          ? `${artifact.evidence_count} independent delivery record${artifact.evidence_count === 1 ? "" : "s"} found.`
          : artifact.note}
      </p>
    </section>
  );
}

function Artifact({
  projectId,
  artifact,
  onOpenExperiment,
}: {
  projectId: string;
  artifact: AssistantEvidenceArtifact;
  onOpenExperiment?: (slug: string) => void;
}) {
  if (artifact.kind === "experiment_chart") {
    return (
      <ExperimentChartArtifact
        projectId={projectId}
        artifact={artifact}
        onOpenExperiment={onOpenExperiment}
      />
    );
  }
  if (artifact.kind === "operation_receipt") return <OperationReceipt artifact={artifact} />;
  if (artifact.kind === "status") return <StatusArtifact artifact={artifact} />;
  return <DeliveryEvidence artifact={artifact} />;
}

export function AssistantEvidenceArtifacts({
  projectId,
  evidence,
  onOpenExperiment,
}: {
  projectId: string;
  evidence: AssistantEvidenceBundle;
  onOpenExperiment?: (slug: string) => void;
}) {
  if (!evidence.artifacts.length && !evidence.sources.length) return null;
  return (
    <div className="assistant-evidence-stack">
      {evidence.artifacts.map((artifact, index) => (
        <Artifact
          key={`${artifact.kind}-${artifact.title}-${index}`}
          projectId={projectId}
          artifact={artifact}
          onOpenExperiment={onOpenExperiment}
        />
      ))}
      {evidence.sources.length ? (
        <div className="assistant-evidence-sources">
          <Droplets size={14} />
          <strong>Checked</strong>
          {evidence.sources.map((source) => (
            <span className={source.available ? "" : "is-unavailable"} key={`${source.tool}-${source.observed_at}`}>
              {source.label}
              {source.observed_at ? ` · ${formatEvidenceTime(source.observed_at)}` : ""}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
