import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  FlaskConical,
  History,
  Lock,
  Pause,
  Play,
  RotateCcw,
  Save,
  Square,
  Trash2,
} from "lucide-react";
import { SettingsEmptyState, StatusChip } from "./SettingsChrome";
import type { StatusTone } from "./settingsPresentation";
import {
  AutocalRun,
  algorithmVersion,
  confidenceLevel,
  defaultConfig,
  faultLabels,
  scoreAgainstTruth,
  type AutocalConfig,
  type Phase,
  type ProposedPair,
  type RunStatus,
} from "./autocal/engine";
import { normalizeSeed } from "./autocal/random";
import {
  buildWorld,
  clampPotCount,
  maxSimulatedPots,
  minSimulatedPots,
  simPresets,
  type MirrorPairing,
  type PresetId,
  type SimWorld,
} from "./autocal/simulator";
import { browserStorage, buildStoredRun, deleteRun, loadRuns, saveRun, type StoredRun } from "./autocal/store";
import type { PairingRow } from "./types";
import "./autocalibrate.css";

// SIMULATION ONLY. This screen receives the current pairings as read-only data
// and has no way to queue a control command or write a pairing.

type AutocalibrateProps = {
  projectId: string;
  experimentId: string;
  experimentName: string;
  pairings: readonly PairingRow[];
};

type Tab = "overview" | "simulation" | "history";
type Stage = "setup" | "running" | "review";
type Speed = "normal" | "fast" | "instant";

const phaseSteps: Array<{ id: Exclude<Phase, "done">; title: string; detail: string }> = [
  { id: "baseline", title: "Validate sensors", detail: "Poll every sensor before any water is applied." },
  { id: "discovery", title: "Discover topology", detail: "Pulse one valve at a time and watch every sensor." },
  { id: "characterization", title: "Characterize response", detail: "Repeat each pulse to bound lag, settling, and gain." },
  { id: "verification", title: "Verify", detail: "Check that ordinary watering still moves the expected sensor." },
];

const statusPresentation: Record<RunStatus, { tone: StatusTone; label: string }> = {
  running: { tone: "info", label: "Running" },
  completed: { tone: "ok", label: "Completed" },
  completed_with_faults: { tone: "warning", label: "Completed with findings" },
  aborted: { tone: "bad", label: "Aborted" },
  timeout: { tone: "bad", label: "Timed out" },
};

function formatSimulatedDuration(seconds: number) {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${String(minutes % 60).padStart(2, "0")} min`;
}

function formatWallClock(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  return date.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function SimulationBadge() {
  return (
    <p className="autocal-sim-badge">
      <FlaskConical size={14} aria-hidden="true" />
      <strong>Simulation</strong>
      <span>No controller, valve, or sensor is contacted. Nothing here changes your pairings.</span>
    </p>
  );
}

function ConfidenceMeter({ value }: { value: number }) {
  const percent = Math.round(value * 100);
  return (
    <span className="autocal-confidence">
      <span className="autocal-confidence-track" aria-hidden="true">
        <span style={{ width: `${percent}%` }} />
      </span>
      <span>{percent}% · {confidenceLevel(value)}</span>
    </span>
  );
}

const matrixScaleMaxVwc = 4;

function matrixColor(deltaVwc: number) {
  // Single-hue sequential ramp (portal blue), light to dark.
  const t = Math.min(1, Math.max(0, deltaVwc / matrixScaleMaxVwc));
  const from = [238, 244, 251];
  const to = [11, 74, 153];
  const channel = (index: number) => Math.round(from[index] + (to[index] - from[index]) * t);
  return `rgb(${channel(0)}, ${channel(1)}, ${channel(2)})`;
}

function ResponseMatrix({ run, tick }: { run: AutocalRun; tick: number }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const size = run.world.valves.length;
  const cell = Math.max(4, Math.min(22, Math.floor(528 / size)));
  const gutter = 14;
  const extent = gutter + cell * size;

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(extent * ratio);
    canvas.height = Math.round(extent * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, extent, extent);

    const excluded = new Set(run.validations.filter((item) => !item.valid).map((item) => item.sensorIndex));
    const gap = cell >= 8 ? 1 : 0;
    for (let v = 0; v < size; v += 1) {
      const row = run.deltaMatrix[v];
      for (let s = 0; s < size; s += 1) {
        const x = gutter + s * cell;
        const y = gutter + v * cell;
        context.fillStyle = !row ? "#f4f5f7" : excluded.has(s) ? "#eceef1" : matrixColor(row[s] ?? 0);
        context.fillRect(x, y, cell - gap, cell - gap);
      }
    }

    // Excluded sensors are hatched, so the cue is texture as well as tone.
    context.strokeStyle = "#9aa2ad";
    context.lineWidth = 1;
    excluded.forEach((s) => {
      const x = gutter + s * cell;
      context.save();
      context.beginPath();
      context.rect(x, gutter, cell, cell * size);
      context.clip();
      for (let offset = -cell * size; offset < cell * size; offset += 6) {
        context.beginPath();
        context.moveTo(x, gutter + offset + cell);
        context.lineTo(x + cell, gutter + offset);
        context.stroke();
      }
      context.restore();
    });

    // Proposed pairs get a dark ring: identity is never carried by color alone.
    context.strokeStyle = "#0f172a";
    context.lineWidth = cell >= 8 ? 2 : 1;
    run.proposals.forEach((pair) => {
      context.strokeRect(gutter + pair.sensorIndex * cell + 0.5, gutter + pair.valveIndex * cell + 0.5, cell - 1, cell - 1);
    });

    if (run.activeValveIndex != null) {
      const y = gutter + run.activeValveIndex * cell;
      context.strokeStyle = "#2f8cff";
      context.lineWidth = 2;
      context.strokeRect(gutter - 1, y - 1, cell * size + 2, cell + 2);
      context.fillStyle = "#2f8cff";
      context.beginPath();
      context.moveTo(2, y + cell / 2 - 4);
      context.lineTo(10, y + cell / 2);
      context.lineTo(2, y + cell / 2 + 4);
      context.closePath();
      context.fill();
    }
  }, [run, tick, cell, extent, size]);

  function describeCell(clientX: number, clientY: number) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const bounds = canvas.getBoundingClientRect();
    const scale = extent / bounds.width;
    const s = Math.floor(((clientX - bounds.left) * scale - gutter) / cell);
    const v = Math.floor(((clientY - bounds.top) * scale - gutter) / cell);
    if (s < 0 || v < 0 || s >= size || v >= size) {
      setHover(null);
      return;
    }
    const valveId = run.world.valves[v].id;
    const sensorId = run.world.sensors[s].id;
    const row = run.deltaMatrix[v];
    const validation = run.validations[s];
    if (validation && !validation.valid) setHover(`Sensor ${sensorId} was excluded by the self-test.`);
    else if (!row) setHover(`Valve ${valveId} has not been pulsed yet.`);
    else {
      const proposed = run.proposals.some((pair) => pair.valveIndex === v && pair.sensorIndex === s);
      const detected = run.detectedMatrix[v]?.[s];
      setHover(`Valve ${valveId} → sensor ${sensorId}: +${(row[s] ?? 0).toFixed(2)}% VWC${proposed ? " · proposed pair" : detected ? " · responded" : ""}`);
    }
  }

  const pulsed = run.deltaMatrix.filter(Boolean).length;
  return (
    <figure className="autocal-matrix">
      <figcaption>
        <strong>Response matrix</strong>
        <span>Valves down, sensors across. Each row fills in when that simulated valve is pulsed.</span>
      </figcaption>
      <div className="autocal-matrix-scroll">
        <canvas
          ref={canvasRef}
          style={{ maxWidth: extent }}
          role="img"
          aria-label={`Simulated response matrix. ${pulsed} of ${size} valves pulsed, ${run.proposals.length} pairs proposed. The proposed pairings table lists the same evidence.`}
          onMouseMove={(event) => describeCell(event.clientX, event.clientY)}
          onClick={(event) => describeCell(event.clientX, event.clientY)}
          onMouseLeave={() => setHover(null)}
        />
      </div>
      <p className="autocal-matrix-readout">{hover ?? "Point at or tap a cell to read its value."}</p>
      <ul className="autocal-legend" aria-label="Matrix legend">
        <li><span className="autocal-legend-ramp" aria-hidden="true" /> 0 to {matrixScaleMaxVwc}%+ VWC rise</li>
        <li><span className="autocal-legend-ring" aria-hidden="true" /> Proposed pair</li>
        <li><span className="autocal-legend-hatch" aria-hidden="true" /> Excluded sensor</li>
        <li><span className="autocal-legend-empty" aria-hidden="true" /> Not pulsed yet</li>
      </ul>
    </figure>
  );
}

function SensorTraces({ run }: { run: AutocalRun }) {
  const observation = run.lastObservation;
  if (!observation || observation.traces.length === 0) {
    return <p className="settings-muted">Sensor traces appear here when the first simulated valve is pulsed.</p>;
  }
  const width = 400;
  const height = 190;
  const pad = { left: 30, right: 84, top: 10, bottom: 24 };
  const interval = run.config.sampleIntervalSeconds;
  const samples = observation.traces[0]?.length ?? 0;
  const responders = observation.responses.filter((item) => item.detected).sort((a, b) => b.deltaVwc - a.deltaVwc);
  const responderSet = new Set(responders.map((item) => item.sensorIndex));
  const maxDelta = Math.max(1, ...responders.map((item) => item.peakDeltaVwc * 1.15));
  const minDelta = -0.5;
  const x = (index: number) => pad.left + (index / Math.max(1, samples - 1)) * (width - pad.left - pad.right);
  const y = (value: number) => pad.top + (1 - (value - minDelta) / (maxDelta - minDelta)) * (height - pad.top - pad.bottom);
  const path = (sensorIndex: number) => {
    const base = observation.preMeans[sensorIndex];
    if (base == null) return "";
    return observation.traces[sensorIndex]
      .map((value, index) => (value == null ? "" : `${index === 0 ? "M" : "L"}${x(index).toFixed(1)},${y(Math.max(minDelta, Math.min(maxDelta, value - base))).toFixed(1)}`))
      .join(" ");
  };
  const quiet = observation.responses.filter((item) => !responderSet.has(item.sensorIndex)).slice(0, 28);
  const ticks = [0, Math.round(maxDelta / 2), Math.floor(maxDelta)].filter((value, index, all) => all.indexOf(value) === index);

  return (
    <figure className="autocal-traces">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Change in VWC for the sensors watched after simulated valve ${run.world.valves[observation.valveIndex].id} was pulsed. ${responders.length} responded.`}>
        {ticks.map((value) => (
          <g key={value}>
            <line x1={pad.left} x2={width - pad.right} y1={y(value)} y2={y(value)} className="autocal-grid" />
            <text x={pad.left - 6} y={y(value) + 4} textAnchor="end" className="autocal-axis">{value > 0 ? `+${value}` : value}</text>
          </g>
        ))}
        {quiet.map((item) => <path key={item.sensorIndex} d={path(item.sensorIndex)} className="autocal-trace-quiet" />)}
        {responders.slice(0, 3).map((item, index) => {
          const base = observation.preMeans[item.sensorIndex] ?? 0;
          const last = observation.traces[item.sensorIndex][samples - 1];
          return (
            <g key={item.sensorIndex}>
              <path d={path(item.sensorIndex)} className={index === 0 ? "autocal-trace-main" : "autocal-trace-second"} />
              <text x={width - pad.right + 6} y={y(Math.min(maxDelta, (last ?? base) - base)) + 4} className="autocal-trace-label">
                {run.world.sensors[item.sensorIndex].id}
              </text>
            </g>
          );
        })}
        <text x={pad.left} y={height - 6} className="autocal-axis">0 s</text>
        <text x={width - pad.right} y={height - 6} textAnchor="end" className="autocal-axis">{samples * interval} s after pulse</text>
      </svg>
      <figcaption>Change in VWC (%) since the pulse. Responding sensors are drawn bold and labeled; the rest stay flat.</figcaption>
    </figure>
  );
}

function ProposalTable({ world, proposals }: { world: SimWorld; proposals: ProposedPair[] }) {
  const recorded = useMemo(() => new Map(world.recordedPairings.map((row) => [row.valveId, row.sensorId])), [world]);
  if (proposals.length === 0) {
    return <SettingsEmptyState title="No pairings proposed">This run did not produce a mapping. See the findings below.</SettingsEmptyState>;
  }
  return (
    <div className="settings-table-wrap is-scrollable">
      <table className="settings-table autocal-table">
        <thead>
          <tr>
            <th scope="col">Valve</th>
            <th scope="col">Proposed sensor</th>
            <th scope="col">Confidence</th>
            <th scope="col">Status</th>
            <th scope="col">Recorded today</th>
            <th scope="col">Response</th>
            <th scope="col">Conservative gain</th>
            <th scope="col">Verified</th>
          </tr>
        </thead>
        <tbody>
          {proposals.map((pair) => {
            const valveId = world.valves[pair.valveIndex].id;
            const sensorId = world.sensors[pair.sensorIndex].id;
            const recordedSensor = recorded.get(valveId);
            const estimate = pair.characterization;
            return (
              <tr key={valveId} className={recordedSensor && recordedSensor !== sensorId ? "is-different" : ""}>
                <td><code className="settings-identity">{valveId}</code></td>
                <td>
                  <code className="settings-identity">{sensorId}</code>
                  <span className="autocal-subtle">{world.pots[pair.sensorIndex].label}</span>
                </td>
                <td><ConfidenceMeter value={pair.confidence} /></td>
                <td>
                  <StatusChip tone={pair.status === "proposed" ? "ok" : "warning"}>
                    {pair.status === "proposed" ? "Proposed" : "Needs review"}
                  </StatusChip>
                  {pair.faults.length ? <span className="autocal-subtle">{pair.faults.map((code) => faultLabels[code]).join(", ")}</span> : null}
                </td>
                <td>
                  {recordedSensor == null ? (
                    <span className="settings-empty-value">No record</span>
                  ) : recordedSensor === sensorId ? (
                    <span>Same sensor</span>
                  ) : (
                    <>
                      <strong className="autocal-different">Different</strong>
                      <span className="autocal-subtle">recorded <code className="settings-identity">{recordedSensor}</code></span>
                    </>
                  )}
                </td>
                <td>
                  +{(estimate?.deltaVwc ?? pair.evidence.deltaVwc).toFixed(1)}% VWC from {pair.evidence.pulseSeconds}s{pair.evidence.escalated ? " (longer pulse)" : ""}
                  <span className="autocal-subtle">
                    {estimate?.lagSeconds != null ? `lag ${estimate.lagSeconds}s` : "lag —"} · {estimate?.settleSeconds != null ? `settles ${estimate.settleSeconds}s` : "not settled"}
                  </span>
                </td>
                <td>
                  {estimate && estimate.conservativeGainPerSecond > 0
                    ? <>≥ {estimate.conservativeGainPerSecond.toFixed(2)}% VWC/s<span className="autocal-subtle">{estimate.pass ? "Pass" : "Fail"} · range {estimate.deltaRange[0].toFixed(1)}–{estimate.deltaRange[1].toFixed(1)}%</span></>
                    : <><span className="settings-empty-value">No estimate</span><span className="autocal-subtle">{estimate?.note ?? "Not characterized"}</span></>}
                </td>
                <td>{pair.lastVerifiedAtSeconds != null ? "In this run" : <span className="settings-empty-value">Not sampled</span>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function FindingsList({ run }: { run: AutocalRun }) {
  if (run.faults.length === 0) {
    return <p className="settings-muted">{run.done ? "No faults were found." : "No faults so far."}</p>;
  }
  return (
    <ul className="autocal-findings">
      {run.faults.map((fault, index) => (
        <li key={`${fault.code}-${index}`}>
          <AlertTriangle size={15} aria-hidden="true" />
          <div>
            <strong>{faultLabels[fault.code]}</strong>
            <p>{fault.message}</p>
          </div>
        </li>
      ))}
    </ul>
  );
}

export function Autocalibrate({ projectId, experimentId, experimentName, pairings }: AutocalibrateProps) {
  const [tab, setTab] = useState<Tab>("overview");
  const [stage, setStage] = useState<Stage>("setup");
  const [presetId, setPresetId] = useState<PresetId>("clean-24");
  const [potCount, setPotCount] = useState("24");
  const [seedText, setSeedText] = useState("2026");
  const [pulseSeconds, setPulseSeconds] = useState(String(defaultConfig.pulseSeconds));
  const [observeSeconds, setObserveSeconds] = useState(String(defaultConfig.observeSeconds));
  const [injectHoseSwap, setInjectHoseSwap] = useState(false);
  const [useMirror, setUseMirror] = useState(false);
  const [speed, setSpeed] = useState<Speed>("normal");
  const [paused, setPaused] = useState(false);
  const [tick, setTick] = useState(0);
  const [announcement, setAnnouncement] = useState("");
  const [savedRunId, setSavedRunId] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [storedRuns, setStoredRuns] = useState<StoredRun[]>(() => loadRuns(browserStorage(), projectId));
  const [openStoredRunId, setOpenStoredRunId] = useState<string | null>(null);
  const runRef = useRef<AutocalRun | null>(null);
  const runMeta = useRef<{ runId: string; startedAt: Date } | null>(null);

  const mirror = useMemo<MirrorPairing[]>(() => pairings.map((pairing) => ({
    valveId: pairing.valve_key,
    sensorId: pairing.sensor_key,
    potLabel: pairing.name || `Pot ${pairing.pot_number}`,
  })), [pairings]);
  const mirrorAvailable = new Set(mirror.map((row) => row.valveId)).size >= minSimulatedPots;
  const preset = simPresets.find((item) => item.id === presetId) ?? simPresets[0];
  const run = runRef.current;

  useEffect(() => {
    setStoredRuns(loadRuns(browserStorage(), projectId));
  }, [projectId]);

  useEffect(() => {
    if (stage !== "running" || paused) return undefined;
    const active = runRef.current;
    if (!active) return undefined;
    const planned = active.world.valves.length * 2 + 20;
    // Normal playback takes roughly 20–30 s at any size so each pulse can be followed.
    const perTick = speed === "fast" ? Math.max(2, Math.ceil(planned / 60)) : Math.max(1, Math.ceil(planned / 110));
    const timer = window.setInterval(() => {
      let phase = active.phase;
      for (let count = 0; count < perTick && !active.done; count += 1) {
        active.step();
        if (active.phase !== phase) {
          phase = active.phase;
          const step = phaseSteps.find((item) => item.id === phase);
          if (step) setAnnouncement(`Simulation phase: ${step.title}.`);
        }
      }
      setTick((value) => value + 1);
      if (active.done) {
        window.clearInterval(timer);
        setAnnouncement(`Simulated run ${statusPresentation[active.status].label.toLowerCase()}.`);
        setStage("review");
      }
    }, speed === "fast" ? 70 : 260);
    return () => window.clearInterval(timer);
  }, [stage, paused, speed]);

  function startRun(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const seed = normalizeSeed(seedText);
    const pulse = Math.min(10, Math.max(2, Number(pulseSeconds) || defaultConfig.pulseSeconds));
    const observe = Math.min(900, Math.max(300, Number(observeSeconds) || defaultConfig.observeSeconds));
    const config: Partial<AutocalConfig> = {
      pulseSeconds: pulse,
      escalatedPulseSeconds: Math.min(20, pulse * 2),
      observeSeconds: observe,
      injectHoseSwap,
    };
    const world = buildWorld({
      presetId,
      seed,
      potCount: clampPotCount(Number(potCount)),
      mirror: useMirror && mirrorAvailable ? mirror : undefined,
    });
    const next = new AutocalRun(world, config);
    runRef.current = next;
    runMeta.current = { runId: `sim-${Date.now().toString(36)}-${seed}`, startedAt: new Date() };
    setSeedText(String(seed));
    setSavedRunId(null);
    setSaveError(null);
    setPaused(false);
    setAnnouncement("Simulated run started.");
    if (speed === "instant") {
      next.runToCompletion();
      setAnnouncement(`Simulated run ${statusPresentation[next.status].label.toLowerCase()}.`);
      setStage("review");
    } else {
      setStage("running");
    }
    setTick((value) => value + 1);
  }

  function abortRun() {
    const active = runRef.current;
    if (!active) return;
    active.abort();
    setAnnouncement("Simulated run aborted.");
    setStage("review");
    setTick((value) => value + 1);
  }

  function saveProposal() {
    const active = runRef.current;
    const meta = runMeta.current;
    if (!active || !meta) return;
    const storage = browserStorage();
    const stored = buildStoredRun({
      runId: meta.runId,
      projectId,
      experimentId,
      world: active.world,
      config: active.config,
      result: active.result(),
      startedAt: meta.startedAt,
      endedAt: new Date(),
      existingRuns: loadRuns(storage, projectId),
    });
    if (saveRun(storage, projectId, stored)) {
      setSavedRunId(stored.runId);
      setSaveError(null);
      setStoredRuns(loadRuns(storage, projectId));
    } else {
      setSaveError("This browser blocked local storage, so the proposal could not be saved.");
    }
  }

  function removeStoredRun(runId: string) {
    const storage = browserStorage();
    deleteRun(storage, projectId, runId);
    setStoredRuns(loadRuns(storage, projectId));
    if (openStoredRunId === runId) setOpenStoredRunId(null);
  }

  function replay(stored: StoredRun) {
    setPresetId(stored.simulator.presetId);
    setPotCount(String(stored.simulator.potCount));
    setSeedText(String(stored.simulator.seed));
    setPulseSeconds(String(stored.config.pulseSeconds));
    setObserveSeconds(String(stored.config.observeSeconds));
    setInjectHoseSwap(Boolean(stored.config.injectHoseSwap));
    setUseMirror(stored.simulator.source === "mirror" && mirrorAvailable);
    setStage("setup");
    setTab("simulation");
  }

  const effectivePots = useMirror && mirrorAvailable ? new Set(mirror.map((row) => row.valveId)).size : clampPotCount(Number(potCount));
  const estimatedSeconds = defaultConfig.baselineSamples * defaultConfig.sampleIntervalSeconds
    + (effectivePots * 2 + defaultConfig.verificationEvents) * ((Number(pulseSeconds) || 4) + (Number(observeSeconds) || 420));

  const overview = (
    <>
      <p className="settings-principle">
        <strong>Identity is fixed. Topology is discovered and continuously verified.</strong> A sensor keeps its identity
        and a valve output keeps its identity. What Autocalibrate works out is which valve physically waters the pot that
        each sensor is in, so hoses no longer have to be matched by hand.
      </p>
      <div className="settings-grid">
        {phaseSteps.map((step, index) => (
          <section className="settings-card" key={step.id}>
            <h3>{index + 1}. {step.title}</h3>
            <p className="settings-muted">{[
              "Each sensor is polled before any water is applied. Sensors that are unreachable, stuck, implausible, too noisy, saturated, or reporting raw counts are excluded. This is a self-test, not a physical sensor calibration.",
              "One valve at a time gets a short diagnostic pulse while every sensor is watched for a delayed, sustained rise. The responses form a valve-by-sensor matrix, and pairs are chosen one-to-one across the whole matrix so no sensor is claimed twice. A silent valve gets one longer pulse, then a safe failure.",
              "Each discovered pair is pulsed once more to bound its lag, settling time, and a deliberately conservative gain. Soil does not respond linearly, so these are starting estimates for observe-then-recalculate dosing, not a prediction.",
              "Ordinary watering events double as checks: the expected sensor should rise and unrelated sensors should not. A mismatch flags the pairing for review. It never rewrites the configuration on its own.",
            ][index]}</p>
          </section>
        ))}
      </div>
      <div className="settings-grid">
        <section className="settings-card">
          <h3>What works today</h3>
          <div className="settings-rows">
            <div className="settings-row"><span>Simulated installations up to {maxSimulatedPots} pots</span><strong><StatusChip tone="ok">Available</StatusChip></strong></div>
            <div className="settings-row"><span>Saved proposals in this browser</span><strong><StatusChip tone="ok">Available</StatusChip></strong></div>
            <div className="settings-row"><span>Running on real valves and sensors</span><strong><StatusChip tone="unknown">Not available</StatusChip></strong></div>
            <div className="settings-row"><span>Applying a proposal to the controller</span><strong><StatusChip tone="unknown">Not available</StatusChip></strong></div>
          </div>
        </section>
        <section className="settings-card">
          <h3>Hardware commissioning</h3>
          <p className="settings-muted">
            Running Autocalibrate on a real bench opens valves, so it needs commissioning authorization, a supervised
            bench test, and its own review step. None of that exists in this release, and a simulated result says
            nothing about how real hardware will behave.
          </p>
          <button type="button" className="settings-locked-button" disabled>
            <Lock size={14} aria-hidden="true" /> Requires commissioning authorization
          </button>
        </section>
      </div>
      <div>
        <button type="button" className="settings-primary-button" onClick={() => setTab("simulation")}>
          <Play size={14} aria-hidden="true" /> Open the simulation
        </button>
      </div>
    </>
  );

  const setup = (
    <form className="autocal-setup" onSubmit={startRun}>
      <div className="settings-grid">
        <section className="settings-card">
          <h3>Simulated installation</h3>
          <div className="settings-form">
            <fieldset className="autocal-choice">
              <legend>What to simulate</legend>
              <label>
                <input type="radio" name="autocal-source" checked={!useMirror} onChange={() => setUseMirror(false)} />
                <span><strong>A made-up installation</strong>Generated sensors, valves, and a hidden random layout.</span>
              </label>
              <label className={mirrorAvailable ? "" : "is-disabled"}>
                <input type="radio" name="autocal-source" checked={useMirror && mirrorAvailable} disabled={!mirrorAvailable} onChange={() => setUseMirror(true)} />
                <span>
                  <strong>A copy of {experimentName}</strong>
                  {mirrorAvailable
                    ? `Uses the ${new Set(mirror.map((row) => row.valveId)).size} recorded pairings as a read-only starting point. The real controller is not contacted.`
                    : `Needs at least ${minSimulatedPots} recorded pairings.`}
                </span>
              </label>
            </fieldset>
            <label>
              Scenario
              <select value={presetId} onChange={(event) => {
                const next = event.target.value as PresetId;
                setPresetId(next);
                setPotCount(String(simPresets.find((item) => item.id === next)?.defaultPotCount ?? 24));
              }}>
                {simPresets.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
              </select>
            </label>
            <p className="settings-muted">{preset.description}</p>
            <div className="settings-field-grid is-two">
              <label>
                Pots ({minSimulatedPots}–{maxSimulatedPots})
                <input type="number" min={minSimulatedPots} max={maxSimulatedPots} step="1" value={useMirror && mirrorAvailable ? String(effectivePots) : potCount} disabled={useMirror && mirrorAvailable} onChange={(event) => setPotCount(event.target.value)} required />
              </label>
              <label>
                Seed
                <input type="number" min="0" step="1" value={seedText} onChange={(event) => setSeedText(event.target.value)} required />
              </label>
            </div>
            <p className="settings-muted">The same scenario, size, and seed always reproduce the same run.</p>
          </div>
        </section>
        <section className="settings-card">
          <h3>Diagnostic pulse</h3>
          <div className="settings-form">
            <div className="settings-field-grid is-two">
              <label>
                Pulse length (sec)
                <input type="number" min="2" max="10" step="1" value={pulseSeconds} onChange={(event) => setPulseSeconds(event.target.value)} required />
              </label>
              <label>
                Watch each pulse for (sec)
                <input type="number" min="300" max="900" step="30" value={observeSeconds} onChange={(event) => setObserveSeconds(event.target.value)} required />
              </label>
            </div>
            <p className="settings-muted">
              A silent valve gets exactly one longer pulse ({Math.min(20, (Number(pulseSeconds) || 4) * 2)} sec), then is
              reported as unresolved. A run of this size would take about {formatSimulatedDuration(estimatedSeconds)} on a
              real bench; the simulation replays it in seconds.
            </p>
            <label className="settings-check">
              <input type="checkbox" checked={injectHoseSwap} onChange={(event) => setInjectHoseSwap(event.target.checked)} />
              <span>During verification, swap two simulated hoses to show a mismatch being caught</span>
            </label>
            <label>
              Playback speed
              <select value={speed} onChange={(event) => setSpeed(event.target.value as Speed)}>
                <option value="normal">Normal</option>
                <option value="fast">Fast</option>
                <option value="instant">Skip to results</option>
              </select>
            </label>
          </div>
        </section>
      </div>
      <section className="settings-card">
        <h3>Where this runs</h3>
        <fieldset className="autocal-choice is-row">
          <legend className="settings-visually-hidden">Run target</legend>
          <label>
            <input type="radio" name="autocal-target" checked readOnly />
            <span><strong>Simulation</strong>Runs entirely in this browser.</span>
          </label>
          <label className="is-disabled">
            <input type="radio" name="autocal-target" disabled />
            <span><strong><Lock size={13} aria-hidden="true" /> Real hardware</strong>Requires commissioning authorization. Not available in this release.</span>
          </label>
        </fieldset>
        <div>
          <button type="submit" className="settings-primary-button">
            <Play size={14} aria-hidden="true" /> Start simulated run
          </button>
        </div>
      </section>
    </form>
  );

  const stepper = run ? (() => {
    const finished = run.status === "completed" || run.status === "completed_with_faults";
    // Where the run is now, or where it stopped if it was aborted or timed out.
    const position = run.phase !== "done"
      ? phaseSteps.findIndex((item) => item.id === run.phase)
      : finished
        ? phaseSteps.length
        : run.verification.length ? 3 : run.proposals.length ? 2 : run.validations.length ? 1 : 0;
    return (
      <ol className="autocal-stepper" aria-label="Simulation phases">
        {phaseSteps.map((step, index) => {
          const state = index < position ? "done" : index === position ? (run.done ? "stopped" : "current") : "pending";
          const stateLabel = { done: "Done", current: "In progress", stopped: "Stopped here", pending: run.done ? "Not reached" : "Waiting" }[state];
          return (
            <li key={step.id} className={`is-${state}`} aria-current={state === "current" ? "step" : undefined}>
              <span className="autocal-step-index" aria-hidden="true">{state === "done" ? <CheckCircle2 size={16} /> : index + 1}</span>
              <span>
                <strong>{step.title}</strong>
                <em>{stateLabel}</em>
              </span>
            </li>
          );
        })}
      </ol>
    );
  })() : null;

  const running = run ? (
    <>
      {stepper}
      <div className="autocal-runbar">
        <label className="autocal-progress">
          <span>{Math.round(run.progress * 100)}% · simulated time {formatSimulatedDuration(run.elapsedSeconds)}</span>
          <progress value={run.progress} max={1} />
        </label>
        <div className="autocal-run-actions">
          <button type="button" className="settings-secondary-button" onClick={() => setPaused((value) => !value)}>
            {paused ? <Play size={14} aria-hidden="true" /> : <Pause size={14} aria-hidden="true" />}
            {paused ? "Resume" : "Pause"}
          </button>
          <button type="button" className="settings-secondary-button" onClick={() => setSpeed(speed === "fast" ? "normal" : "fast")} aria-pressed={speed === "fast"}>
            Fast
          </button>
          <button type="button" className="settings-danger-button" onClick={abortRun}>
            <Square size={13} aria-hidden="true" /> Abort
          </button>
        </div>
      </div>
      <div className="autocal-run-grid">
        <div className="autocal-run-side">
          <section className="settings-card">
            <h3>Active simulated valve</h3>
            <div className="settings-rows">
              <div className="settings-row">
                <span>Valve</span>
                <strong>{run.activeValveIndex != null ? <code className="settings-identity">{run.world.valves[run.activeValveIndex].id}</code> : <span className="settings-empty-value">None open</span>}</strong>
              </div>
              <div className="settings-row">
                <span>Simulated pulse</span>
                <strong>{run.lastObservation ? `${run.lastObservation.pulseSeconds} sec${run.lastObservation.purpose === "escalation" ? " (longer retry)" : ""}` : "—"}</strong>
              </div>
              <div className="settings-row">
                <span>Simulated flow reading</span>
                <strong>{run.lastObservation ? `${Math.round(run.lastObservation.flowMl)} of ${Math.round(run.lastObservation.expectedFlowMl)} mL` : "—"}</strong>
              </div>
              <div className="settings-row">
                <span>Sensors being watched</span>
                <strong>{run.validations.length ? `${run.validations.filter((item) => item.valid).length} of ${run.world.sensors.length}` : `${run.world.sensors.length}`}</strong>
              </div>
            </div>
            <p className="autocal-logline">{run.log[run.log.length - 1] ?? "Starting…"}</p>
          </section>
          <section className="settings-card">
            <h3>Sensor traces</h3>
            <SensorTraces run={run} />
          </section>
        </div>
        <section className="settings-card">
          <ResponseMatrix run={run} tick={tick} />
        </section>
      </div>
      <div className="settings-grid">
        <section className="settings-card">
          <h3>Findings so far</h3>
          <FindingsList run={run} />
        </section>
        <section className="settings-card">
          <h3>Discovered mapping</h3>
          {run.proposals.length === 0 ? (
            <p className="settings-muted">Pairs are chosen together, across the whole matrix, once every valve has been pulsed.</p>
          ) : (
            <div className="settings-rows">
              <div className="settings-row"><span>Pairs proposed</span><strong>{run.proposals.length} of {run.world.valves.length}</strong></div>
              <div className="settings-row"><span>Need review</span><strong>{run.proposals.filter((pair) => pair.status === "needs_review").length}</strong></div>
              <div className="settings-row"><span>Unresolved valves</span><strong>{run.unresolvedValves.length}</strong></div>
              <div className="settings-row"><span>Characterized</span><strong>{run.proposals.filter((pair) => pair.characterization).length}</strong></div>
            </div>
          )}
        </section>
      </div>
    </>
  ) : null;

  const review = run ? (() => {
    const result = run.result();
    const presentation = statusPresentation[run.status];
    const score = scoreAgainstTruth(run.world, result);
    const excluded = result.validations.filter((item) => !item.valid);
    const canSave = run.status === "completed" || run.status === "completed_with_faults" || run.status === "timeout";
    const recorded = new Map(run.world.recordedPairings.map((row) => [row.valveId, row.sensorId]));
    const differences = result.proposals.filter((pair) => {
      const sensorId = recorded.get(run.world.valves[pair.valveIndex].id);
      return sensorId != null && sensorId !== run.world.sensors[pair.sensorIndex].id;
    }).length;
    return (
      <>
        {stepper}
        <section className="settings-card">
          <div className="settings-card-head">
            <h3>Simulated run result</h3>
            <StatusChip tone={presentation.tone}>{presentation.label}</StatusChip>
          </div>
          <div className="autocal-summary">
            <div><strong>{result.proposals.filter((pair) => pair.status === "proposed").length}</strong><span>pairs proposed</span></div>
            <div><strong>{result.proposals.filter((pair) => pair.status === "needs_review").length}</strong><span>need review</span></div>
            <div><strong>{result.unresolvedValves.length}</strong><span>valves unresolved</span></div>
            <div><strong>{excluded.length}</strong><span>sensors excluded</span></div>
          </div>
          <p className="settings-muted">
            {simPresets.find((item) => item.id === run.world.presetId)?.label} · {run.world.valves.length} pots · seed {run.world.seed} ·
            simulated time {formatSimulatedDuration(result.elapsedSeconds)} · {algorithmVersion}
          </p>
          {run.status === "aborted" ? (
            <p className="settings-muted">The run was stopped early. Partial evidence is shown below, but an aborted run never produces a proposal.</p>
          ) : null}
          {run.status === "timeout" ? (
            <p className="settings-muted">The run hit its time budget and stopped safely. Anything it did not reach is listed as unresolved.</p>
          ) : null}
          {run.world.recordedPairings.length ? (
            <p className="settings-muted">
              Compared with the {run.world.recordedPairings.length} recorded pairings: {differences === 0 ? "every proposed pair matches the record." : `${differences} proposed ${differences === 1 ? "pair differs" : "pairs differ"} from the record.`}
            </p>
          ) : (
            <p className="settings-muted">This simulated installation is new, so there are no recorded pairings to compare against.</p>
          )}
          <p className="autocal-answer-key">
            <strong>Simulator answer key:</strong> {score.correct} of {result.proposals.length} proposed pairs match the hidden layout{score.wrong ? `; ${score.wrong} do not` : ""}.
            Only a simulation has an answer key. On real hardware this number cannot exist, which is why every proposal needs review.
          </p>
        </section>

        <div className="settings-section-heading">
          <h3>Proposed pairings</h3>
          <p>Proposals only. Your active pairings are unchanged.</p>
        </div>
        <ProposalTable world={run.world} proposals={result.proposals} />

        <div className="settings-grid">
          <section className="settings-card">
            <h3>Unresolved valves</h3>
            {result.unresolvedValves.length === 0 ? <p className="settings-muted">Every valve was resolved.</p> : (
              <ul className="autocal-plain-list">
                {result.unresolvedValves.map((item) => (
                  <li key={item.valveIndex}>
                    <code className="settings-identity">{run.world.valves[item.valveIndex].id}</code>
                    <span><strong>{faultLabels[item.reason]}.</strong> {item.detail}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="settings-card">
            <h3>Excluded sensors</h3>
            {excluded.length === 0 ? <p className="settings-muted">Every sensor passed the self-test.</p> : (
              <ul className="autocal-plain-list">
                {excluded.map((item) => (
                  <li key={item.sensorIndex}>
                    <code className="settings-identity">{run.world.sensors[item.sensorIndex].id}</code>
                    <span>{item.detail}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <div className="settings-grid">
          <section className="settings-card">
            <h3>Findings</h3>
            <FindingsList run={run} />
          </section>
          <section className="settings-card">
            <h3>Continuous verification</h3>
            {result.verification.length === 0 ? (
              <p className="settings-muted">No watering events were checked in this run.</p>
            ) : (
              <>
                <div className="settings-rows">
                  <div className="settings-row"><span>Watering events checked</span><strong>{result.verification.length}</strong></div>
                  <div className="settings-row"><span>Expected sensor responded, nothing else moved</span><strong>{result.verification.filter((item) => item.outcome === "verified").length}</strong></div>
                  <div className="settings-row"><span>Mismatches flagged for review</span><strong>{result.verification.filter((item) => item.outcome === "mismatch").length}</strong></div>
                </div>
                {result.hoseSwapInjected ? (
                  <p className="settings-muted">
                    Two simulated hoses ({result.hoseSwapInjected.map((index) => run.world.valves[index].id).join(" and ")}) were swapped for this demonstration.
                    Verification flags the pairs; it does not rewrite the configuration.
                  </p>
                ) : null}
              </>
            )}
          </section>
        </div>

        <section className="settings-card">
          <ResponseMatrix run={run} tick={tick} />
        </section>

        <section className="settings-card autocal-approval">
          <h3>Keep this proposal</h3>
          <p className="settings-muted">
            Saving keeps this simulated proposal, its seed, and its evidence in this browser so it can be reopened. It is
            stored as “proposed, not applied”. There is no way to apply a proposal to the controller in this release.
          </p>
          <div className="autocal-approval-actions">
            <button type="button" className="settings-primary-button" onClick={saveProposal} disabled={!canSave || savedRunId != null}>
              <Save size={14} aria-hidden="true" />
              {savedRunId ? "Saved as a proposal" : "Save as proposal (does not change active pairings)"}
            </button>
            <button type="button" className="settings-locked-button" disabled>
              <Lock size={14} aria-hidden="true" /> Apply to controller · requires commissioning authorization
            </button>
            <button type="button" className="settings-secondary-button" onClick={() => setStage("setup")}>
              <RotateCcw size={14} aria-hidden="true" /> New simulated run
            </button>
          </div>
          {savedRunId ? <p className="settings-muted" role="status">Saved. Find it under History.</p> : null}
          {saveError ? <p className="settings-error-line" role="alert">{saveError}</p> : null}
        </section>
      </>
    );
  })() : null;

  const openStoredRun = storedRuns.find((item) => item.runId === openStoredRunId) ?? null;
  const history = (
    <>
      {storedRuns.length === 0 ? (
        <SettingsEmptyState title="No saved proposals yet">
          Finish a simulated run and choose “Save as proposal”. Saved proposals stay in this browser only.
        </SettingsEmptyState>
      ) : (
        <div className="settings-table-wrap">
          <table className="settings-table autocal-table">
            <thead>
              <tr>
                <th scope="col">Saved</th>
                <th scope="col">Scenario</th>
                <th scope="col">Result</th>
                <th scope="col">Version</th>
                <th scope="col">State</th>
                <th scope="col"><span className="settings-visually-hidden">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {storedRuns.map((stored) => (
                <tr key={stored.runId}>
                  <td>{formatWallClock(stored.endedAt)}<span className="autocal-subtle">{stored.runId}</span></td>
                  <td>
                    {simPresets.find((item) => item.id === stored.simulator.presetId)?.label ?? stored.simulator.presetId}
                    <span className="autocal-subtle">{stored.simulator.potCount} pots · seed {stored.simulator.seed} · {stored.simulator.source === "mirror" ? "copy of recorded pairings" : "made-up installation"}</span>
                  </td>
                  <td>
                    <StatusChip tone={statusPresentation[stored.status].tone}>{statusPresentation[stored.status].label}</StatusChip>
                    <span className="autocal-subtle">{stored.proposals.length} pairs · {stored.unresolvedValveIds.length} unresolved · {stored.excludedSensorIds.length} excluded</span>
                  </td>
                  <td>{stored.topologyVersion}<span className="autocal-subtle">{stored.algorithmVersion}</span></td>
                  <td>Proposed, not applied</td>
                  <td>
                    <div className="autocal-row-actions">
                      <button type="button" className="settings-secondary-button" onClick={() => setOpenStoredRunId(openStoredRunId === stored.runId ? null : stored.runId)} aria-expanded={openStoredRunId === stored.runId}>
                        {openStoredRunId === stored.runId ? "Hide" : "View"}
                      </button>
                      <button type="button" className="settings-secondary-button" onClick={() => replay(stored)}>Replay</button>
                      <button type="button" className="settings-secondary-button" onClick={() => removeStoredRun(stored.runId)} aria-label={`Delete saved proposal ${stored.runId}`}>
                        <Trash2 size={14} aria-hidden="true" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {openStoredRun ? (
        <>
          <div className="settings-section-heading">
            <h3>{openStoredRun.topologyVersion} · saved {formatWallClock(openStoredRun.endedAt)}</h3>
            <p>Simulated. Proposed, not applied.</p>
          </div>
          <div className="settings-table-wrap is-scrollable">
            <table className="settings-table autocal-table">
              <thead>
                <tr>
                  <th scope="col">Valve</th>
                  <th scope="col">Proposed sensor</th>
                  <th scope="col">Confidence</th>
                  <th scope="col">Status</th>
                  <th scope="col">Response</th>
                  <th scope="col">Last verified</th>
                </tr>
              </thead>
              <tbody>
                {openStoredRun.proposals.map((pair) => (
                  <tr key={pair.valveId}>
                    <td><code className="settings-identity">{pair.valveId}</code></td>
                    <td><code className="settings-identity">{pair.sensorId}</code><span className="autocal-subtle">{pair.potLabel}</span></td>
                    <td><ConfidenceMeter value={pair.confidence} /></td>
                    <td>
                      <StatusChip tone={pair.status === "proposed" ? "ok" : "warning"}>{pair.status === "proposed" ? "Proposed" : "Needs review"}</StatusChip>
                      {pair.faults.length ? <span className="autocal-subtle">{pair.faults.map((code) => faultLabels[code]).join(", ")}</span> : null}
                    </td>
                    <td>+{pair.evidence.deltaVwc.toFixed(1)}% VWC from {pair.evidence.pulseSeconds}s</td>
                    <td>{pair.lastVerifiedAt ? "During the simulated run" : <span className="settings-empty-value">Not sampled</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </>
  );

  const tabs: Array<{ id: Tab; label: string; icon: typeof Play }> = [
    { id: "overview", label: "Overview", icon: FlaskConical },
    { id: "simulation", label: "Simulation", icon: Play },
    { id: "history", label: `History${storedRuns.length ? ` (${storedRuns.length})` : ""}`, icon: History },
  ];

  return (
    <div className="autocal">
      <SimulationBadge />
      <nav className="autocal-tabs" aria-label="Autocalibrate views">
        {tabs.map((item) => {
          const Icon = item.icon;
          return (
            <button key={item.id} type="button" className={tab === item.id ? "is-active" : ""} aria-current={tab === item.id ? "page" : undefined} onClick={() => setTab(item.id)}>
              <Icon size={14} aria-hidden="true" />
              {item.label}
            </button>
          );
        })}
      </nav>
      <p className="settings-visually-hidden" role="status">{announcement}</p>
      {tab === "overview" ? overview : null}
      {tab === "simulation" ? (stage === "setup" ? setup : stage === "running" ? running : review) : null}
      {tab === "history" ? history : null}
    </div>
  );
}
