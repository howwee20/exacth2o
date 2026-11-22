import { Search } from "lucide-react";
import { useMemo, useState } from "react";
import { measurementFreshness } from "../measurementFreshness";
import { usePageClock } from "../pageClock";
import { formatSettingsTimestamp } from "../portalFormat";
import { hardwarePots, relativeAgeText } from "../settingsPresentation";
import type { PairingRow, SensorReading } from "../types";

type Filter = "all" | "quiet" | "no-valve";

/** Every pot with the sensor and valve wired to it, and whether that sensor is reporting. */
export function HardwareTable({ pairings, readings }: { pairings: readonly PairingRow[]; readings: readonly SensorReading[] }) {
  const nowMs = usePageClock();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const pots = useMemo(() => hardwarePots(pairings, readings).map((pot) => {
    const tone = pot.lastReadingAt
      ? measurementFreshness({ measuredAt: pot.lastReadingAt, expectedIntervalMs: pot.intervalMs, nowMs }).tone
      : "unknown";
    return { ...pot, reporting: tone === "ok" };
  }), [nowMs, pairings, readings]);
  const quiet = pots.filter((pot) => !pot.reporting).length;
  const noValve = pots.filter((pot) => !pot.valve).length;
  const needle = query.trim().toLowerCase();
  const shown = pots.filter((pot) =>
    (filter === "all" || (filter === "quiet" ? !pot.reporting : !pot.valve))
    && (!needle || [String(pot.potNumber ?? ""), pot.name, pot.sensor ?? "", pot.valve ?? ""].some((text) => text.toLowerCase().includes(needle))));
  const filters = ([
    { id: "all", label: "All", count: pots.length },
    { id: "quiet", label: "Not reporting", count: quiet },
    { id: "no-valve", label: "No valve", count: noValve },
  ] satisfies { id: Filter; label: string; count: number }[]).filter((item) => item.id === "all" || item.count > 0 || item.id === filter);

  return (
    <section className="hw-table" aria-label="Sensors and valves">
      <div className="hw-toolbar">
        <h3>Sensors and valves</h3>
        <label className="hw-search">
          <Search size={14} aria-hidden="true" />
          <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find pot, sensor or valve" aria-label="Find pot, sensor or valve" />
        </label>
        {filters.length > 1 ? <div className="hw-filter" role="group" aria-label="Show">
          {filters.map((item) => (
            <button key={item.id} type="button" className={filter === item.id ? "is-selected" : ""} aria-pressed={filter === item.id} onClick={() => setFilter(item.id)}>
              {item.label} <span>{item.count}</span>
            </button>
          ))}
        </div> : null}
      </div>
      <div className="settings-table-wrap is-compact hw-wrap">
        <table className="settings-table">
          <thead>
            <tr>
              <th scope="col">Pot</th>
              <th scope="col">Sensor</th>
              <th scope="col">Valve</th>
              <th scope="col">Last reading</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((pot) => (
              <tr key={`${pot.name}:${pot.sensor}`}>
                <td><b className="hw-pot">{pot.potNumber ?? "—"}</b><span className="hw-name">{pot.name}</span></td>
                <td>{pot.sensor ? <code className="settings-identity">{pot.sensor}</code> : <span className="settings-empty-value">None</span>}</td>
                <td>{pot.valve ? <code className="settings-identity">{pot.valve}</code> : <span className="settings-empty-value">None</span>}</td>
                <td title={pot.lastReadingAt ? formatSettingsTimestamp(pot.lastReadingAt) : undefined}>
                  <span className={`hw-dot ${pot.reporting ? "is-ok" : pot.lastReadingAt ? "is-late" : ""}`} aria-hidden="true" />
                  {pot.lastReadingAt ? relativeAgeText(pot.lastReadingAt, nowMs) : <span className="settings-empty-value">No recent reading</span>}
                </td>
              </tr>
            ))}
            {shown.length === 0 ? <tr><td colSpan={4} className="hw-none">{pots.length ? "No pots match." : "No pots are paired yet."}</td></tr> : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}
