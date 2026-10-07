import { AlertTriangle, ArrowLeft, Maximize2, Minimize2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SensorCanvasChart } from "../charts/SensorCanvasChart";
import { TimeRangeControl } from "../charts/TimeRangeControl";
import { filterSeriesByTime } from "../charts/chartGeometry";
import { formatPercent, statsForSeries } from "../charts/chartSeries";
import { fullTimeWindow } from "../portalConstants";
import { type ChartPoint, type ChartSeries, type TimeBounds } from "../portalTypes";
import { colorForPotNumber } from "../potColors";
import { type SensorReading } from "../types";
import { isWalkerAccessDenied, toggleWalkerSensorSelection, type WalkerLiveSensor, type WalkerLiveSnapshot, walkerSensorsByBoard } from "../walkerObservation";
import { loadWalkerLiveSnapshot } from "../walkerObservationClient";

export const walkerLivePollMs = 60_000;

export function walkerChartSeries(snapshot: WalkerLiveSnapshot): ChartSeries[] {
  const boardZones = new Map(
    walkerSensorsByBoard(snapshot.sensors).map(([board], index) => [board, index + 1]),
  );
  const traceBySensor = new Map(
    snapshot.series.map((trace) => [trace.source_sensor_id, trace]),
  );

  return snapshot.sensors.map((sensor) => {
    const trace = traceBySensor.get(sensor.source_sensor_id);
    const potNumber = sensor.position_number ?? sensor.source_sensor_id;
    const points = (trace?.points ?? []).flatMap((point, index): ChartPoint[] => {
      const timestampMs = Date.parse(point.at);
      if (!Number.isFinite(timestampMs) || !Number.isFinite(point.average)) return [];
      const reading: SensorReading = {
        id: sensor.source_sensor_id * 1_000_000 + index,
        event_id: `walker-live-chart:${sensor.source_sensor_id}:${point.at}`,
        pairing_name: sensor.source_pairing_name,
        sensor_key: sensor.sensor_key,
        raw_value: point.average,
        calibrated_value: point.average,
        temperature: null,
        electrical_conductivity: null,
        device_recorded_at: point.at,
        server_received_at: point.at,
      };
      return [{ timestampMs, value: point.average, reading }];
    });
    return {
      name: `walker-sensor-${sensor.source_sensor_id}`,
      kind: "pot",
      zone: boardZones.get(sensor.board_serial_id) ?? 0,
      potNumber,
      treatment: "unknown",
      plantGroup: "unknown",
      color: colorForPotNumber(potNumber),
      points,
      rawPointCount: points.length,
    };
  });
}

export function WalkerExperimentView({ onBack }: { onBack: () => void }) {
  const [snapshot, setSnapshot] = useState<WalkerLiveSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedSensorIds, setSelectedSensorIds] = useState<Set<number>>(new Set());
  const [selectedSeriesName, setSelectedSeriesName] = useState<string | null>(null);
  const [timeWindow, setTimeWindow] = useState(fullTimeWindow);
  const [graphExpanded, setGraphExpanded] = useState(false);
  const initializedSelection = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const nextSnapshot = await loadWalkerLiveSnapshot();
      setSnapshot(nextSnapshot);
      setError(null);
      if (!initializedSelection.current) {
        setSelectedSensorIds(new Set(
          nextSnapshot.sensors.map((sensor) => sensor.source_sensor_id),
        ));
        initializedSelection.current = true;
      }
    } catch (nextError) {
      const accessDenied = isWalkerAccessDenied(
        nextError as { code?: string; message?: string },
      );
      setError(
        accessDenied
          ? "Walker system-administrator observation access is required."
          : "Walker live telemetry is temporarily unavailable.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), walkerLivePollMs);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const sensors = useMemo(() => snapshot?.sensors ?? [], [snapshot]);
  const allSensorIds = useMemo(
    () => sensors.map((sensor) => sensor.source_sensor_id),
    [sensors],
  );
  const series = useMemo(
    () => snapshot ? walkerChartSeries(snapshot) : [],
    [snapshot],
  );
  const seriesBySensor = useMemo(
    () => new Map(
      series.map((item) => [
        Number(item.name.replace("walker-sensor-", "")),
        item,
      ]),
    ),
    [series],
  );
  const sensorBySeriesName = useMemo(
    () => new Map(
      sensors.map((sensor) => [
        `walker-sensor-${sensor.source_sensor_id}`,
        sensor,
      ]),
    ),
    [sensors],
  );
  const visibleNames = useMemo(
    () => new Set(
      Array.from(selectedSensorIds, (sensorId) => `walker-sensor-${sensorId}`),
    ),
    [selectedSensorIds],
  );
  const timeBounds = useMemo<TimeBounds | null>(() => {
    if (!snapshot) return null;
    const startMs = Date.parse(snapshot.range_start);
    const endMs = Date.parse(snapshot.range_end);
    return Number.isFinite(startMs) && Number.isFinite(endMs)
      ? { startMs, endMs }
      : null;
  }, [snapshot]);
  const visibleSeries = useMemo(
    () => filterSeriesByTime(series, timeBounds, timeWindow),
    [series, timeBounds, timeWindow],
  );
  const boardGroups = useMemo(() => walkerSensorsByBoard(sensors), [sensors]);

  const toggleSensor = (sensorId: number) => {
    setSelectedSensorIds((current) =>
      toggleWalkerSensorSelection(current, sensorId, allSensorIds),
    );
    setSelectedSeriesName(`walker-sensor-${sensorId}`);
  };

  return (
    <main className="dashboard-shell experiment-shell walker-experiment-shell">
      <div className="experiment-corner-actions" aria-label="Experiment actions">
        <div className="header-actions">
          <button className="header-action" type="button" onClick={onBack}>
            <ArrowLeft size={14} />
            Home
          </button>
        </div>
      </div>

      {error ? (
        <div className="banner error">
          <AlertTriangle size={18} />
          {error}
          <button type="button" className="header-action" onClick={() => void refresh()}>
            Retry
          </button>
        </div>
      ) : null}

      <h1 className="experiment-view-title">Walker Pi 5</h1>

      <section className={`dashboard-main ${graphExpanded ? "is-expanded" : ""}`}>
        <section className="chart-card">
          <div className="chart-tools">
            <div className="chart-view-toggle" aria-label="Graph view">
              <button type="button" className="is-selected">VWC</button>
            </div>
            <button
              className="expand-button"
              type="button"
              aria-label={graphExpanded ? "Close expanded graph" : "Expand graph"}
              title={graphExpanded ? "Close" : "Expand"}
              onClick={() => setGraphExpanded((current) => !current)}
            >
              {graphExpanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
            </button>
          </div>
          <section className="chart-panel-main" aria-label="Walker VWC observation chart">
            <SensorCanvasChart
              series={visibleSeries}
              visibleNames={visibleNames}
              selectedName={selectedSeriesName}
              viewMode="traces"
              onSelectSeries={(name) => {
                const sensor = sensorBySeriesName.get(name);
                if (sensor) toggleSensor(sensor.source_sensor_id);
              }}
              loading={loading}
              xDomain={timeBounds}
            />
          </section>
          <div className="chart-bottom-controls">
            <TimeRangeControl
              bounds={timeBounds}
              value={timeWindow}
              onChange={setTimeWindow}
            />
          </div>
        </section>

        <aside className="control-panel" aria-label="Walker sensor selector">
          <section>
            <div className="preset-buttons research-presets">
              <button
                type="button"
                className={`preset-filter preset-all ${
                  selectedSensorIds.size === allSensorIds.length ? "is-selected" : ""
                }`}
                onClick={() => {
                  setSelectedSensorIds(new Set(allSensorIds));
                  setSelectedSeriesName(null);
                }}
              >
                All {snapshot?.evidenced_sensor_count ?? sensors.length}/100
              </button>
            </div>
          </section>
          {boardGroups.map(([board, boardSensors]) => {
            const allVisible = boardSensors.every((sensor) =>
              selectedSensorIds.has(sensor.source_sensor_id),
            );
            return (
              <section className="pot-group" key={board}>
                <div className="pot-group-head">
                  <h3>{board}</h3>
                  <button
                    type="button"
                    className={`group-toggle ${allVisible ? "is-on" : ""}`}
                    aria-label={`${allVisible ? "Hide" : "Show"} all sensors on ${board}`}
                    onClick={() => {
                      setSelectedSensorIds((current) => {
                        const next = new Set(current);
                        for (const sensor of boardSensors) {
                          if (allVisible) next.delete(sensor.source_sensor_id);
                          else next.add(sensor.source_sensor_id);
                        }
                        return next;
                      });
                      setSelectedSeriesName(null);
                    }}
                  >
                    <span />
                  </button>
                </div>
                <div>
                  {boardSensors.map((sensor: WalkerLiveSensor) => {
                    const chartItem = seriesBySensor.get(sensor.source_sensor_id);
                    const latestValue = statsForSeries(chartItem).latestValue;
                    const visible = selectedSensorIds.has(sensor.source_sensor_id);
                    const colorSeed = sensor.position_number ?? sensor.source_sensor_id;
                    return (
                      <button
                        key={sensor.source_sensor_id}
                        type="button"
                        className={`pot-toggle ${visible ? "is-on" : ""} ${
                          selectedSeriesName === chartItem?.name ? "is-selected-pot" : ""
                        }`}
                        onClick={() => toggleSensor(sensor.source_sensor_id)}
                        aria-label={`${sensor.display_label}, ${formatPercent(latestValue)}`}
                      >
                        <span
                          className="color-dot"
                          style={{ background: colorForPotNumber(colorSeed) }}
                        />
                        <span className="pot-reading">
                          <b>{sensor.display_label}</b>
                          <strong>{formatPercent(latestValue)}</strong>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </aside>
      </section>
    </main>
  );
}
