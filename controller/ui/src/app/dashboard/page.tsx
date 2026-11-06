"use client";

import {
  useState,
  useMemo,
  useEffect,
  useRef,
  type CSSProperties,
} from "react";
import { useConnectedDevices } from "../swr/useConnectedDevices";
import { useSensorReadings } from "../swr/useSensorReadings";
import {
  Line,
  LineChart,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import {
  FolderArrowDownIcon as FileDown,
  ChartBarIcon as ChartIcon,
  AdjustmentsHorizontalIcon,
  PencilSquareIcon,
  LockClosedIcon,
  FunnelIcon,
  CogIcon,
  ChartBarSquareIcon,
  UserCircleIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
} from "@heroicons/react/24/outline";
import { Reading } from "../lib/types";
import { useGroupModal } from "../lib/GroupModal";
import { usePairingsModal } from "../lib/PairingsModal";
import { useMultiEditPairingsModal } from "../lib/MultiEditPairingsModal";
import { useCSVExportModal } from "../lib/CSVExportModalContext";
import { downloadChartAsImage, getSensorColor } from "../lib/chartUtils";
import RangeSlider from "../RangeSlider";
import { LogSection } from "../LogSection";
import { usePairings } from "../swr/usePairings";
import { useGroups } from "../swr/useGroups";
import { useSystem } from "../swr/useLockedStatus";
import ProtectedLayout from "../ProtectedLayout";
import { LogoutButton } from "../NavButtons";
import Link from "next/link";
import { SpinningLoader } from "../lib/SpinningLoader";
import { useCalibrations } from "../swr/useCalibrations";

type ReadingMetricKey =
  | "calibratedValue"
  | "rawValue"
  | "temperature"
  | "electricalConductivity";

const READING_METRIC_OPTIONS: Record<
  ReadingMetricKey,
  { label: string; yAxisLabel: string }
> = {
  calibratedValue: {
    label: "Calibrated Value",
    yAxisLabel: "Volumetric Water Content (VWC)",
  },
  rawValue: {
    label: "Raw Value",
    yAxisLabel: "Raw Sensor Value",
  },
  temperature: {
    label: "Temperature",
    yAxisLabel: "Temperature",
  },
  electricalConductivity: {
    label: "Electrical Conductivity",
    yAxisLabel: "Electrical Conductivity",
  },
};

/**
 * Transform sensor readings into a Recharts-friendly array of objects.
 * Returns an array of objects with a "timestamp" property plus any sensor IDs as keys and metric values as values.
 * ex: [
 *  {
 *    timestamp: '2025-05-18T12:00:00.000Z',
 *    'sensorId1': 0.5,
 *    'sensorId2': 0.6,
 *    ...
 *  },
 *  ...
 * ]
 */
function transformReadingsToChartData(
  sensorReadings: Reading[],
  metricKey: ReadingMetricKey,
): Array<Record<string, number | string | null>> {
  if (!Array.isArray(sensorReadings)) return [];

  // Group readings by timestamp, then build objects that combine multiple sensor values at the same timestamp.
  const groupedByTime: {
    [key: number]: Record<string, number | string | null>;
  } = {};

  sensorReadings.forEach((reading) => {
    const { sensorId, createdAt } = reading;
    const metricValue = reading[metricKey];
    const timestampNumber: number = new Date(createdAt).getTime() / 1000;

    // if we don't have an object for that instance of time yet, create one
    if (!groupedByTime[timestampNumber]) {
      groupedByTime[timestampNumber] = { timestamp: createdAt };
    }
    // add the {...sensorId: value} key/pair to the object for that instance of time
    groupedByTime[timestampNumber][sensorId] =
      typeof metricValue === "number" ? metricValue : null;
  });

  // Convert the grouped objects into an array, sorted by timestamp so the chart is chronological
  return Object.values(groupedByTime).sort((a, b) => {
    // Sort numerically by timestamp
    return (
      new Date(a.timestamp as string).getTime() -
      new Date(b.timestamp as string).getTime()
    );
  });
}

function toCapitalized(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

// Helper functions for timezone handling
function toLocalDateTimeString(utcTime: number): string {
  const date = new Date(utcTime);
  // Convert to local time and format for datetime-local input
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}`;
}

function fromLocalDateTimeString(localDateTimeString: string): number {
  // Parse as local time and convert to UTC timestamp
  return new Date(localDateTimeString).getTime();
}

function getCurrentLocalDateTimeString(): string {
  // Get current time in local timezone and format for datetime-local input
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const hours = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");
  const seconds = String(now.getSeconds()).padStart(2, "0");
  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}`;
}

function SensorDashboardContent() {
  const { isLoading: connectedDevicesLoading } = useConnectedDevices();
  const { pairings } = usePairings() ?? {};
  const { groups } = useGroups();
  const { calibrations } = useCalibrations();
  const { showGroupModal } = useGroupModal();
  const { showPairingsModal } = usePairingsModal();
  const { lockedStatus } = useSystem();
  const { showMultiEditPairingsModal } = useMultiEditPairingsModal();
  const { showCSVExportModal } = useCSVExportModal();

  // Create a ref for the chart container
  const chartContainerRef = useRef<HTMLDivElement>(null);

  // State for UI controls
  const [selectedPairings, setSelectedPairings] = useState<{
    [key: string]: boolean;
  }>({});
  const [displayFilter, setDisplayFilter] = useState<number | null>(null);
  const [isExportOpen, setIsExportOpen] = useState(false);
  const [isDisplayOpen, setIsDisplayOpen] = useState(false);
  const [isUserMenuOpen, setIsUserMenuOpen] = useState(false);
  const displayDropdownRef = useRef<HTMLDivElement>(null);
  const displayButtonRef = useRef<HTMLButtonElement>(null);
  const displayMenuRef = useRef<HTMLDivElement>(null);
  const [displayMenuStyle, setDisplayMenuStyle] =
    useState<CSSProperties | null>(null);
  const [selectedReadingMetric, setSelectedReadingMetric] =
    useState<ReadingMetricKey>("calibratedValue");

  // Pagination state
  const [currentPage, setCurrentPage] = useState(1);
  const pageSize = 5000; // Keeps the live graph responsive while still covering recent history.

  // Get selected sensor IDs for readings query
  const selectedSensorIds = useMemo(() => {
    return Object.keys(selectedPairings)
      .filter((key) => selectedPairings[key])
      .map((key) => {
        const [sensorId] = key.split("-+-").map(Number);
        return sensorId;
      });
  }, [selectedPairings]);

  // State for time range slider and manual input
  const [sliderSelectedTimeRange, setSliderSelectedTimeRange] = useState<
    [number, number] | undefined
  >(undefined);
  const [minTimeInput, setMinTimeInput] = useState("");
  const [maxTimeInput, setMaxTimeInput] = useState("");

  // State for blacklist functionality
  const [blacklistTimestamp, setBlacklistTimestamp] = useState<number | null>(
    null,
  );

  // Convert local timezone inputs to UTC ISO strings for API calls
  const startDateUTC = useMemo(() => {
    return minTimeInput
      ? new Date(fromLocalDateTimeString(minTimeInput)).toISOString()
      : undefined;
  }, [minTimeInput]);

  const endDateUTC = useMemo(() => {
    return maxTimeInput
      ? new Date(fromLocalDateTimeString(maxTimeInput)).toISOString()
      : undefined;
  }, [maxTimeInput]);

  // Fetch sensor readings with the selected sensors and pagination
  const {
    sensorReadings,
    paginationData,
    timeRange: apiTimeRange,
    isLoading: sensorReadingsLoading,
    setPage,
  } = useSensorReadings(
    currentPage,
    pageSize,
    selectedSensorIds.length > 0 ? selectedSensorIds : undefined,
    startDateUTC, // startDate
    endDateUTC, // endDate
  ) ?? {};

  // Process chart data with blacklist filtering
  const allChartData = useMemo(() => {
    if (!sensorReadings) return [];

    const transformedData = transformReadingsToChartData(
      sensorReadings,
      selectedReadingMetric,
    );

    // Filter out data before blacklist timestamp if blacklist is active
    if (blacklistTimestamp) {
      return transformedData.filter((dataPoint) => {
        const dataTime = new Date(dataPoint.timestamp as string).getTime();
        return dataTime >= blacklistTimestamp;
      });
    }

    return transformedData;
  }, [sensorReadings, blacklistTimestamp, selectedReadingMetric]);

  // Calculate full data time range (min and max timestamps from all data)
  const dataTimeRange = useMemo(() => {
    // If we have the time range from the API, use it
    if (apiTimeRange?.oldest && apiTimeRange?.newest) {
      return [
        new Date(apiTimeRange.oldest).getTime(),
        new Date(apiTimeRange.newest).getTime(),
      ] as [number, number];
    }

    // Otherwise, fall back to the data we have
    if (!allChartData || allChartData.length === 0) {
      return [0, 1] as [number, number];
    }

    const timestamps = allChartData.map((d) =>
      new Date(d.timestamp as string).getTime(),
    );

    return [Math.min(...timestamps), Math.max(...timestamps)] as [
      number,
      number,
    ];
  }, [allChartData, apiTimeRange]);

  // Get group names for display
  const groupNames: Map<number, string> = useMemo(() => {
    return new Map<number, string>(
      groups?.map((group) => [
        group.id,
        `${toCapitalized(group.type)} ${group.name}`,
      ]) || [],
    );
  }, [groups]);

  const uniqueGroups = useMemo(() => {
    if (!groups) return [];
    return Array.from(new Map(groups.map((g) => [g.id, g])).values());
  }, [groups]);

  // Initial pairing selections
  const initialSelections = useMemo(() => {
    return {};
  }, []);

  // Filter pairings based on selected group
  const filteredPairings = useMemo(() => {
    if (!pairings) return [];
    if (!displayFilter) return pairings;
    return pairings.filter((pairing) => pairing.groupId === displayFilter);
  }, [pairings, displayFilter]);

  // Reset selected pairings if the group filter or the mega list of pairings changes
  // (This is in a useEffect instead of the above useMemo because of React best practices -TJR)
  useEffect(() => {
    setSelectedPairings({});
  }, [pairings, displayFilter]);

  // Check if all filtered pairings are selected
  const allFilteredAreSelected = useMemo(() => {
    if (!filteredPairings || filteredPairings.length === 0) return false;
    return (
      Object.values(selectedPairings).length === filteredPairings.length &&
      Object.values(selectedPairings).every(Boolean)
    );
  }, [selectedPairings, filteredPairings]);

  // Count selected pairings
  const selectedPairingsCount = useMemo(() => {
    return Object.values(selectedPairings).filter(Boolean).length;
  }, [selectedPairings]);

  // Set initial selections when available
  useEffect(() => {
    if (Object.keys(initialSelections).length > 0) {
      setSelectedPairings(initialSelections);
    }
  }, [initialSelections]);

  useEffect(() => {
    if (!isDisplayOpen) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (!displayDropdownRef.current) return;
      if (displayDropdownRef.current.contains(event.target as Node)) return;
      setIsDisplayOpen(false);
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isDisplayOpen]);

  useEffect(() => {
    if (!isDisplayOpen) return;

    const updateMenuPosition = () => {
      const buttonEl = displayButtonRef.current;
      const menuEl = displayMenuRef.current;
      if (!buttonEl || !menuEl) return;

      const buttonRect = buttonEl.getBoundingClientRect();
      const viewportHeight = window.innerHeight;
      const viewportPadding = 8;
      const gap = 6;
      const availableBelow =
        viewportHeight - buttonRect.bottom - viewportPadding;
      const availableAbove = buttonRect.top - viewportPadding;
      const shouldOpenUp = availableAbove > availableBelow;
      const maxHeight = Math.max(
        160,
        (shouldOpenUp ? availableAbove : availableBelow) - gap,
      );

      setDisplayMenuStyle({
        top: shouldOpenUp ? "auto" : `calc(100% + ${gap}px)`,
        bottom: shouldOpenUp ? `calc(100% + ${gap}px)` : "auto",
        maxHeight,
      });
    };

    updateMenuPosition();
    window.addEventListener("resize", updateMenuPosition);
    window.addEventListener("scroll", updateMenuPosition, true);

    return () => {
      window.removeEventListener("resize", updateMenuPosition);
      window.removeEventListener("scroll", updateMenuPosition, true);
    };
  }, [isDisplayOpen]);

  // Handle time range slider change
  const handleTimeRangeChange = (newRange: [number, number]) => {
    setSliderSelectedTimeRange(newRange);

    // Update input fields using local timezone
    setMinTimeInput(toLocalDateTimeString(newRange[0]));
    setMaxTimeInput(toLocalDateTimeString(newRange[1]));
  };

  // Handle manual input changes that also update the slider
  const handleManualTimeInputChange = (field: "min" | "max", value: string) => {
    if (field === "min") {
      setMinTimeInput(value);
    } else {
      setMaxTimeInput(value);
    }

    // Update slider and labels when both inputs have valid values
    const minTime =
      field === "min"
        ? fromLocalDateTimeString(value)
        : fromLocalDateTimeString(minTimeInput);
    const maxTime =
      field === "max"
        ? fromLocalDateTimeString(value)
        : fromLocalDateTimeString(maxTimeInput);

    if (!isNaN(minTime) && !isNaN(maxTime)) {
      const newRange: [number, number] = [minTime, maxTime];
      setSliderSelectedTimeRange(newRange);
    }
  };

  // Handle setting end time to current time
  const handleSetEndToNow = () => {
    const nowString = getCurrentLocalDateTimeString();
    setMaxTimeInput(nowString);

    // Update slider if we have both start and end times
    if (minTimeInput) {
      const minTime = fromLocalDateTimeString(minTimeInput);
      const maxTime = fromLocalDateTimeString(nowString);
      if (!isNaN(minTime) && !isNaN(maxTime)) {
        const newRange: [number, number] = [minTime, maxTime];
        setSliderSelectedTimeRange(newRange);
      }
    }
  };

  // Handle clearing data before current time (blacklist)
  const handleClear = () => {
    const now = Date.now();
    setBlacklistTimestamp(now);
  };

  // Handle undoing the blacklist
  const handleUndoClear = () => {
    setBlacklistTimestamp(null);
  };

  // Handle pairing selection
  const handlePairingSelect = (pairingKey: string) => {
    setSelectedPairings((prev) => ({
      ...prev,
      [pairingKey]: !prev[pairingKey],
    }));

    // Reset to first page when selection changes
    setCurrentPage(1);
    setPage(1);
  };

  // Get the keys of selected pairings
  const getSelectedPairingKeys = (): {
    sensorId: number;
    valveId: number;
  }[] => {
    return Object.keys(selectedPairings)
      .filter((key) => selectedPairings[key])
      .map((key) => {
        const [sensorId, valveId] = key.split("-+-").map(Number);
        return { sensorId, valveId };
      });
  };

  // Pagination controls
  const handlePreviousPage = () => {
    if (currentPage > 1) {
      const newPage = currentPage - 1;
      setCurrentPage(newPage);
      setPage(newPage);
    }
  };

  const handleNextPage = () => {
    if (paginationData && currentPage < paginationData.totalPages) {
      const newPage = currentPage + 1;
      setCurrentPage(newPage);
      setPage(newPage);
    }
  };

  if (connectedDevicesLoading) {
    return (
      <div className="container mx-auto p-6">
        <p>Loading data...</p>
      </div>
    );
  }

  return (
      <div className="container mx-auto p-6 space-y-6">
        {/* Dashboard Header */}
        <div className="flex flex-row justify-between items-center mb-4">
          <h1 className="text-2xl font-bold">Dashboard</h1>
          <div className="flex gap-2">
            <Link
              href="/system-config"
              className="flex items-center gap-1 px-3 py-2 text-sm border rounded-md bg-white hover:bg-gray-50"
            >
              <CogIcon className="h-5 w-5" />
              System Config
            </Link>
            <Link
              href="/calibrations"
              className="flex items-center gap-1 px-3 py-2 text-sm border rounded-md bg-white hover:bg-gray-50"
            >
              <ChartBarSquareIcon className="h-5 w-5" />
              Calibrations
            </Link>
            <div className="relative">
              <button
                onClick={() => setIsUserMenuOpen(!isUserMenuOpen)}
                className="flex items-center justify-center w-10 h-10 rounded-md border bg-white hover:bg-gray-50"
              >
                <UserCircleIcon className="h-6 w-6" />
              </button>
              {isUserMenuOpen && (
                <div className="absolute right-0 z-10 bg-white border rounded-md shadow-lg">
                  <div
                    className="p-2 mx-2 flex items-center justify-center"
                    onClick={() => {
                      setIsUserMenuOpen(false);
                    }}
                  >
                    <LogoutButton />
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Main content area with table and chart in single column */}
        <div className="space-y-6">
          {/* Table Panel */}
          <div className="bg-white rounded-lg border shadow-sm">
            <div className="p-6 flex flex-row items-center justify-between border-b">
              {/* Custom Select for Export */}
              <div className="relative">
                <button
                  onClick={() => setIsExportOpen(!isExportOpen)}
                  className={`flex items-center justify-between w-[120px] px-3 py-2 text-sm border rounded-md bg-white ${selectedPairingsCount === 0 ? "cursor-default opacity-50" : "cursor-pointer"}`}
                  disabled={selectedPairingsCount === 0}
                >
                  <span className="flex items-center">
                    <FileDown className="mr-2 h-4 w-4" />
                    Export
                  </span>
                </button>
                {isExportOpen && (
                  <div className="absolute z-10 w-[120px] mt-1 bg-white border rounded-md shadow-lg">
                    <div
                      className="px-3 py-2 hover:bg-gray-100 cursor-pointer flex items-center"
                      onClick={() => {
                        if (selectedPairingsCount === 0) {
                          // If no pairings are selected, do nothing
                        } else {
                          const selectedPairingKeys = getSelectedPairingKeys();
                          showCSVExportModal({
                            pairingKeys: selectedPairingKeys,
                            currentTimeRange:
                              sliderSelectedTimeRange ?? dataTimeRange,
                          });
                          setIsExportOpen(false);
                        }
                      }}
                    >
                      <FileDown className="mr-2 h-4 w-4" />
                      CSV (gzipped)
                    </div>
                    <div
                      className="px-3 py-2 hover:bg-gray-100 cursor-pointer flex items-center"
                      onClick={() => {
                        // Get selected sensor IDs from the selectedPairings
                        const selectedSensorIds = Object.keys(
                          selectedPairings || {},
                        )
                          .filter((key) => selectedPairings[key])
                          .map((key) => {
                            const [sensorId] = key.split("-+-").map(Number);
                            return sensorId;
                          });

                        // Export chart as image with legend
                        downloadChartAsImage(
                          chartContainerRef.current,
                          "sensor-readings-chart",
                          selectedSensorIds,
                          new Map(
                            pairings?.map((pairing) => [
                              pairing.sensorId,
                              pairing.name,
                            ]),
                          ),
                        );
                        setIsExportOpen(false);
                      }}
                    >
                      <ChartIcon className="mr-2 h-4 w-4" />
                      Graph
                    </div>
                  </div>
                )}
              </div>

              {/* Custom Group Select for Display */}
              <div
                className="relative flex flex-row items-center"
                ref={displayDropdownRef}
              >
                <button
                  ref={displayButtonRef}
                  onClick={() => setIsDisplayOpen(!isDisplayOpen)}
                  className="flex items-center justify-center gap-1 w-fit px-3 py-2 text-sm border rounded-md bg-white"
                >
                  <FunnelIcon className="h-4 w-4" />
                  {displayFilter
                    ? groupNames.get(displayFilter)
                    : "All Pairings"}
                </button>
                {isDisplayOpen && (
                  <div
                    ref={displayMenuRef}
                    style={displayMenuStyle ?? undefined}
                    className="absolute right-0 z-10 w-[240px] overflow-y-auto bg-white border rounded-md shadow-lg"
                  >
                    <div
                      key={"All Pairings"}
                      className="px-3 py-2 hover:bg-gray-100 cursor-pointer"
                      onClick={() => {
                        setDisplayFilter(null);
                        setIsDisplayOpen(false);
                      }}
                    >
                      All Pairings
                    </div>
                    {uniqueGroups.map((group) => (
                      <div
                        key={group.id}
                        className="px-3 py-2 hover:bg-gray-100 cursor-pointer"
                        onClick={() => {
                          setDisplayFilter(group.id);
                          setIsDisplayOpen(false);
                        }}
                      >
                        {groupNames.get(group.id)}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Table Section */}
            <div className="p-4">
              <div className="rounded-md border overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="w-12 px-4 py-3 text-left text-sm font-medium text-gray-500">
                        <input
                          type="checkbox"
                          checked={allFilteredAreSelected}
                          onChange={() => {
                            if (allFilteredAreSelected) {
                              setSelectedPairings({});
                            } else {
                              setSelectedPairings(
                                filteredPairings?.reduce(
                                  (acc, pairing) => {
                                    acc[
                                      `${pairing.sensorId}-+-${pairing.valveId}`
                                    ] = true;
                                    return acc;
                                  },
                                  {} as { [key: string]: boolean },
                                ),
                              );
                            }
                          }}
                          className="h-4 w-4 rounded border-gray-300"
                        />
                      </th>
                      <th className="px-4 py-3 text-left text-sm font-medium text-gray-500">
                        Name
                      </th>
                      <th className="px-4 py-3 text-left text-sm font-medium text-gray-500">
                        Sensor
                      </th>
                      <th className="px-4 py-3 text-left text-sm font-medium text-gray-500">
                        Valve
                      </th>
                      <th className="px-4 py-3 text-left text-sm font-medium text-gray-500">
                        Group
                      </th>
                      <th className="px-4 py-3 text-left text-sm font-medium text-gray-500">
                        Calibration
                      </th>
                      <th className="px-4 py-3 text-left text-sm font-medium text-gray-500">
                        VWC%
                      </th>
                      <th className="px-4 py-3 text-left text-sm font-medium text-gray-500">
                        Open Time (seconds)
                      </th>
                      <th className="px-4 py-3 text-left text-sm font-medium text-gray-500">
                        Measurement Interval (seconds)
                      </th>
                      <th className="w-12 px-4 py-3 text-left text-sm font-medium text-gray-500"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredPairings?.map((pairing) => (
                      <tr
                        key={`${pairing.sensorId}-${pairing.valveId}`}
                        className="border-t"
                      >
                        <td className="px-4 py-3">
                          <input
                            type="checkbox"
                            checked={
                              selectedPairings[
                                `${pairing.sensorId}-+-${pairing.valveId}`
                              ] ?? false
                            }
                            onChange={() =>
                              handlePairingSelect(
                                `${pairing.sensorId}-+-${pairing.valveId}`,
                              )
                            }
                            className="h-4 w-4 rounded border-gray-300"
                          />
                        </td>
                        <td className="px-4 py-3">{pairing.name}</td>
                        <td className="px-4 py-3">
                          {pairing.sensorId}) {pairing?.Sensor?.boardSerialId}:
                          {pairing?.Sensor?.address}
                        </td>
                        <td className="px-4 py-3">
                          {pairing.valveId}) {pairing?.Valve?.relayAddress}:
                          {pairing?.Valve?.address}
                        </td>
                        <td className="px-4 py-3">
                          {groupNames.get(pairing.groupId ?? 0)}
                        </td>
                        <td className="px-4 py-3">
                          {pairing.calibrationId
                            ? (calibrations?.find(
                                (c) => c.id === pairing?.calibrationId,
                              )?.name ?? "")
                            : ""}
                        </td>
                        <td className="px-4 py-3">{pairing.WTCPercentLimit}</td>
                        <td className="px-4 py-3">
                          {(pairing.ValveOpenTime ?? 0) / 1000}
                        </td>
                        <td className="px-4 py-3">
                          {(pairing.MeasurementInterval ?? 0) / 1000}
                        </td>
                        <td className="px-4 py-3">
                          <button
                            onClick={() => {
                              if (lockedStatus) return;
                              showPairingsModal({
                                existingPairing: pairing,
                              });
                            }}
                            className={`px-2 py-2 rounded-md  ${lockedStatus ? "cursor-not-allowed opacity-50" : "hover:bg-gray-50 border"}`}
                          >
                            {lockedStatus ? (
                              <LockClosedIcon className="h-4 w-4" />
                            ) : (
                              <AdjustmentsHorizontalIcon className="h-4 w-4" />
                            )}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex justify-between mt-4">
                {/* Multi-Edit Button  */}
                <div className=" w-48">
                  <button
                    onClick={() => {
                      showMultiEditPairingsModal({
                        pairingKeys: getSelectedPairingKeys(),
                        onSave: (updatedCount) => {
                          console.log(
                            `Successfully updated ${updatedCount} pairings`,
                          );
                        },
                      });
                    }}
                    disabled={selectedPairingsCount === 0}
                    className={`px-4 py-2 border rounded-md flex items-center space-x-1 ${
                      selectedPairingsCount === 0
                        ? "bg-gray-100 text-gray-400 cursor-not-allowed"
                        : "hover:bg-gray-50"
                    }`}
                  >
                    <PencilSquareIcon className="h-4 w-4" />
                    <span>
                      Multi-Edit{" "}
                      {selectedPairingsCount > 0
                        ? `${selectedPairingsCount} Pairs`
                        : ""}
                    </span>
                  </button>
                </div>

                {/* Create Group */}
                <div className="w-48 flex flex-row justify-center ">
                  <button
                    onClick={() => {
                      showGroupModal({});
                    }}
                    className="px-4 py-2 border rounded-md hover:bg-gray-50"
                  >
                    Create Group
                  </button>
                </div>

                {/* Create Pairing */}
                <div className="w-48 flex flex-row justify-end ">
                  <button
                    onClick={() => {
                      showPairingsModal({});
                    }}
                    className={`px-4 py-2 border rounded-md hover:bg-gray-50 flex flex-row items-center gap-2 ${lockedStatus ? "cursor-not-allowed opacity-50" : ""}`}
                    disabled={lockedStatus}
                  >
                    {lockedStatus ? (
                      <LockClosedIcon className="h-4 w-4" />
                    ) : null}
                    Create Pairing
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* Chart Panel */}
          <div className="bg-white rounded-lg border shadow-sm">
            <div className="p-6 border-b flex items-center justify-between gap-4">
              <h3 className="text-lg font-semibold">
                Sensor Readings Over Time
              </h3>
              <div className="flex items-center gap-2">
                <label
                  htmlFor="reading-metric-select"
                  className="text-sm text-gray-700"
                >
                  Metric
                </label>
                <select
                  id="reading-metric-select"
                  value={selectedReadingMetric}
                  onChange={(e) =>
                    setSelectedReadingMetric(e.target.value as ReadingMetricKey)
                  }
                  className="px-3 py-2 text-sm border rounded-md bg-white"
                >
                  {Object.entries(READING_METRIC_OPTIONS).map(
                    ([metricKey, metricConfig]) => (
                      <option key={metricKey} value={metricKey}>
                        {metricConfig.label}
                      </option>
                    ),
                  )}
                </select>
              </div>
            </div>
            <div className="p-6">
              {/* Empty state when no sensors are selected */}
              {selectedSensorIds.length === 0 ? (
                <div className="h-[458px] flex items-center justify-center">
                  <div className="text-center text-gray-500">
                    <p className="mb-2">No sensors selected</p>
                    <p className="text-sm">
                      Select one or more sensors from the table to view readings
                    </p>
                  </div>
                </div>
              ) : sensorReadingsLoading ? (
                <div className="h-[458px] flex items-center justify-center">
                  <div className="text-center text-gray-500">
                    <SpinningLoader svgClassName="w-10 h-10 text-gray-500" />
                  </div>
                </div>
              ) : allChartData.length === 0 ? (
                <div className="h-[458px] flex items-center justify-center">
                  <div className="text-center text-gray-500">
                    <p className="mb-2">
                      No data available for the selected time range
                    </p>
                  </div>
                </div>
              ) : (
                <>
                  {/* Chart container */}
                  <div className="h-[400px]" ref={chartContainerRef}>
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={allChartData}>
                        <CartesianGrid strokeDasharray="3 3" />
                        <XAxis
                          dataKey="timestamp"
                          label={{
                            value: "Date/Time HH:MM:SS",
                            position: "top",
                          }}
                          tickFormatter={(value) => {
                            const date = new Date(value);
                            return date.toLocaleString("en-US", {
                              hour: "2-digit",
                              minute: "2-digit",
                              second: "2-digit",
                              hour12: false,
                            });
                          }}
                        />
                        <YAxis
                          label={{
                            value:
                              READING_METRIC_OPTIONS[selectedReadingMetric]
                                .yAxisLabel,
                            angle: -90,
                            position: "insideBottomLeft",
                            offset: 12,
                          }}
                        />
                        <Tooltip
                          formatter={(value) => {
                            if (Array.isArray(value)) {
                              return value.map((item) =>
                                typeof item === "number"
                                  ? Number.isInteger(item)
                                    ? item
                                    : Number(item.toFixed(3))
                                  : item,
                              );
                            }
                            if (typeof value === "number") {
                              return Number.isInteger(value)
                                ? value
                                : Number(value.toFixed(3));
                            }
                            return value;
                          }}
                        />
                        <Legend />
                        {Object.keys(selectedPairings || {}).map(
                          (pairingKey, index) => {
                            if (selectedPairings?.[pairingKey]) {
                              const pairing = pairings?.find(
                                (p) =>
                                  `${p.sensorId}-+-${p.valveId}` === pairingKey,
                              );
                              return (
                                <Line
                                  key={pairingKey}
                                  type="monotone"
                                  dataKey={`${pairing?.sensorId}`}
                                  name={pairing?.name}
                                  legendType="square"
                                  stroke={getSensorColor(index)}
                                  activeDot={{ r: 8 }}
                                  isAnimationActive={false}
                                  connectNulls={true}
                                />
                              );
                            }
                            return null;
                          },
                        )}
                      </LineChart>
                    </ResponsiveContainer>
                  </div>

                  {/* Pagination controls */}
                  {paginationData && (
                    <div className="mt-4 flex items-center justify-between">
                      <button
                        onClick={handleNextPage}
                        disabled={currentPage >= paginationData.totalPages}
                        aria-label="Next page"
                        className={`flex items-center px-3 py-2 border rounded-md ${
                          currentPage >= paginationData.totalPages
                            ? "text-gray-400 cursor-not-allowed"
                            : "hover:bg-gray-50"
                        }`}
                      >
                        <ArrowLeftIcon className="h-4 w-4 mr-1" />
                        Older
                      </button>
                      <div
                        className={`flex flex-col justify-center items-center`}
                      >
                        <p className="text-sm text-gray-500 ">
                          {currentPage === 1
                            ? `Showing up to ${pageSize.toLocaleString()} readings in selected range`
                            : `${((currentPage - 1) * pageSize + 1).toLocaleString()} - ${(currentPage * pageSize).toLocaleString()} most recent readings`}
                        </p>
                        <p className={`text-xs text-gray-500`}>
                          (Page {currentPage} of {paginationData.totalPages})
                        </p>
                      </div>
                      <button
                        onClick={handlePreviousPage}
                        disabled={currentPage <= 1}
                        aria-label="Previous page"
                        className={`flex items-center px-3 py-2 border rounded-md ${
                          currentPage <= 1
                            ? "text-gray-400 cursor-not-allowed"
                            : "hover:bg-gray-50"
                        }`}
                      >
                        Newer
                        <ArrowRightIcon className="h-4 w-4 ml-1" />
                      </button>
                    </div>
                  )}
                </>
              )}

              {/* Time Range Controls */}
              <div className="mt-6 pt-4 border-t border-gray-200">
                <div className="flex justify-between items-center mb-4">
                  <div className={`flex flex-row gap-3`}>
                    <button
                      onClick={handleClear}
                      className="text-sm text-blue-600 hover:text-blue-800"
                    >
                      Clear
                    </button>
                    {blacklistTimestamp && (
                      <button
                        onClick={handleUndoClear}
                        className="text-sm text-green-600 hover:text-green-800"
                      >
                        Undo Clear
                      </button>
                    )}
                  </div>
                  <div className={`flex flex-row items-center gap-1`}>
                    {minTimeInput === "" && maxTimeInput === "" && (
                      <div className="w-2 h-2 bg-red-500 rounded-full animate-pulse"></div>
                    )}
                    <button
                      disabled={minTimeInput === "" && maxTimeInput === ""}
                      onClick={() => {
                        setMinTimeInput("");
                        setMaxTimeInput("");
                        setSliderSelectedTimeRange(dataTimeRange);
                      }}
                      className="text-sm text-blue-600 hover:text-blue-800 disabled:opacity-50 disabled:text-red-500"
                    >
                      {minTimeInput === "" && maxTimeInput === ""
                        ? "LIVE"
                        : "Set to LIVE"}
                    </button>
                  </div>
                </div>

                {/* Manual datetime inputs */}
                <div className="mb-4">
                  <div className="flex space-x-2 w-full">
                    <div className="flex-1 flex flex-row gap-3">
                      <div className={`w-1/2`}>
                        <label className="block text-xs text-gray-600 mb-1">
                          Start Date/Time
                        </label>
                        <input
                          type="datetime-local"
                          value={minTimeInput}
                          onChange={(e) =>
                            handleManualTimeInputChange("min", e.target.value)
                          }
                          className="px-3 py-2 border rounded text-sm w-full"
                          step={1}
                        />
                      </div>
                    </div>
                    <div className="flex-1 flex flex-row justify-end gap-3 items-center">
                      <div className={`w-1/2`}>
                        <label className="block text-xs text-gray-600 mb-1">
                          End Date/Time
                        </label>
                        <input
                          type="datetime-local"
                          value={maxTimeInput}
                          onChange={(e) =>
                            handleManualTimeInputChange("max", e.target.value)
                          }
                          className="px-3 py-2 border rounded text-sm w-full"
                          step={1}
                        />
                      </div>
                      <button
                        onClick={handleSetEndToNow}
                        className="text-sm text-blue-600 hover:text-blue-800 mt-4"
                      >
                        Set to now
                      </button>
                    </div>
                  </div>
                </div>

                {/* Time range slider */}
                <RangeSlider
                  min={dataTimeRange[0]}
                  max={dataTimeRange[1]}
                  initialRange={sliderSelectedTimeRange}
                  onChange={handleTimeRangeChange}
                  label="Time Range Slider"
                />
              </div>
            </div>
          </div>
        </div>
        <LogSection />
      </div>
  );
}

export default function SensorDashboard() {
  return (
    <ProtectedLayout>
      <SensorDashboardContent />
    </ProtectedLayout>
  );
}
