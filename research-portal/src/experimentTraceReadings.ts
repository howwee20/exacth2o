import { readingsForExperiment, type PortalExperiment } from "./experimentRegistry";
import { isIgnoredDiagnosticReading } from "./portalData";
import { dedupeReadingsForExport } from "./readingsExport";
import type { SensorReading } from "./types";

/** Keep original readings across the full experiment; the rolling live cache has a separate limit. */
export function experimentTraceReadings(history: readonly SensorReading[], live: readonly SensorReading[], experiment: PortalExperiment) {
  return dedupeReadingsForExport(readingsForExperiment(
    [...history, ...live].filter((reading) => !isIgnoredDiagnosticReading(reading)), experiment,
  ));
}
