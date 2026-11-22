import { SensorCanvasChart } from "../charts/SensorCanvasChart";
import type { ChartSeries, ChartTargetLine, HealthWateringEvent, TimeBounds } from "../portalTypes";

export type SplitGraphPanel = { id: string; label: string; names: Set<string>; targetLines: ChartTargetLine[] };

/** The traces chart, once per group. Every graph shares the time range; each fits its own readings. */
export function SplitTraceGraphs({ panels, series, selectedName, onSelectSeries, loading, xDomain, wateringEvents, describeTarget, affectedNames }: {
  panels: readonly SplitGraphPanel[];
  series: ChartSeries[];
  selectedName: string | null;
  onSelectSeries: (name: string) => void;
  loading: boolean;
  xDomain: TimeBounds | null;
  wateringEvents?: HealthWateringEvent[];
  describeTarget: (series: ChartSeries) => string | null;
  affectedNames?: Set<string>;
}) {
  return (
    <div className="px-split-graphs">
      {panels.map((panel) => (
        <section className="px-split-graph" key={panel.id} aria-label={panel.label}>
          <header>
            <h3>{panel.label}</h3>
            <span>{panel.names.size} {panel.names.size === 1 ? "pot" : "pots"}</span>
          </header>
          <SensorCanvasChart
            series={series}
            visibleNames={panel.names}
            selectedName={selectedName}
            viewMode="traces"
            onSelectSeries={onSelectSeries}
            loading={loading}
            xDomain={xDomain}
            wateringEvents={wateringEvents}
            targetLines={panel.targetLines}
            describeTarget={describeTarget}
            affectedNames={affectedNames}
            minHeight={220}
          />
        </section>
      ))}
    </div>
  );
}
