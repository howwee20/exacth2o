import { useEffect,useState } from "react";
import { type PortalExperiment } from "./experimentRegistry";
import { formatLoadedReadingsCsv,formatPairingsCsv } from "./portalCsv";
import { visibleExperimentPairings } from "./portalData";
import { errorMessage } from "./portalFormat";
import { type PortalRoute } from "./portalRoute";
import { type CsvDownload,type LoadState } from "./portalTypes";
import { dedupeReadingsForExport } from "./readingsExport";
import { type PairingRow,type SensorReading } from "./types";



/** PortalCsv owns this workspace behavior; App supplies the current scope. */
type Context = {
  route: PortalRoute;
  experimentReadings: SensorReading[];
  data: LoadState;
  pairingByName: Map<string, PairingRow>;
  selectedExperiment: PortalExperiment;
  sortedPairings: PairingRow[];
};

export function usePortalCsv({ route, experimentReadings, data, pairingByName, selectedExperiment, sortedPairings }: Context) {
  const [exportingCsv, setExportingCsv] = useState(false);

  const [csvDownload, setCsvDownload] = useState<CsvDownload | null>(null);

  const [csvError, setCsvError] = useState<string | null>(null);

  async function prepareCsvDownload() {
    setExportingCsv(true);
    setCsvDownload(null);
    setCsvError(null);

    try {
      const readings = dedupeReadingsForExport(route.view === "experiment" ? experimentReadings : data.readings);
      if (readings.length === 0) {
        throw new Error("Readings are still loading. Try again after the chart appears.");
      }
      const csv = formatLoadedReadingsCsv(readings, pairingByName, selectedExperiment);
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      setCsvDownload({
        url,
        filename: `exacth2o-${route.view === "experiment" ? selectedExperiment.id : "installation"}-readings-loaded-${new Date().toISOString().slice(0, 10)}.csv`,
        rowCount: readings.length,
      });
    } catch (err) {
      setCsvError(errorMessage(err));
    } finally {
      setExportingCsv(false);
    }
  }

  function downloadPairingsCsv() {
    const csv = formatPairingsCsv(route.view === "controller" ? visibleExperimentPairings(data.pairings) : sortedPairings, selectedExperiment);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `exacth2o-pairings-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  useEffect(() => {
    return () => {
      if (csvDownload) URL.revokeObjectURL(csvDownload.url);
    };
  }, [csvDownload]);

  return { exportingCsv, csvDownload, setCsvDownload, csvError, setCsvError, prepareCsvDownload, downloadPairingsCsv };
}
