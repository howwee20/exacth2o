import { AlertTriangle, ArrowLeft, Maximize2, Minimize2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SensorCanvasChart } from "../charts/SensorCanvasChart";
import { TimeRangeControl } from "../charts/TimeRangeControl";
import { filterSeriesByTime } from "../charts/chartGeometry";
import { describeVwcReading, formatVwcReading, latestPoint } from "../charts/chartSeries";
import { MeasurementStatusBar } from "../experiment/MeasurementStatus";
import { formatAge, formatDuration, formatMeasurementTime, measurementFreshness } from "../measurementFreshness";
import { prepareSeries } from "../seriesStatistics";
import { scheduleVisiblePolling } from "../visiblePolling";
import { fullTimeWindow } from "../portalConstants";
import { type ChartPoint, type ChartSeries, type TimeBounds } from "../portalTypes";
import { colorForPotNumber } from "../potColors";
import { type SensorReading } from "../types";
import { isWalkerAccessDenied, toggleWalkerSensorSelection, walkerFreshness, type WalkerLiveSensor, type WalkerLiveSnapshot, walkerSensorsByBoard } from "../walkerObservation";
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
    const prepared = prepareSeries(points);
    return {
      name: `walker-sensor-${sensor.source_sensor_id}`,
      kind: "pot",
      zone: boardZones.get(sensor.board_serial_id) ?? 0,
      potNumber,
      treatment: "unknown",
      plantGroup: "unknown",
      color: colorForPotNumber(potNumber),
      points: prepared.points,
      rawPointCount: prepared.points.length,
      // Each point is a server-side bucket average; the bucket is the expected spacing.
      expectedIntervalMs: snapshot.bucket_seconds > 0 ? snapshot.bucket_seconds * 1000 : null,
      invalidCount: prepared.invalidCount,
      duplicateCount: prepared.duplicateCount,
      conflictingDuplicateCount: prepared.conflictingDuplicateCount,
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
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const initializedSelection = useRef(false);
  const mountedRef = useRef(true);
  const requestRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    // Only the newest request may update the view; a late answer from an earlier one is dropped.
    const request = ++requestRef.current;
    try {
      const nextSnapshot = await loadWalkerLiveSnapshot();
      if (!mountedRef.current || request !== requestRef.current) return;
      setSnapshot(nextSnapshot);
      setError(null);
      setCheckedAt(new Date().toISOString());
      setNowMs(Date.now());
      if (!initializedSelection.current) {
        setSelectedSensorIds(new Set(
          nextSnapshot.sensors.map((sensor) => sensor.source_sensor_id),
        ));
        initializedSelection.current = true;
      }
    } catch (nextError) {
      if (!mountedRef.current || request !== requestRef.current) return;
      const accessDenied = isWalkerAccessDenied(
        nextError as { code?: string; message?: string },
      );
      setError(
        accessDenied
          ? "Walker system-administrator observation access is required."
          : "Walker live telemetry is temporarily unavailable.",
      );
    } finally {
      if (mountedRef.current && request === requestRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    // Paused while the tab is hidden; one refresh on return if a poll was missed.
    return scheduleVisiblePolling(refresh, walkerLivePollMs);
  }, [refresh]);

  const freshness = useMemo(
    () => snapshot ? walkerFreshness(snapshot, nowMs) : null,
    [nowMs, snapshot],
  );

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

  const toggleSensor = useCallback((sensorId: number) => {
    setSelectedSensorIds((current) =>
      toggleWalkerSensorSelection(current, sensorId, allSensorIds),
    );
    setSelectedSeriesName(`walker-sensor-${sensorId}`);
  }, [allSensorIds]);
  const selectSeries = useCallback((name: string) => {
    const sensor = sensorBySeriesName.get(name);
    if (sensor) toggleSensor(sensor.source_sensor_id);
  }, [sensorBySeriesName, toggleSensor]);

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
        <div className="banner error" role="alert">
          <AlertTriangle size={18} />
          {snapshot ? `${error} Showing the readings loaded earlier.` : error}
          <button type="button" className="header-action" onClick={() => void refresh()}>
            Retry
          </button>
        </div>
      ) : null}

      <h1 className="experiment-view-title">Walker Pi 5</h1>
      {snapshot && freshness ? (
        <MeasurementStatusBar
          freshness={freshness}
          checkedAt={checkedAt}
          refreshing={false}
          reportingPots={snapshot.current_sensor_count}
          totalPots={snapshot.expected_sensor_count}
          fetchError={error}
        />
      ) : null}
      {snapshot && snapshot.bucket_seconds > 0 ? (
        <p className="measurement-status-note">
          Sensing only. Each point is the average of the readings in a {formatDuration(snapshot.bucket_seconds * 1000)} interval.
        </p>
      ) : null}

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
              onSelectSeries={selectSeries}
              loading={loading && !snapshot}
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
                    const latestValue = latestPoint(chartItem)?.value ?? null;
                    const sensorFreshness = measurementFreshness({ measuredAt: sensor.latest_reading_at, nowMs });
                    const showAge = sensor.latest_reading_at != null && sensorFreshness.state !== "current";
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
                        aria-label={`${sensor.display_label}, ${describeVwcReading(latestValue)}, ${sensorFreshness.detail}`}
                        title={sensor.latest_reading_at ? `${formatMeasurementTime(sensor.latest_reading_at)} · ${sensorFreshness.detail}` : "No live reading"}
                      >
                        <span
                          className="color-dot"
                          style={{ background: colorForPotNumber(colorSeed) }}
                        />
                        <span className="pot-reading">
                          <b>{sensor.display_label}</b>
                          <strong>{formatVwcReading(latestValue)}</strong>
                          {showAge ? <span className="pot-age">{formatAge(sensorFreshness.ageMs)}</span> : null}
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
