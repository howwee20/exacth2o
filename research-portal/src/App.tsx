import { AlertTriangle, ArrowRight, Loader2, Mail, Maximize2, Minimize2, Server, ShieldCheck } from "lucide-react";
import { type CSSProperties, type FormEvent, type PointerEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChamberControlAdminTile, ChamberControlView, GasMixerResearcherHome, GasMixerResearcherTile, GasMixerResearcherView } from "./ChamberControlView";
import { WalkerAdminTile } from "./WalkerObservationView";
import { WebsiteAnalyticsTile } from "./WebsiteAnalyticsTile";
import exactH2OLogo from "./assets/exacth2o-logo.jpeg";
import { SoftwareTermsModal } from "./auth/SoftwareTermsModal";
import { expiredPortalSessionNotice, isSessionAuthorizationError } from "./authSession";
import { SensorCanvasChart } from "./charts/SensorCanvasChart";
import { TimeRangeControl } from "./charts/TimeRangeControl";
import { filterSeriesByTime, timeBoundsForSeries } from "./charts/chartGeometry";
import { chartSeries, compareGroup, describeVwcReading, formatVwcReading, latestPoint } from "./charts/chartSeries";
import { MeasurementStatusBar } from "./experiment/MeasurementStatus";
import { experimentFreshness, experimentIsCompleted, experimentProgressText, groupTarget, pairingTargetText, targetLinesForPairings, withReportingCoverage } from "./experimentMeasurement";
import { formatAge, formatMeasurementTime, measurementFreshness } from "./measurementFreshness";
import { controllerPresence } from "./settingsPresentation";
import { isCommandStatus, settingsBatchCommandType, type TrackedCommand, trackedCommandProgress } from "./commandLifecycle";
import { loadPortalExperimentCatalog } from "./experimentClient";
import { experimentGraphGroups } from "./experimentPresentation";
import { type ExperimentId, isCalibrationExperiment, isObservationOnlyExperiment, mergePortalExperiments, pairingBelongsToExperiment, type PortalExperiment, portalExperimentById, portalExperimentsForRole, readingsForExperiment, valveEventsForExperiment } from "./experimentRegistry";
import { HealthSelectedDetailDrawer } from "./health/HealthPanels";
import { hasExperimentSettingsAccess, hasProjectDataReadAccess, parsePortalRole } from "./portalAccess";
import { autoRefreshMs, defaultExpandedPanelSize, demoAccountEmail, demoHandoffKey, fullReconciliationEveryPolls, fullTimeWindow, healthSnapshotPollMs, healthSnapshotSelectColumns, incrementalCursorOverlapMs, incrementalValveEventRows, livePrefix, maxValveEventRows, minExpandedPanelSize, portalAccessTimeoutMs, rememberEmailKey, staleAfterMs, supabaseQueryTimeoutMs, supportPollMs, wateringHistoryMs } from "./portalConstants";
import { type DataMode, type EffectiveMode, isIgnoredDiagnosticReading, isIgnoredDiagnosticValveEvent, mergeRollingExperimentReadings, pairingsFromDeviceConfigState, resolveEffectiveMode, rollingExperimentHistoryMs, visibleExperimentPairings } from "./portalData";
import { controlCommandLabel, errorMessage, formatHealthInteger, formatTargetVwc, functionErrorMessage, pairingCalibrationName, runtimeStateIsFresh, selectHealthSnapshot } from "./portalFormat";
import { colorForPairing, orderedPairings, plantGroupForPairing, plantGroupLabel, treatmentForPairing, treatmentLabel } from "./portalPresentation";
import { selectPortalAccessRow, selectProjectDevice } from "./portalProjectContext";
import { fetchReadingsForMode, incrementalReadingCursor, loadedReadingCounts, newestByTime, sourceLabelForReading } from "./portalReadings";
import { adminOnlyControlCommandTypes, type AuthMode, type ChartSeries, type ControlCommandResponse, type CsvDownload, type DeviceConfigState, type DeviceHealthSnapshot, type DeviceRuntimeState, type ExperimentGraphMode, type HealthSelectedDetail, type InviteAcceptResponse, type LoadState, type PanelPosition, type PanelSize, type PortalAccess, type PortalView, type PotPreset, type QueueControlCommand, type QueueSettingsPlan, type QuoteRequestRow, type RefreshOptions, type SalesSupportData, type SettingsSection, type SupportMessageRow, type SupportThreadRow, type TimeWindow } from "./portalTypes";
import { csvEscape, dedupeReadingsForExport, downloadJsonFile } from "./readingsExport";
import { type SettingsCommandDraft, stoppedSettingsCommandTypes } from "./settingsSpec";
import { softwareTermsVersion, supportEmail } from "./softwareTerms";
import { supabase } from "./supabase";
import { withSupabaseTimeout } from "./supabaseTimeout";
import { type LatestState, type PairingRow, type SensorReading, type ValveEvent } from "./types";
import { ResearchWateringActivity } from "./watering/WateringActivity";
import { mergeValveEventRows, resolveHealthWateringEvents, valveEventsToHealthWateringEvents, valveEventTimestampMs } from "./wateringEvents";
import { createCoalescedTrigger, scheduleVisiblePolling } from "./visiblePolling";
import { usePageClock } from "./pageClock";
import { FeatureBoundary, FeatureLoading, lazyFeature } from "./lazyFeature";
import { overlayTimeBounds } from "./wateringOverlay";
import { homeExceptions } from "./homeExceptions";
import { type ExperimentTab, navigatePortal, type PortalRoute, stripAuthQuery, usePortalRoute } from "./portalRoute";
import { resolvePot } from "./potIdentity";
import { ExperimentNotFound, ExperimentPage } from "./product/ExperimentPage";
import { FindPotDialog } from "./product/FindPotDialog";
import { PortalLink } from "./product/PortalLink";
import { ProductHeader } from "./product/ProductHeader";
import { type InstallationState, QuietSpineHome } from "./product/QuietSpineHome";
import { atBenchRemembered, rememberAtBench } from "./product/pocketMode";
import { useNoteOutbox } from "./product/useNoteOutbox";
import { loadLatestBenchLayout, loadPotBindings, recordBenchLayout, type BenchLayoutVersion, type PotBinding } from "./benchClient";


// Features loaded on first use: the sign-in page and home stay small, and admin-only views never
// reach researchers' browsers unless opened.
const loadSettingsPanel = () => import("./settings/PortalSettingsPanel").then((module) => ({ default: module.PortalSettingsPanel }));
const PortalSettingsPanel = lazyFeature(loadSettingsPanel);
const ExperimentBuilder = lazyFeature(() => import("./ExperimentBuilder").then((module) => ({ default: module.ExperimentBuilder })));
const SystemHealthView = lazyFeature(() => import("./health/SystemHealthView").then((module) => ({ default: module.SystemHealthView })));
const SalesSupportView = lazyFeature(() => import("./support/SalesSupportView").then((module) => ({ default: module.SalesSupportView })));
const WalkerExperimentView = lazyFeature(() => import("./walker/WalkerExperimentView").then((module) => ({ default: module.WalkerExperimentView })));
const WebsiteAnalyticsWorkspace = lazyFeature(() => import("./analytics/WebsiteAnalyticsWorkspace"));
// Experiment, pot and trend views load when first opened; the home and header stay in the entry.
const WaterlineOverview = lazyFeature(() => import("./product/WaterlineOverview").then((module) => ({ default: module.WaterlineOverview })));
const PotPage = lazyFeature(() => import("./product/PotPage").then((module) => ({ default: module.PotPage })));
const PotsTable = lazyFeature(() => import("./product/PotsTable").then((module) => ({ default: module.PotsTable })));
const TrendsView = lazyFeature(() => import("./product/TrendsView").then((module) => ({ default: module.TrendsView })));
const BenchView = lazyFeature(() => import("./product/BenchView").then((module) => ({ default: module.BenchView })));
const PocketView = lazyFeature(() => import("./product/PocketView").then((module) => ({ default: module.PocketView })));
// The bundle's own file name (content-hashed in production) identifies the build in exports.
const portalBuild = (() => {
  try {
    return new URL(import.meta.url).pathname.split("/").pop() || "portal";
  } catch {
    return "portal";
  }
})();
const WorkbenchView = lazyFeature(() => import("./product/WorkbenchView").then((module) => ({ default: module.WorkbenchView })));
const RecordView = lazyFeature(() => import("./product/RecordView").then((module) => ({ default: module.RecordView })));
const PotNotesSection = lazyFeature(() => import("./product/PotNotesSection").then((module) => ({ default: module.PotNotesSection })));
const prefetchSettings = () => {
  void loadSettingsPanel().catch(() => undefined);
};

const emptyNameSet = new Set<string>();
const ignoreSeriesSelection = () => undefined;
const clockTickMs = 30_000;
/** Realtime readings arriving within this window are merged together. */
const realtimeBatchMs = 400;
/** Backstop polling for a tracked controller command, and how long to keep following it. */
const trackedCommandPollMs = 15_000;
const trackedCommandPollLimitMs = 15 * 60_000;
/** Returning to the tab reconciles at most this often. */
const returnReconcileSpacingMs = 30_000;
/** After this long hidden, the return reconciliation reloads everything instead of the newest rows. */
const longAbsenceFullReloadMs = 6 * 60 * 60_000;

/**
 * Next loaded-readings state. lastNewDataAt moves only when a batch contains a
 * reading the portal did not already have; re-fetching overlapping rows is a
 * check, not new data.
 */
function readingsState(
  current: LoadState,
  readings: SensorReading[],
  incoming: SensorReading[],
  nowIso: string,
  effectiveMode: EffectiveMode,
): LoadState {
  const known = current.readings.length ? new Set(current.readings.map((reading) => reading.event_id || String(reading.id))) : null;
  const hasNew = incoming.some((reading) => !known || !known.has(reading.event_id || String(reading.id)));
  const loadedCounts = loadedReadingCounts(readings);
  const latestLiveReading = newestByTime(
    readings.filter((reading) => reading.event_id.startsWith("live-device:")),
  );
  return {
    ...current,
    readings,
    totalImportedReadings: loadedCounts.imported,
    totalLiveReadings: loadedCounts.live,
    latestLiveReading: latestLiveReading ?? current.latestLiveReading,
    lastCheckedAt: nowIso,
    lastNewDataAt: hasNew ? nowIso : current.lastNewDataAt,
    effectiveMode,
  };
}

const initialLoadState: LoadState = {
  pairings: [],
  latestState: null,
  readings: [],
  totalImportedReadings: 0,
  totalLiveReadings: 0,
  latestLiveReading: null,
  latestIngestTime: null,
  lastCheckedAt: null,
  lastNewDataAt: null,
  effectiveMode: "snapshot",
};

const initialSalesSupportData: SalesSupportData = {
  quotes: [],
  threads: [],
  messages: [],
};

function inviteTokenFromUrl() {
  const params = new URLSearchParams(window.location.search);
  return params.get("invite") ?? params.get("token") ?? "";
}

function initialEmail() {
  const params = new URLSearchParams(window.location.search);
  return params.get("email") ?? "";
}

function initialAuthMode(): AuthMode {
  const params = new URLSearchParams(window.location.search);
  const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const authType = params.get("type") ?? hashParams.get("type");

  if (inviteTokenFromUrl()) return "accept-invite";
  if (authType === "recovery") return "set-password";
  return "sign-in";
}


export default function App() {
  const [email, setEmail] = useState(() => initialEmail());
  const [password, setPassword] = useState("");
  const [authMode, setAuthMode] = useState<AuthMode>(() => initialAuthMode());
  const [inviteToken] = useState(() => inviteTokenFromUrl());
  const [authNotice, setAuthNotice] = useState<string | null>(null);
  const [rememberDevice, setRememberDevice] = useState(false);
  const [termsOpen, setTermsOpen] = useState(false);
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [sessionReady, setSessionReady] = useState(false);
  const [sessionRevision, setSessionRevision] = useState(0);
  const [loading, setLoading] = useState(false);
  const [exportingCsv, setExportingCsv] = useState(false);
  const [csvDownload, setCsvDownload] = useState<CsvDownload | null>(null);
  const [csvError, setCsvError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [selectedMode] = useState<DataMode>("auto");
  const [experimentGraphMode, setExperimentGraphMode] = useState<ExperimentGraphMode>("vwc");
  const [potPreset, setPotPreset] = useState<PotPreset>("all");
  const [hiddenPots, setHiddenPots] = useState<Set<string>>(() => new Set());
  const [selectedSeriesName, setSelectedSeriesName] = useState<string | null>(null);
  const [selectedWateringDetail, setSelectedWateringDetail] = useState<HealthSelectedDetail | null>(null);
  const [timeWindow, setTimeWindow] = useState<TimeWindow>(fullTimeWindow);
  const [graphExpanded, setGraphExpanded] = useState(false);
  const [selectedExperimentGraphGroupId, setSelectedExperimentGraphGroupId] =
    useState("");
  const [panelPosition, setPanelPosition] = useState<PanelPosition | null>(null);
  const [panelSize, setPanelSize] = useState<PanelSize>(defaultExpandedPanelSize);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // The settings panel loads on first open and then stays mounted so its form state survives closing.
  const [settingsMounted, setSettingsMounted] = useState(false);
  if (settingsOpen && !settingsMounted) setSettingsMounted(true);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("overview");
  const [controlBusy, setControlBusy] = useState(false);
  const [controlNotice, setControlNotice] = useState<string | null>(null);
  // The most recent request to the controller, followed from request to execution.
  const [trackedCommand, setTrackedCommand] = useState<TrackedCommand | null>(null);
  const [controlError, setControlError] = useState<string | null>(null);
  const [data, setData] = useState<LoadState>(initialLoadState);
  const [portalAccess, setPortalAccess] = useState<PortalAccess>(null);
  const [accessLoading, setAccessLoading] = useState(false);
  // The URL is the source of truth for what is on screen: Back, Forward, refresh and copied links work.
  const route = usePortalRoute();
  const portalView: PortalView = route.view === "experiment" || route.view === "pot"
    ? "experiment"
    : route.view === "health" || route.view === "support" || route.view === "walker" || route.view === "chamber" || route.view === "analytics"
      ? route.view
      : "home";
  const setPortalView = useCallback((view: PortalView) => {
    navigatePortal(view === "home" || view === "experiment" ? { view: "home" } : { view } as PortalRoute);
  }, []);
  const [findPotOpen, setFindPotOpen] = useState(false);
  // "At the bench" is a remembered choice on this device; the full portal stays one tap away.
  const [atBench, setAtBench] = useState(() => atBenchRemembered());
  const [online, setOnline] = useState(() => typeof navigator === "undefined" || navigator.onLine !== false);
  const [benchData, setBenchData] = useState<{ scope: string; bindings: PotBinding[]; layout: BenchLayoutVersion | null; versions: number; error: string | null } | null>(null);
  const [refreshFailedAt, setRefreshFailedAt] = useState<number | null>(null);
  const [lastSuccessfulCheckAt, setLastSuccessfulCheckAt] = useState<number | null>(null);
  // Re-evaluates measurement ages ("4 min ago") without refetching anything.
  const clockNowMs = usePageClock(clockTickMs);
  const selectedExperimentId: ExperimentId = route.view === "experiment" ? route.experiment : "";
  // Per-experiment view state (hidden pots, graph mode, window) starts fresh for each experiment,
  // whether it was opened by a click, Back/Forward or a copied link.
  const [uiExperimentId, setUiExperimentId] = useState<ExperimentId>(selectedExperimentId);
  const [experimentCatalog, setExperimentCatalog] = useState<PortalExperiment[]>([]);
  const [experimentBuilderOpen, setExperimentBuilderOpen] = useState(false);
  const [editingExperiment, setEditingExperiment] = useState<PortalExperiment | null>(null);
  const [experimentBuilderPrompt, setExperimentBuilderPrompt] = useState("");
  const [settingsAssistantPrompt, setSettingsAssistantPrompt] = useState("");
  const [experimentCatalogError, setExperimentCatalogError] = useState<string | null>(null);
  const [healthSnapshot, setHealthSnapshot] = useState<DeviceHealthSnapshot | null>(null);
  const [healthHistory, setHealthHistory] = useState<DeviceHealthSnapshot[]>([]);
  const [runtimeState, setRuntimeState] = useState<DeviceRuntimeState | null>(null);
  const [configState, setConfigState] = useState<DeviceConfigState | null>(null);
  const [valveEvents, setValveEvents] = useState<ValveEvent[]>([]);
  const [healthLoading, setHealthLoading] = useState(false);
  const [healthError, setHealthError] = useState<string | null>(null);
  const salesSupportLoadId = useRef(0);
  const [salesSupportData, setSalesSupportData] = useState<SalesSupportData>(initialSalesSupportData);
  const [salesSupportLoading, setSalesSupportLoading] = useState(false);
  const [salesSupportError, setSalesSupportError] = useState<string | null>(null);

  const dataRef = useRef(data);
  const valveEventsRef = useRef(valveEvents);
  const loadTokenRef = useRef(0);
  // Identifies the project/device whose data is on screen; responses for another scope are dropped.
  const scopeKeyRef = useRef("");
  const refreshInFlightRef = useRef(false);
  const pendingRefreshRef = useRef<RefreshOptions | null>(null);
  const realtimeRefreshInFlightRef = useRef(false);
  const valveLoadInFlightRef = useRef<{ promise: Promise<void>; full: boolean; scope: string } | null>(null);
  const authRecoveryInFlightRef = useRef<Promise<boolean> | null>(null);
  const watchdogRefreshCountRef = useRef(0);
  const controlRequestIdsRef = useRef(new Map<string, { id: string; createdAt: number }>());
  const settingsBatchIdsRef = useRef(new Map<string, {
    batchId: string;
    commandIds: string[];
    createdAt: number;
  }>());
  const dashboardMainRef = useRef<HTMLElement | null>(null);
  const controlPanelRef = useRef<HTMLElement | null>(null);
  const panelDragOffsetRef = useRef<PanelPosition | null>(null);

  useEffect(() => {
    dataRef.current = data;
  }, [data]);

  useEffect(() => {
    valveEventsRef.current = valveEvents;
  }, [valveEvents]);

  useEffect(() => {
    if (!settingsOpen) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSettingsOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [settingsOpen]);

  const availableExperiments = useMemo(
    () => mergePortalExperiments(
      portalExperimentsForRole(portalAccess?.role),
      experimentCatalog,
    ),
    [experimentCatalog, portalAccess?.role],
  );
  const selectedExperiment = useMemo(
    () => portalExperimentById(selectedExperimentId, availableExperiments),
    [availableExperiments, selectedExperimentId],
  );
  const selectedExperimentGraphGroups = useMemo(
    () => experimentGraphGroups(selectedExperiment),
    [selectedExperiment],
  );
  const sortedPairings = useMemo(
    () => orderedPairings(
      visibleExperimentPairings(data.pairings)
        .filter((pairing) => pairingBelongsToExperiment(pairing, selectedExperiment)),
    ),
    [data.pairings, selectedExperiment],
  );
  const pairingByName = useMemo(
    () => new Map(sortedPairings.map((pairing) => [pairing.name, pairing])),
    [sortedPairings],
  );
  const experimentReadings = useMemo(
    () => readingsForExperiment(data.readings, selectedExperiment),
    [data.readings, selectedExperiment],
  );
  const series = useMemo(
    () => chartSeries(sortedPairings, experimentReadings, selectedExperiment),
    [sortedPairings, experimentReadings, selectedExperiment],
  );
  const seriesByName = useMemo(() => new Map(series.map((item) => [item.name, item])), [series]);
  const chartDisplaySeries = useMemo(() => {
    return series.slice().sort((a, b) => {
      if (a.name === selectedSeriesName) return 1;
      if (b.name === selectedSeriesName) return -1;
      return a.name.localeCompare(b.name);
    });
  }, [series, selectedSeriesName]);
  const timeBounds = useMemo(() => timeBoundsForSeries(series), [series]);
  const timeFilteredSeries = useMemo(
    () => filterSeriesByTime(chartDisplaySeries, timeBounds, timeWindow),
    [chartDisplaySeries, timeBounds, timeWindow],
  );
  const selectedVwcTimeBounds = useMemo(
    () => overlayTimeBounds(timeBounds, timeWindow),
    [timeBounds, timeWindow],
  );
  const visibleNames = useMemo(
    () => new Set(series.filter((item) => !hiddenPots.has(item.name)).map((item) => item.name)),
    [series, hiddenPots],
  );
  const overlayVisibleNames = useMemo(
    () => new Set(series
      .filter((item) => item.kind === "pot" && !hiddenPots.has(item.name))
      .map((item) => item.name)),
    [series, hiddenPots],
  );
  const visibleWateringPairings = useMemo(
    () => sortedPairings.filter((pairing) => !hiddenPots.has(pairing.name)),
    [hiddenPots, sortedPairings],
  );
  const experimentWateringEvents = useMemo(
    () => resolveHealthWateringEvents(
      valveEventsToHealthWateringEvents(
        valveEventsForExperiment(valveEvents, selectedExperiment),
        sortedPairings,
      ),
      sortedPairings,
    ),
    [selectedExperiment, sortedPairings, valveEvents],
  );
  const selectPot = useCallback((name: string) => setSelectedSeriesName(name), []);
  const groupVisibleNameSets = useMemo(
    () => new Map(selectedExperimentGraphGroups.map((group) => [group.id, new Set(group.pairingNames)])),
    [selectedExperimentGraphGroups],
  );
  const groupTargets = useMemo(
    () => new Map(selectedExperimentGraphGroups.map((group) => [group.id, groupTarget(group, selectedExperiment, sortedPairings)])),
    [selectedExperiment, selectedExperimentGraphGroups, sortedPairings],
  );
  // Treatment comparison from full-resolution readings inside the selected time window.
  const groupComparisons = useMemo(
    () => new Map(selectedExperimentGraphGroups.map((group) => {
      const names = groupVisibleNameSets.get(group.id) ?? new Set<string>();
      return [group.id, compareGroup(series.filter((item) => names.has(item.name)), selectedVwcTimeBounds)];
    })),
    [groupVisibleNameSets, selectedExperimentGraphGroups, selectedVwcTimeBounds, series],
  );
  const groupTargetLines = useMemo(
    () => new Map(selectedExperimentGraphGroups.map((group) => {
      const names = groupVisibleNameSets.get(group.id) ?? new Set<string>();
      return [group.id, targetLinesForPairings(
        sortedPairings.filter((pairing) => names.has(pairing.name)),
        (pairing) => treatmentForPairing(pairing, selectedExperiment),
        selectedExperiment,
      )];
    })),
    [groupVisibleNameSets, selectedExperiment, selectedExperimentGraphGroups, sortedPairings],
  );
  const chartVisibleNames = experimentGraphMode === "overlay" ? overlayVisibleNames : visibleNames;
  const visibleTargetLines = useMemo(
    () => targetLinesForPairings(
      sortedPairings.filter((pairing) => chartVisibleNames.has(pairing.name)),
      (pairing) => treatmentForPairing(pairing, selectedExperiment),
      selectedExperiment,
    ),
    [chartVisibleNames, selectedExperiment, sortedPairings],
  );
  const describePotTarget = useCallback(
    (item: ChartSeries) => pairingTargetText(pairingByName.get(item.name), selectedExperiment),
    [pairingByName, selectedExperiment],
  );
  const latestMeasuredAt = useMemo(
    () => series.reduce<number | null>((latest, item) => {
      const point = latestPoint(item);
      return point && (latest == null || point.timestampMs > latest) ? point.timestampMs : latest;
    }, null),
    [series],
  );
  const controllerOffline = runtimeState
    ? controllerPresence({
      stateFreshUntil: runtimeState.state_fresh_until,
      stateObservedAt: runtimeState.state_observed_at,
      controllerState: runtimeState.controller_state,
      lastSeenAt: data.latestState?.last_seen_at ?? data.latestState?.updated_at,
    }, clockNowMs).status === "offline"
    : false;
  const reportingPotCount = series.filter((item) => measurementFreshness({
    measuredAt: latestPoint(item)?.timestampMs,
    expectedIntervalMs: item.expectedIntervalMs,
    nowMs: clockNowMs,
  }).state === "current").length;
  const experimentStatusFreshness = withReportingCoverage(experimentFreshness({
    experiment: selectedExperiment,
    pairings: sortedPairings,
    latestMeasuredAt,
    controllerOffline,
    nowMs: clockNowMs,
  }), { reporting: reportingPotCount, total: series.length });

  const visiblePotCount = series.filter(
    (item) => visibleNames.has(item.name) && item.rawPointCount > 0,
  ).length;
  const isAdmin = portalAccess?.role === "admin";
  const projectAccess = portalAccess?.accessScope === "project";
  const canReadProjectData = projectAccess && hasProjectDataReadAccess(portalAccess?.role);
  const canUseExperimentSettings = projectAccess && hasExperimentSettingsAccess(portalAccess?.role);
  const canCreateExperiment = canUseExperimentSettings;
  const activeProjectId = portalAccess?.projectId ?? "";
  const activeDeviceId = portalAccess?.deviceId ?? "";
  const scopeKey = sessionReady ? `${activeProjectId}:${activeDeviceId}` : "";
  if (scopeKeyRef.current !== scopeKey) {
    // Any refresh still running for the previous session, project or device must not land.
    scopeKeyRef.current = scopeKey;
    loadTokenRef.current += 1;
  }

  // Bench notes: written to this device first, sent under the signed-in account's permissions.
  const outboxUserId = projectAccess ? portalAccess?.userId ?? null : null;
  const outboxEmail = portalAccess?.email ?? null;
  const outboxScope = useMemo(
    () => (outboxUserId && activeProjectId ? { userId: outboxUserId, projectId: activeProjectId, authorLabel: outboxEmail ?? "Portal member" } : null),
    [activeProjectId, outboxEmail, outboxUserId],
  );
  const canWriteNotes = Boolean(outboxScope) && canUseExperimentSettings;
  const noteOutbox = useNoteOutbox(outboxScope, { enabled: sessionReady && canWriteNotes });
  const benchScope = `${activeProjectId}:${activeDeviceId}`;
  const benchDataNeeded = sessionReady && canReadProjectData && Boolean(activeProjectId && activeDeviceId) &&
    (atBench || route.view === "bench" || route.view === "pocket" || route.view === "pot" || (route.view === "experiment" && Boolean(route.pot)));
  const currentBench = benchData?.scope === benchScope ? benchData : null;

  useEffect(() => {
    const update = () => setOnline(navigator.onLine !== false);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  useEffect(() => {
    if (!benchDataNeeded || benchData?.scope === benchScope) return undefined;
    let active = true;
    // Physical identity and recorded layouts are read only when a bench, pot or pocket view needs them.
    void Promise.allSettled([loadPotBindings(activeProjectId, activeDeviceId), loadLatestBenchLayout(activeProjectId, activeDeviceId)]).then(([bindings, layout]) => {
      if (!active) return;
      setBenchData({
        scope: benchScope,
        bindings: bindings.status === "fulfilled" ? bindings.value : [],
        layout: layout.status === "fulfilled" ? layout.value.latest : null,
        versions: layout.status === "fulfilled" ? layout.value.versions : 0,
        error: layout.status === "rejected" ? errorMessage(layout.reason) : null,
      });
    });
    return () => {
      active = false;
    };
  }, [activeDeviceId, activeProjectId, benchData?.scope, benchDataNeeded, benchScope]);

  const resetPortalSessionUi = useCallback(() => {
    setSettingsOpen(false);
    setSettingsSection("overview");
    setControlBusy(false);
    setControlNotice(null);
    setControlError(null);
    setCsvDownload(null);
    setCsvError(null);
    setTermsOpen(false);
    setTermsAccepted(false);
    setExperimentGraphMode("vwc");
    setSelectedWateringDetail(null);
  }, []);

  if (uiExperimentId !== selectedExperimentId) {
    setUiExperimentId(selectedExperimentId);
    setExperimentGraphMode("vwc");
    setPotPreset("all");
    setHiddenPots(new Set());
    setSelectedExperimentGraphGroupId("");
    setSelectedSeriesName(null);
    setSelectedWateringDetail(null);
    setTimeWindow(fullTimeWindow);
    setGraphExpanded(false);
  }

  const openExperiment = useCallback((experimentId: ExperimentId) => {
    setSettingsOpen(false);
    navigatePortal({ view: "experiment", experiment: experimentId, tab: "overview", pot: null });
  }, []);

  const loadExperimentCatalog = useCallback(async () => {
    if (!canReadProjectData || !activeProjectId) {
      setExperimentCatalog([]);
      return;
    }
    try {
      const catalog = await loadPortalExperimentCatalog(activeProjectId);
      setExperimentCatalog(catalog);
      setExperimentCatalogError(null);
    } catch (nextError) {
      setExperimentCatalogError(errorMessage(nextError));
    }
  }, [activeProjectId, canReadProjectData]);

  const expirePortalSession = useCallback(() => {
    setError(null);
    setLoginError(null);
    setAuthNotice(expiredPortalSessionNotice);
    setSessionReady(false);
  }, []);

  const recoverPortalSession = useCallback(async () => {
    if (authRecoveryInFlightRef.current) return authRecoveryInFlightRef.current;

    const recovery = (async () => {
      const { data: sessionData, error: refreshError } = await supabase.auth.refreshSession();
      if (refreshError || !sessionData.session) {
        await supabase.auth.signOut({ scope: "local" });
        expirePortalSession();
        return false;
      }
      setSessionReady(true);
      return true;
    })();

    authRecoveryInFlightRef.current = recovery;
    try {
      return await recovery;
    } finally {
      authRecoveryInFlightRef.current = null;
    }
  }, [expirePortalSession]);

  const loadPortalAccess = useCallback(async () => {
    setAccessLoading(true);
    try {
      const queryAccess = async () => {
        const userResponse = await withSupabaseTimeout(
          supabase.auth.getUser(),
          portalAccessTimeoutMs,
          "Portal session",
        );
        if (userResponse.error) throw userResponse.error;
        const userId = userResponse.data.user?.id ?? null;
        if (!userId) throw { status: 401, message: "Portal session is unavailable" };

        const accessResponse = await withSupabaseTimeout(
          supabase
            .from("portal_access")
            .select("project_id, role, email, created_at, access_scope")
            .eq("user_id", userId)
            .order("created_at", { ascending: true })
            .limit(20),
          portalAccessTimeoutMs,
          "Portal access",
        );
        if (accessResponse.error) throw accessResponse.error;
        const requestedProjectId = new URLSearchParams(window.location.search).get("project");
        const accessRow = selectPortalAccessRow(
          accessResponse.data ?? [],
          requestedProjectId,
        );
        if (!accessRow) return { data: null };
        const signedInUserId = userId;

        const mixerAccess = await withSupabaseTimeout(
          supabase.rpc("has_gas_mixer_native_access", {
            check_project_id: "44444444-4444-4444-8444-444444444441",
            check_device_id: "gas-mixer:b827eb548a44",
            check_capability: "remote_view",
          }), portalAccessTimeoutMs, "Gas mixer access",
        );
        if (mixerAccess.error) throw mixerAccess.error;
        const gas_mixer_allowed = mixerAccess.data === true;
        if (accessRow.access_scope !== "project") {
          return { data: { ...accessRow, device_id: null, gas_mixer_allowed, user_id: signedInUserId } };
        }

        const deviceResponse = await withSupabaseTimeout(
          supabase
            .from("device_config_state")
            .select("device_id, updated_at")
            .eq("project_id", accessRow.project_id)
            .order("updated_at", { ascending: false })
            .limit(1)
            .maybeSingle(),
          portalAccessTimeoutMs,
          "Project device",
        );
        if (deviceResponse.error) throw deviceResponse.error;
        return {
          data: {
            ...accessRow,
            gas_mixer_allowed,
            user_id: signedInUserId,
            device_id: selectProjectDevice(deviceResponse.data ? [deviceResponse.data] : []),
          },
        };
      };

      let response;
      try {
        response = await queryAccess();
      } catch (err) {
        if (!isSessionAuthorizationError(err) || !(await recoverPortalSession())) throw err;
        response = await queryAccess();
      }

      const role = parsePortalRole(response.data?.role);
      if (!role) {
        setPortalAccess(null);
        return;
      }
      const access: Exclude<PortalAccess, null> = {
        role,
        userId: response.data?.user_id ?? undefined,
        email: response.data?.email ?? null,
        projectId: response.data?.project_id ?? "",
        deviceId: response.data?.device_id ?? null,
        accessScope: response.data?.access_scope ?? "none",
        gasMixerAllowed: response.data?.gas_mixer_allowed === true,
      };
      if (!access.projectId) {
        setPortalAccess(null);
        return;
      }
      setPortalAccess(access);
    } catch (err) {
      if (isSessionAuthorizationError(err)) {
        expirePortalSession();
        return;
      }
      setPortalAccess(null);
      setExperimentCatalog([]);
      setExperimentBuilderOpen(false);
      setEditingExperiment(null);
      setExperimentCatalogError(null);
    } finally {
      setAccessLoading(false);
    }
  }, [expirePortalSession, recoverPortalSession]);

  const loadHealthSnapshot = useCallback(async (options: { silent?: boolean } = {}) => {
    if (!isAdmin || !activeProjectId || !activeDeviceId) return;
    const silent = options.silent === true;
    if (!silent) {
      setHealthLoading(true);
      setHealthError(null);
    }

    try {
      const response = await withSupabaseTimeout(
        supabase
          .from("device_health_snapshots")
          .select(healthSnapshotSelectColumns)
          .eq("project_id", activeProjectId)
          .eq("device_id", activeDeviceId)
          .eq("ingest_complete", true)
          .order("captured_at", { ascending: false })
          .limit(300),
        supabaseQueryTimeoutMs,
        "Health snapshot",
      );

      if (response.error) throw response.error;
      const snapshots = (response.data ?? []) as DeviceHealthSnapshot[];
      setHealthHistory(snapshots);
      setHealthSnapshot(selectHealthSnapshot(snapshots));
    } catch (err) {
      if (!silent) setHealthError(errorMessage(err));
    } finally {
      if (!silent) setHealthLoading(false);
    }
  }, [activeDeviceId, activeProjectId, isAdmin]);

  const loadDeviceSyncState = useCallback(async () => {
    if (!canUseExperimentSettings || !activeProjectId || !activeDeviceId) {
      setRuntimeState(null);
      setConfigState(null);
      return;
    }

    try {
      const [runtimeResponse, configResponse] = await Promise.all([
        withSupabaseTimeout(
          supabase
            .from("device_runtime_state")
            .select("*")
            .eq("project_id", activeProjectId)
            .eq("device_id", activeDeviceId)
            .maybeSingle(),
          supabaseQueryTimeoutMs,
          "Runtime state",
        ),
        withSupabaseTimeout(
          supabase
            .from("device_config_state")
            .select("*")
            .eq("project_id", activeProjectId)
            .eq("device_id", activeDeviceId)
            .maybeSingle(),
          supabaseQueryTimeoutMs,
          "Config state",
        ),
      ]);

      if (!runtimeResponse.error) {
        setRuntimeState((runtimeResponse.data ?? null) as DeviceRuntimeState | null);
      }
      if (!configResponse.error) {
        setConfigState((configResponse.data ?? null) as DeviceConfigState | null);
      }
    } catch {
      // Keep the last mirrored controller state visible while Supabase catches up.
    }
  }, [activeDeviceId, activeProjectId, canUseExperimentSettings]);

  const loadValveEvents = useCallback((options: { incremental?: boolean; fresh?: boolean } = {}): Promise<void> => {
    if (!canReadProjectData || !activeProjectId || !activeDeviceId) {
      setValveEvents([]);
      return Promise.resolve();
    }
    const scope = scopeKeyRef.current;
    // Incremental only extends a timeline that exists; with nothing loaded (or a failed first load)
    // it would fetch just the newest rows of the whole window and never backfill the rest.
    const incremental = options.incremental === true && valveEventsRef.current.length > 0;
    // Startup, the realtime subscription and tab return can all ask at once; share one request for
    // the same scope. `fresh` asks for a query that starts after any request already running.
    const inFlight = valveLoadInFlightRef.current;
    if (inFlight && inFlight.scope === scope && (inFlight.full || incremental)) {
      return options.fresh ? inFlight.promise.then(() => loadValveEventsRef.current({ incremental: true })) : inFlight.promise;
    }
    const query = async (fromIncremental: boolean) => {
      const existing = valveEventsRef.current;
      const newestExistingAt = existing.reduce(
        (latest, event) => Math.max(latest, valveEventTimestampMs(event)),
        0,
      );
      const sinceMs = fromIncremental && newestExistingAt > 0
        ? newestExistingAt - incrementalCursorOverlapMs
        : Date.now() - wateringHistoryMs;
      const limit = fromIncremental ? incrementalValveEventRows : maxValveEventRows;
      const response = await withSupabaseTimeout(
        supabase
          .from("valve_events")
          .select("*")
          .eq("project_id", activeProjectId)
          .eq("device_id", activeDeviceId)
          .gte("device_recorded_at", new Date(sinceMs).toISOString())
          .order("device_recorded_at", { ascending: false })
          .limit(limit),
        supabaseQueryTimeoutMs,
        "Valve events",
      );
      if (response.error) throw response.error;
      const rows = (response.data ?? []) as ValveEvent[];
      return { rows, filled: rows.length >= limit };
    };
    const promise = (async () => {
      try {
        let result = await query(incremental);
        // A full page of newer rows means the gap may hold more: reload the whole window.
        if (incremental && result.filled && scopeKeyRef.current === scope) result = await query(false);
        if (scopeKeyRef.current !== scope) return;
        setValveEvents((current) => mergeValveEventRows(current, result.rows));
      } catch {
        // Keep the last good watering timeline visible until Supabase recovers.
      }
    })().finally(() => {
      if (valveLoadInFlightRef.current?.promise === promise) valveLoadInFlightRef.current = null;
    });
    valveLoadInFlightRef.current = { promise, full: !incremental, scope };
    return promise;
  }, [activeDeviceId, activeProjectId, canReadProjectData]);
  const loadValveEventsRef = useRef(loadValveEvents);
  useEffect(() => {
    loadValveEventsRef.current = loadValveEvents;
  }, [loadValveEvents]);

  const loadSalesSupport = useCallback(async (options: { silent?: boolean } = {}) => {
    const loadId = ++salesSupportLoadId.current;
    if (!isAdmin || !activeProjectId) {
      setSalesSupportData(initialSalesSupportData);
      return;
    }

    const silent = options.silent === true;
    if (!silent) {
      setSalesSupportLoading(true);
      setSalesSupportError(null);
    }

    try {
      const [quotesResponse, threadsResponse, messagesResponse] = await Promise.all([
        withSupabaseTimeout(
          supabase
            .from("quote_requests")
            .select("id, project_id, created_at, updated_at, name, email, phone, organization, application, timeline, message, source_url, referrer, notification_email, notification_status, notification_error, status, priority")
            .eq("project_id", activeProjectId)
            .order("created_at", { ascending: false })
            .limit(40),
          supabaseQueryTimeoutMs,
          "Quote requests",
        ),
        withSupabaseTimeout(
          supabase
            .from("support_threads")
            .select("id, project_id, created_at, updated_at, last_message_at, source, status, priority, request_type, subject, customer_name, customer_email, customer_phone, customer_organization, quote_request_id, last_message_preview, last_message_from_email, last_message_subject, metadata")
            .eq("project_id", activeProjectId)
            .order("last_message_at", { ascending: false })
            .limit(40),
          supabaseQueryTimeoutMs,
          "Support threads",
        ),
        withSupabaseTimeout(
          supabase
            .from("support_messages")
            .select("id, thread_id, project_id, created_at, direction, channel, from_email, from_name, to_emails, subject, body_text, body_html, metadata")
            .eq("project_id", activeProjectId)
            .order("created_at", { ascending: false })
            .limit(80),
          supabaseQueryTimeoutMs,
          "Support messages",
        ),
      ]);

      if (quotesResponse.error) throw quotesResponse.error;
      if (threadsResponse.error) throw threadsResponse.error;
      if (messagesResponse.error) throw messagesResponse.error;

      if (loadId !== salesSupportLoadId.current) return;
      setSalesSupportData({
        quotes: (quotesResponse.data ?? []) as QuoteRequestRow[],
        threads: (threadsResponse.data ?? []) as SupportThreadRow[],
        messages: (messagesResponse.data ?? []) as SupportMessageRow[],
      });
    } catch (err) {
      if (!silent) setSalesSupportError(errorMessage(err));
    } finally {
      if (!silent) setSalesSupportLoading(false);
    }
  }, [activeProjectId, isAdmin]);

  const deleteQuoteRequest = useCallback(async (quoteId: string) => {
    if (!isAdmin || !activeProjectId) throw new Error("Admin access is required to delete quotes.");
    const { error } = await withSupabaseTimeout(
      supabase.rpc("delete_quote_request", { p_project_id: activeProjectId, p_quote_id: quoteId }),
      supabaseQueryTimeoutMs,
      "Delete quote request",
    );
    if (error) throw error;
    // Discard earlier queue reads so they cannot restore a just-deleted item.
    salesSupportLoadId.current += 1;
    setSalesSupportData((current) => {
      const removedThreads = new Set(current.threads.filter((thread) => thread.quote_request_id === quoteId).map((thread) => thread.id));
      return {
        quotes: current.quotes.filter((quote) => quote.id !== quoteId),
        threads: current.threads.filter((thread) => !removedThreads.has(thread.id)),
        messages: current.messages.filter((message) => !removedThreads.has(message.thread_id)),
      };
    });
    void loadSalesSupport({ silent: true });
  }, [activeProjectId, isAdmin, loadSalesSupport]);

  const runPortalRefresh = useCallback(
    async ({ incremental }: RefreshOptions) => {
      if (!activeProjectId || !activeDeviceId) return;
      const token = loadTokenRef.current + 1;
      loadTokenRef.current = token;
      setError(null);
      setLoading(!incremental || dataRef.current.readings.length === 0);
      try {
        const loadCoreData = async () => {
          const results = await Promise.all([
            withSupabaseTimeout(
              supabase
                .from("device_config_state")
                .select("*")
                .eq("project_id", activeProjectId)
                .eq("device_id", activeDeviceId)
                .maybeSingle(),
              supabaseQueryTimeoutMs,
              "Controller config",
            ),
            withSupabaseTimeout(
              supabase
                .from("latest_device_state")
                .select("*")
                .eq("device_id", activeDeviceId)
                .limit(1)
                .maybeSingle(),
              supabaseQueryTimeoutMs,
              "Latest device state",
            ),
            selectedMode === "auto"
              ? withSupabaseTimeout(
                supabase
                  .from("sensor_readings")
                  .select("id, server_received_at")
                  .eq("project_id", activeProjectId)
                  .eq("device_id", activeDeviceId)
                  .like("event_id", livePrefix)
                  .gte("server_received_at", new Date(Date.now() - staleAfterMs).toISOString())
                  .limit(1),
                supabaseQueryTimeoutMs,
                "Live reading availability",
              )
              : Promise.resolve({ data: null, error: null }),
          ]);

          for (const result of results) {
            if (result.error) throw result.error;
          }
          return results;
        };

        let coreData;
        try {
          coreData = await loadCoreData();
        } catch (err) {
          if (!isSessionAuthorizationError(err) || !(await recoverPortalSession())) throw err;
          coreData = await loadCoreData();
        }
        const [controllerConfig, latestState, liveAvailability] = coreData;

        const previous = dataRef.current;
        const effectiveMode = resolveEffectiveMode(selectedMode, Boolean(liveAvailability.data?.length));
        const canIncrement = incremental && previous.effectiveMode === effectiveMode;
        const newerThan = canIncrement ? incrementalReadingCursor(previous.readings) : null;
        const nowIso = new Date().toISOString();
        const latestIngestTime =
          latestState.data?.updated_at ??
          previous.latestIngestTime ??
          null;

        if (token !== loadTokenRef.current) return;
        const startedAtMs = Date.now();

        let pairingsData = pairingsFromDeviceConfigState(
          controllerConfig.data?.pairings,
          controllerConfig.data?.groups,
        );
        if (pairingsData.length === 0) {
          const legacyPairings = await withSupabaseTimeout(
            supabase
              .from("pairings")
              .select("*")
              .eq("project_id", activeProjectId)
              .eq("device_id", activeDeviceId)
              .limit(1000),
            supabaseQueryTimeoutMs,
            "Legacy pairings",
          );
          if (legacyPairings.error) throw legacyPairings.error;
          if (token !== loadTokenRef.current) return;
          pairingsData = (legacyPairings.data ?? []) as PairingRow[];
        }
        pairingsData = visibleExperimentPairings(pairingsData);

        if (controllerConfig.data) {
          setConfigState(controllerConfig.data as DeviceConfigState);
        }

        // A full reconciliation of data already on screen is assembled off-screen and swapped
        // in once complete, so the chart never empties and refills. Only a first load (or a
        // switch between live and imported data) streams batches in as they arrive.
        const reconcileInPlace = !canIncrement && previous.readings.length > 0 && previous.effectiveMode === effectiveMode;
        setData((current) => ({
          ...current,
          pairings: pairingsData,
          latestState: latestState.data ?? null,
          latestIngestTime,
          lastCheckedAt: nowIso,
          effectiveMode,
          readings: canIncrement || reconcileInPlace ? current.readings : [],
          totalImportedReadings: canIncrement || reconcileInPlace ? current.totalImportedReadings : 0,
          totalLiveReadings: canIncrement || reconcileInPlace ? current.totalLiveReadings : 0,
        }));

        const applyReadingsBatch = (incomingReadings: SensorReading[]) => {
          if (token !== loadTokenRef.current || incomingReadings.length === 0) return;
          setData((current) => readingsState(current, mergeRollingExperimentReadings(current.readings, incomingReadings), incomingReadings, nowIso, effectiveMode));
        };

        const fetched = await fetchReadingsForMode(
          activeProjectId,
          activeDeviceId,
          effectiveMode,
          newerThan,
          reconcileInPlace ? undefined : applyReadingsBatch,
        );
        if (reconcileInPlace && token === loadTokenRef.current) {
          setData((current) => {
            // Keep realtime rows that arrived while the reconciliation was running.
            const arrivedDuring = current.readings.filter((reading) =>
              Date.parse(reading.server_received_at) >= startedAtMs - incrementalCursorOverlapMs);
            const reconciled = mergeRollingExperimentReadings(fetched, arrivedDuring);
            return readingsState(current, reconciled, fetched, nowIso, effectiveMode);
          });
        }
        if (token === loadTokenRef.current) {
          // Only a completed check may make the home quiet; a failed one is stated, with the
          // time of the last good data.
          setLastSuccessfulCheckAt(Date.now());
          setRefreshFailedAt(null);
        }
      } catch (err) {
        if (token === loadTokenRef.current) {
          if (isSessionAuthorizationError(err)) {
            expirePortalSession();
            return;
          }
          setError(errorMessage(err));
          setRefreshFailedAt(Date.now());
        }
      } finally {
        if (token === loadTokenRef.current) {
          setLoading(false);
        }
      }
    },
    [
      activeDeviceId,
      activeProjectId,
      expirePortalSession,
      recoverPortalSession,
      selectedMode,
    ],
  );

  const refreshLatestReadings = useCallback(async () => {
    if (realtimeRefreshInFlightRef.current || !activeProjectId || !activeDeviceId) return;
    const currentData = dataRef.current;
    const newerThan = incrementalReadingCursor(currentData.readings);
    if (!newerThan) return;

    realtimeRefreshInFlightRef.current = true;
    const scope = scopeKeyRef.current;
    try {
      const effectiveMode = currentData.effectiveMode;
      const incomingReadings = await fetchReadingsForMode(
        activeProjectId,
        activeDeviceId,
        effectiveMode,
        newerThan,
      );
      const nowIso = new Date().toISOString();

      if (scopeKeyRef.current !== scope) return;
      setData((current) => {
        if (!incomingReadings.length) {
          return {
            ...current,
            lastCheckedAt: nowIso,
          };
        }
        const next = readingsState(current, mergeRollingExperimentReadings(current.readings, incomingReadings), incomingReadings, nowIso, current.effectiveMode);
        return {
          ...next,
          latestIngestTime:
            next.latestLiveReading?.server_received_at ??
            current.latestState?.updated_at ??
            current.latestIngestTime,
        };
      });
    } catch {
      // Keep the visible chart stable and retry on the next realtime/poll tick.
    } finally {
      realtimeRefreshInFlightRef.current = false;
    }
  }, [activeDeviceId, activeProjectId]);

  const refresh = useCallback(
    async (options: RefreshOptions) => {
      if (refreshInFlightRef.current) {
        if (options.incremental) {
          void refreshLatestReadings();
          return;
        }
        const pending = pendingRefreshRef.current;
        pendingRefreshRef.current = {
          incremental: pending ? pending.incremental && options.incremental : options.incremental,
        };
        return;
      }

      refreshInFlightRef.current = true;
      let nextOptions: RefreshOptions | null = options;

      try {
        while (nextOptions) {
          const currentOptions = nextOptions;
          nextOptions = null;
          await runPortalRefresh(currentOptions);
          nextOptions = pendingRefreshRef.current;
          pendingRefreshRef.current = null;
        }
      } finally {
        refreshInFlightRef.current = false;
      }
    },
    [refreshLatestReadings, runPortalRefresh],
  );

  const sendSingleControlCommand = useCallback<QueueControlCommand>(
    async (commandType, payload, options) => {
      if (!canUseExperimentSettings || !activeProjectId || !activeDeviceId) {
        setControlError("Experiment settings access is required for portal controls.");
        return;
      }
      if (!isAdmin && adminOnlyControlCommandTypes.has(commandType)) {
        setControlError("Administrator access is required for this controller command.");
        return;
      }

      setControlBusy(true);
      setControlNotice(null);
      setControlError(null);
      setTrackedCommand(null);

      const requestKey = JSON.stringify([commandType, payload, options?.confirm === true]);
      const nowMs = Date.now();
      for (const [key, entry] of controlRequestIdsRef.current) {
        if (nowMs - entry.createdAt > 10 * 60 * 1000) controlRequestIdsRef.current.delete(key);
      }
      const existingRequest = controlRequestIdsRef.current.get(requestKey);
      const clientRequestId = existingRequest?.id ?? crypto.randomUUID();
      controlRequestIdsRef.current.set(requestKey, { id: clientRequestId, createdAt: nowMs });

      try {
        const response = await withSupabaseTimeout(
          (signal) => supabase.functions.invoke<ControlCommandResponse>("create-control-command", {
            body: {
              project_id: activeProjectId,
              device_id: dataRef.current.latestState?.device_id ?? activeDeviceId,
              client_request_id: clientRequestId,
              command_type: commandType,
              payload,
              confirm: options?.confirm === true,
              operation_intent: options?.operationIntent,
            },
            signal,
          }),
          supabaseQueryTimeoutMs,
          "Control command",
        );

        if (response.error) {
          throw new Error(await functionErrorMessage(response.error));
        }

        controlRequestIdsRef.current.delete(requestKey);
        const command = response.data?.command;
        if (command?.id) {
          setTrackedCommand({
            ids: [command.id],
            label: controlCommandLabel(commandType),
            commandType,
            requestedAt: command.requested_at ?? new Date().toISOString(),
            statuses: { [command.id]: isCommandStatus(command.status) ? command.status : undefined },
          });
        } else {
          setControlNotice(`${controlCommandLabel(commandType)} requested`);
        }
      } catch (err) {
        try {
          const reconciliation = await withSupabaseTimeout(
            supabase
              .from("project_control_commands")
              .select("id,status,requested_at")
              .eq("project_id", activeProjectId)
              .eq("client_request_id", clientRequestId)
              .maybeSingle(),
            supabaseQueryTimeoutMs,
            "Control command reconciliation",
          );
          if (!reconciliation.error && reconciliation.data?.id) {
            controlRequestIdsRef.current.delete(requestKey);
            const recorded = reconciliation.data as { id: string; status?: unknown; requested_at?: string };
            setTrackedCommand({
              ids: [recorded.id],
              label: controlCommandLabel(commandType),
              commandType,
              requestedAt: recorded.requested_at ?? new Date().toISOString(),
              statuses: { [recorded.id]: isCommandStatus(recorded.status) ? recorded.status : undefined },
            });
          } else {
            setControlError(`${errorMessage(err)} Safe to retry; the same request ID will be reused.`);
          }
        } catch {
          setControlError(`${errorMessage(err)} Safe to retry; the same request ID will be reused.`);
        }
      } finally {
        setControlBusy(false);
      }
    },
    [
      activeDeviceId,
      activeProjectId,
      canUseExperimentSettings,
      isAdmin,
    ],
  );

  const queueSettingsPlan: QueueSettingsPlan = async (plan, reviewedConfigHash) => {
      if (!canUseExperimentSettings || !activeProjectId || !activeDeviceId) {
        setControlError("Experiment settings access is required for portal controls.");
        return;
      }
      if (!plan.commands.length || plan.questions.length) {
        setControlError("Resolve the request before applying settings.");
        return;
      }
      for (const command of plan.commands) {
        if (!isAdmin && adminOnlyControlCommandTypes.has(command.command_type)) {
          setControlError("Administrator access is required for this controller command.");
          return;
        }
      }

      const directCommands = plan.commands.filter(
        (command) => !stoppedSettingsCommandTypes.has(command.command_type),
      );
      if (directCommands.length) {
        if (plan.commands.length !== 1) {
          setControlError("System-state and export requests must be reviewed separately.");
          return;
        }
        const direct = directCommands[0];
        if (direct.command_type === "export_data") {
          const dataType = String(direct.payload.data_type ?? "");
          if (dataType === "readings") {
            await prepareCsvDownload();
          } else if (dataType === "pairings") {
            downloadPairingsCsv();
          } else {
            const synchronized: Record<string, unknown> = {
              groups: configState?.groups ?? [],
              sensors: configState?.sensors ?? [],
              valves: configState?.valves ?? [],
              calibrations: configState?.calibrations ?? [],
            };
            downloadJsonFile(dataType, synchronized[dataType] ?? []);
          }
          setControlNotice("Export ready");
          return;
        }
        await sendSingleControlCommand(
          direct.command_type,
          direct.payload,
          {
            confirm: direct.command_type === "update_system_state",
            operationIntent: plan.summary,
          },
        );
        return;
      }

      setControlBusy(true);
      setControlNotice(null);
      setControlError(null);
      setTrackedCommand(null);

      const reviewedControllerState = runtimeState?.controller_state?.trim().toLowerCase();
      if (
        !runtimeStateIsFresh(runtimeState) ||
        (reviewedControllerState !== "running" && reviewedControllerState !== "stopped")
      ) {
        setControlBusy(false);
        setControlError("Current controller state is unavailable or stale. Refresh and review again.");
        return;
      }

      const requestKey = JSON.stringify([
        reviewedConfigHash,
        reviewedControllerState,
        plan.commands.map((command) => [command.command_type, command.payload]),
      ]);
      const nowMs = Date.now();
      for (const [key, entry] of settingsBatchIdsRef.current) {
        if (nowMs - entry.createdAt > 10 * 60 * 1000) settingsBatchIdsRef.current.delete(key);
      }
      const existing = settingsBatchIdsRef.current.get(requestKey);
      const batchId = existing?.batchId ?? crypto.randomUUID();
      const commandIds = existing?.commandIds ?? Array.from(
        { length: plan.commands.length + 2 },
        () => crypto.randomUUID(),
      );
      settingsBatchIdsRef.current.set(requestKey, { batchId, commandIds, createdAt: nowMs });
      const batchTracking = {
        label: "Reviewed settings",
        commandType: settingsBatchCommandType,
        stepLabels: [
          "Stop controller",
          ...plan.commands.map((command) => controlCommandLabel(command.command_type)),
          reviewedControllerState === "running" ? "Restart controller" : "Leave controller stopped",
        ],
        restoresTo: reviewedControllerState,
      };

      const batchCommands = [
        {
          client_request_id: commandIds[0],
          command_type: "update_system_state",
          payload: { state: "stopped", reason: `Apply reviewed settings: ${plan.summary}` },
          confirm: true,
        },
        ...plan.commands.map((command, index) => ({
          client_request_id: commandIds[index + 1],
          command_type: command.command_type,
          payload: command.payload,
          confirm: true,
        })),
        {
          client_request_id: commandIds[commandIds.length - 1],
          command_type: "update_system_state",
          payload: {
            state: reviewedControllerState,
            reason: `Restore reviewed state after settings: ${plan.summary}`,
          },
          confirm: true,
        },
      ];

      try {
        const response = await withSupabaseTimeout(
          (signal) => supabase.functions.invoke<ControlCommandResponse>("create-control-command", {
            body: {
              project_id: activeProjectId,
              device_id: dataRef.current.latestState?.device_id ?? activeDeviceId,
              client_request_id: commandIds[0],
              batch_id: batchId,
              expected_config_hash: reviewedConfigHash,
              expected_controller_state: reviewedControllerState,
              batch_commands: batchCommands,
              operation_intent: plan.summary,
            },
            signal,
          }),
          supabaseQueryTimeoutMs,
          "Settings batch",
        );
        if (response.error) throw new Error(await functionErrorMessage(response.error));
        if (!response.data?.commands?.length) throw new Error("The complete settings batch was not accepted.");
        settingsBatchIdsRef.current.delete(requestKey);
        const commands = response.data.commands;
        setTrackedCommand({
          ...batchTracking,
          ids: commands.map((command) => command.id),
          requestedAt: new Date().toISOString(),
          statuses: Object.fromEntries(commands.map((command) => [command.id, isCommandStatus(command.status) ? command.status : undefined])),
        });
      } catch (nextError) {
        try {
          const reconciliation = await withSupabaseTimeout(
            supabase
              .from("project_control_commands")
              .select("id,status,client_request_id")
              .eq("project_id", activeProjectId)
              .eq("batch_id", batchId),
            supabaseQueryTimeoutMs,
            "Settings batch reconciliation",
          );
          if (
            !reconciliation.error &&
            (reconciliation.data?.length ?? 0) === batchCommands.length
          ) {
            settingsBatchIdsRef.current.delete(requestKey);
            // Steps are tracked in execution order (stop, change(s), restore): the order the IDs were issued in.
            const recorded = ((reconciliation.data ?? []) as Array<{ id: string; status?: unknown; client_request_id?: string }>)
              .slice()
              .sort((a, b) => commandIds.indexOf(a.client_request_id ?? "") - commandIds.indexOf(b.client_request_id ?? ""));
            setTrackedCommand({
              ...batchTracking,
              ids: recorded.map((command) => command.id),
              requestedAt: new Date().toISOString(),
              statuses: Object.fromEntries(recorded.map((command) => [command.id, isCommandStatus(command.status) ? command.status : undefined])),
            });
          } else {
            setControlError(`${errorMessage(nextError)} Safe to retry; the same batch IDs will be reused.`);
          }
        } catch {
          setControlError(`${errorMessage(nextError)} Safe to retry; the same batch IDs will be reused.`);
        }
      } finally {
        setControlBusy(false);
      }
  };

  const queueControlCommand: QueueControlCommand = async (commandType, payload, options) => {
      if (stoppedSettingsCommandTypes.has(commandType as SettingsCommandDraft["command_type"])) {
        const configHash = configState?.config_hash?.trim();
        if (!configHash) {
          setControlError("Current controller configuration is unavailable. Refresh and try again.");
          return;
        }
        await queueSettingsPlan({
          summary: controlCommandLabel(commandType),
          commands: [{
            command_type: commandType as SettingsCommandDraft["command_type"],
            payload,
            effect: controlCommandLabel(commandType),
          }],
          questions: [],
        }, configHash);
        return;
      }
      await sendSingleControlCommand(commandType, payload, options);
  };

  async function signIn(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (
      email.trim().toLowerCase() === demoAccountEmail &&
      !window.location.pathname.startsWith("/demo")
    ) {
      window.sessionStorage.setItem(demoHandoffKey, JSON.stringify({ email: email.trim().toLowerCase(), password }));
      window.location.assign("/demo");
      return;
    }
    setLoading(true);
    setError(null);
    setLoginError(null);
    setAuthNotice(null);
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    setLoading(false);
    if (signInError) {
      setLoginError(errorMessage(signInError));
      return;
    }
    if (rememberDevice) {
      window.localStorage.setItem(rememberEmailKey, email);
    } else {
      window.localStorage.removeItem(rememberEmailKey);
    }
    resetPortalSessionUi();
    setPassword("");
    setSessionReady(true);
  }

  async function acceptInvite(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    setLoading(true);
    setError(null);
    setLoginError(null);
    setAuthNotice(null);

    if (!inviteToken) {
      setLoading(false);
      setLoginError("Use a valid invite link to create an account.");
      return;
    }

    if (password.length < 8) {
      setLoading(false);
      setLoginError("Use at least 8 characters.");
      return;
    }

    if (!termsAccepted) {
      setLoading(false);
      setLoginError("Review and accept the Software Access Terms to continue.");
      return;
    }

    const { data: inviteData, error: inviteError } =
      await supabase.functions.invoke<InviteAcceptResponse>("accept-invite", {
        body: {
          token: inviteToken,
          email,
          password,
          termsAccepted: true,
          termsVersion: softwareTermsVersion,
        },
      });

    if (inviteError) {
      setLoading(false);
      setLoginError(await functionErrorMessage(inviteError));
      return;
    }

    const session = inviteData?.session;
    if (!session?.access_token || !session.refresh_token) {
      setLoading(false);
      setLoginError("Invite accepted, but sign-in did not complete.");
      return;
    }

    const { error: sessionError } = await supabase.auth.setSession({
      access_token: session.access_token,
      refresh_token: session.refresh_token,
    });

    setLoading(false);

    if (sessionError) {
      setLoginError(errorMessage(sessionError));
      return;
    }

    if (rememberDevice) {
      window.localStorage.setItem(rememberEmailKey, email);
    } else {
      window.localStorage.removeItem(rememberEmailKey);
    }

    stripAuthQuery();
    resetPortalSessionUi();
    setPassword("");
    setSessionReady(true);
  }

  async function setAccountPassword(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    setLoading(true);
    setError(null);
    setLoginError(null);
    setAuthNotice(null);

    if (password.length < 8) {
      setLoading(false);
      setLoginError("Use at least 8 characters.");
      return;
    }

    const { error: updateError } = await supabase.auth.updateUser({ password });
    setLoading(false);

    if (updateError) {
      setLoginError(errorMessage(updateError));
      return;
    }

    stripAuthQuery();
    resetPortalSessionUi();
    setPassword("");
    setSessionReady(true);
  }

  function switchAuthMode(nextMode: AuthMode) {
    setAuthMode(nextMode);
    setLoginError(null);
    setAuthNotice(null);
    if (nextMode !== "set-password") stripAuthQuery();
  }

  async function signOut() {
    const unsent = noteOutbox.waiting.length;
    if (unsent && !window.confirm(`${unsent} ${unsent === 1 ? "note has" : "notes have"} not reached the record yet. ${unsent === 1 ? "It stays" : "They stay"} on this device, visible only to this account, and ${unsent === 1 ? "sends" : "send"} when you sign in here again. Sign out?`)) return;
    await supabase.auth.signOut();
    navigatePortal({ view: "home" }, { replace: true });
    setError(null);
    setLoginError(null);
    setSessionReady(false);
    setPortalAccess(null);
    setAccessLoading(false);
    resetPortalSessionUi();
    setHealthSnapshot(null);
    setHealthHistory([]);
    setRuntimeState(null);
    setConfigState(null);
    setHealthLoading(false);
    setHealthError(null);
    setSalesSupportData(initialSalesSupportData);
    setSalesSupportLoading(false);
    setSalesSupportError(null);
    setData(initialLoadState);
    dataRef.current = initialLoadState;
  }


  function applyPotPreset(preset: Exclude<PotPreset, "custom">) {
    setPotPreset(preset);
    setHiddenPots(() => {
      if (preset === "all") return new Set();
      const hidden = new Set<string>();
      for (const pairing of sortedPairings) {
        const treatment = treatmentForPairing(pairing, selectedExperiment);
        const plantGroup = plantGroupForPairing(pairing, selectedExperiment);
        if (preset === "control" && treatment !== "control") hidden.add(pairing.name);
        if (preset === "drought" && treatment !== "drought") hidden.add(pairing.name);
        if (preset === "maize" && plantGroup !== "maize") hidden.add(pairing.name);
        if (preset === "sorghum" && plantGroup !== "sorghum") hidden.add(pairing.name);
      }
      return hidden;
    });
  }

  function openExperimentGraphGroup(groupId: string) {
    const group = selectedExperimentGraphGroups.find((item) => item.id === groupId);
    if (!group) return;
    const includedPairings = new Set(group.pairingNames);
    setSelectedExperimentGraphGroupId(groupId);
    setPotPreset("custom");
    setSelectedSeriesName(null);
    setHiddenPots(new Set(
      sortedPairings
        .filter((pairing) => !includedPairings.has(pairing.name))
        .map((pairing) => pairing.name),
    ));
    setExperimentGraphMode("vwc");
    setGraphExpanded(true);
  }

  function togglePot(name: string) {
    setPotPreset("custom");
    setSelectedSeriesName(name);
    setHiddenPots((current) => {
      const allNames = sortedPairings.map((pairing) => pairing.name);
      const visibleCount = allNames.filter((pairingName) => !current.has(pairingName)).length;

      if (visibleCount === allNames.length) {
        return new Set(allNames.filter((pairingName) => pairingName !== name));
      }

      const next = new Set(current);
      if (next.has(name)) {
        next.delete(name);
      } else if (visibleCount > 1) {
        next.add(name);
      }
      return next;
    });
  }

  function setGroupVisibility(pairings: PairingRow[], visible: boolean) {
    setPotPreset("custom");
    setHiddenPots((current) => {
      const next = new Set(current);
      for (const pairing of pairings) {
        if (visible) next.delete(pairing.name);
        else next.add(pairing.name);
      }
      return next;
    });
  }

  function startPanelDrag(event: PointerEvent<HTMLElement>) {
    if (!graphExpanded || !dashboardMainRef.current || !controlPanelRef.current) return;
    const containerRect = dashboardMainRef.current.getBoundingClientRect();
    const panelRect = controlPanelRef.current.getBoundingClientRect();
    const dragOffset = {
      x: event.clientX - panelRect.left,
      y: event.clientY - panelRect.top,
    };
    panelDragOffsetRef.current = dragOffset;
    setPanelPosition({
      x: panelRect.left - containerRect.left,
      y: panelRect.top - containerRect.top,
    });

    const movePanel = (moveEvent: globalThis.PointerEvent) => {
      if (!dashboardMainRef.current || !controlPanelRef.current) return;
      const currentContainerRect = dashboardMainRef.current.getBoundingClientRect();
      const currentPanelRect = controlPanelRef.current.getBoundingClientRect();
      const nextX = moveEvent.clientX - currentContainerRect.left - dragOffset.x;
      const nextY = moveEvent.clientY - currentContainerRect.top - dragOffset.y;
      setPanelPosition({
        x: Math.max(8, Math.min(nextX, currentContainerRect.width - currentPanelRect.width - 8)),
        y: Math.max(8, Math.min(nextY, currentContainerRect.height - currentPanelRect.height - 8)),
      });
    };

    const stopPanel = () => {
      panelDragOffsetRef.current = null;
      window.removeEventListener("pointermove", movePanel);
      window.removeEventListener("pointerup", stopPanel);
      window.removeEventListener("pointercancel", stopPanel);
    };

    window.addEventListener("pointermove", movePanel);
    window.addEventListener("pointerup", stopPanel);
    window.addEventListener("pointercancel", stopPanel);
  }

  function startPanelResize(event: PointerEvent<HTMLElement>) {
    if (!graphExpanded || !dashboardMainRef.current || !controlPanelRef.current) return;
    event.preventDefault();
    event.stopPropagation();

    const startX = event.clientX;
    const startY = event.clientY;
    const containerRect = dashboardMainRef.current.getBoundingClientRect();
    const panelRect = controlPanelRef.current.getBoundingClientRect();
    const startPanelX = panelRect.left - containerRect.left;
    const startPanelY = panelRect.top - containerRect.top;
    const maxWidth = Math.max(minExpandedPanelSize.width, containerRect.width - 16);
    const maxHeight = Math.max(minExpandedPanelSize.height, containerRect.height - 16);

    const resizePanel = (moveEvent: globalThis.PointerEvent) => {
      const nextWidth = panelRect.width + moveEvent.clientX - startX;
      const nextHeight = panelRect.height + moveEvent.clientY - startY;
      const width = Math.max(minExpandedPanelSize.width, Math.min(nextWidth, maxWidth));
      const height = Math.max(minExpandedPanelSize.height, Math.min(nextHeight, maxHeight));
      setPanelSize({
        width,
        height,
      });
      setPanelPosition({
        x: Math.max(8, Math.min(startPanelX, containerRect.width - width - 8)),
        y: Math.max(8, Math.min(startPanelY, containerRect.height - height - 8)),
      });
    };

    const stopResize = () => {
      window.removeEventListener("pointermove", resizePanel);
      window.removeEventListener("pointerup", stopResize);
      window.removeEventListener("pointercancel", stopResize);
    };

    window.addEventListener("pointermove", resizePanel);
    window.addEventListener("pointerup", stopResize);
    window.addEventListener("pointercancel", stopResize);
  }

  function toggleExpandedGraph() {
    setGraphExpanded((expanded) => !expanded);
  }

  async function prepareCsvDownload() {
    setExportingCsv(true);
    setCsvDownload(null);
    setCsvError(null);

    try {
      const readings = dedupeReadingsForExport(data.readings);
      if (readings.length === 0) {
        throw new Error("Readings are still loading. Try again after the chart appears.");
      }
      const headers = [
        "source",
        "event_id",
        "pairing_name",
        "plant_group",
        "treatment",
        "zone",
        "pot_number",
        "sensor_key",
        "device_recorded_at",
        "server_received_at",
        "calibrated_vwc",
        "raw_value",
        "temperature",
        "electrical_conductivity",
      ];
      const rows = readings.map((reading) => {
        const pairing = pairingByName.get(reading.pairing_name);
        return [
          sourceLabelForReading(reading),
          reading.event_id,
          reading.pairing_name,
          pairing ? plantGroupLabel(plantGroupForPairing(pairing, selectedExperiment)) : "",
          pairing ? treatmentLabel(treatmentForPairing(pairing, selectedExperiment)) : "",
          pairing?.zone ?? "",
          pairing?.pot_number ?? "",
          reading.sensor_key,
          reading.device_recorded_at,
          reading.server_received_at,
          reading.calibrated_value,
          reading.raw_value,
          reading.temperature,
          reading.electrical_conductivity,
        ].map(csvEscape).join(",");
      });
      const csv = [headers.join(","), ...rows].join("\n");
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      setCsvDownload({
        url,
        filename: `exacth2o-readings-loaded-${new Date().toISOString().slice(0, 10)}.csv`,
        rowCount: readings.length,
      });
    } catch (err) {
      setCsvError(errorMessage(err));
    } finally {
      setExportingCsv(false);
    }
  }

  function downloadPairingsCsv() {
    const headers = [
      "name",
      "zone",
      "pot_number",
      "plant_group",
      "treatment",
      "sensor_key",
      "valve_key",
      "target_vwc",
      "valve_open_seconds",
      "measurement_interval_seconds",
      "calibration",
    ];
    const rows = sortedPairings.map((pairing) => [
      pairing.name,
      pairing.zone,
      pairing.pot_number,
      plantGroupLabel(plantGroupForPairing(pairing, selectedExperiment)),
      treatmentLabel(treatmentForPairing(pairing, selectedExperiment)),
      pairing.sensor_key,
      pairing.valve_key,
      formatTargetVwc(pairing.wtc_percent_limit),
      Number((pairing.valve_open_time_ms / 1000).toFixed(3)),
      Number((pairing.measurement_interval_ms / 1000).toFixed(3)),
      pairingCalibrationName(pairing),
    ].map(csvEscape).join(","));
    const csv = [headers.join(","), ...rows].join("\n");
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

  useEffect(() => {
    const rememberedEmail = window.localStorage.getItem(rememberEmailKey);
    if (rememberedEmail) {
      setEmail(rememberedEmail);
      setRememberDevice(true);
    }

    let active = true;
    const { data: authListener } = supabase.auth.onAuthStateChange((event, session) => {
      if (!active || authMode === "set-password" || authMode === "accept-invite") return;
      setSessionReady(Boolean(session));
      if (session && (event === "SIGNED_IN" || event === "TOKEN_REFRESHED")) {
        setSessionRevision((current) => current + 1);
      }
    });

    void supabase.auth.getSession().then(({ data: sessionData }) => {
      if (!active || authMode === "set-password" || authMode === "accept-invite") return;
      setSessionReady(Boolean(sessionData.session));
    });

    return () => {
      active = false;
      authListener.subscription.unsubscribe();
    };
  }, [authMode]);

  useEffect(() => {
    if (!sessionReady) return undefined;

    let hiddenSinceMs: number | null = document.visibilityState === "visible" ? null : Date.now();
    // Returning to the tab revalidates the session and reconciles once. Focus, visibility,
    // pageshow and online events arrive in bursts; they collapse into one incremental check
    // (a full reload only after a long absence) at most every 30 seconds.
    const reconcile = createCoalescedTrigger(async () => {
      const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
      if (sessionError || !sessionData.session) {
        expirePortalSession();
        return;
      }
      const expiresAtMs = (sessionData.session.expires_at ?? 0) * 1000;
      if (expiresAtMs <= Date.now() + 60_000) {
        const recovered = await recoverPortalSession();
        if (!recovered) return;
      }
      const longAbsence = hiddenSinceMs != null && Date.now() - hiddenSinceMs > longAbsenceFullReloadMs;
      hiddenSinceMs = null;
      await Promise.allSettled([
        refresh({ incremental: !longAbsence }),
        loadValveEvents({ incremental: !longAbsence }),
      ]);
    }, {
      minSpacingMs: returnReconcileSpacingMs,
      // A hidden or offline tab does not use up the spacing: the trigger after it still runs.
      canRun: () => document.visibilityState === "visible" && navigator.onLine,
    });
    reconcile.markRun();

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") reconcile.trigger("visibilitychange");
      else hiddenSinceMs ??= Date.now();
    };
    // Coming back online may follow missed realtime rows, so it is never held back by the spacing.
    const onReturn = (event: Event) => reconcile.trigger(event.type, { bypassSpacing: event.type === "online" });
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("online", onReturn);
    window.addEventListener("focus", onReturn);
    window.addEventListener("pageshow", onReturn);
    return () => {
      reconcile.cancel();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("online", onReturn);
      window.removeEventListener("focus", onReturn);
      window.removeEventListener("pageshow", onReturn);
    };
  }, [
    expirePortalSession,
    loadValveEvents,
    recoverPortalSession,
    refresh,
    sessionReady,
  ]);

  useEffect(() => {
    // A refresh superseded by a scope change (sign-out, expiry, another project or device) skips its
    // own loading reset, and the sign-in form shares that flag. Clear it here; the refresh for the
    // new scope, declared below, sets it again. A request being tracked belongs to the old scope.
    setLoading(false);
    setTrackedCommand(null);
    // Check outcomes belong to the previous account, project or device.
    setLastSuccessfulCheckAt(null);
    setRefreshFailedAt(null);
  }, [scopeKey]);

  useEffect(() => {
    if (!sessionReady || !canReadProjectData) return;
    void refresh({ incremental: false });
  }, [canReadProjectData, refresh, selectedMode, sessionReady, sessionRevision]);

  useEffect(() => {
    if (!sessionReady) {
      setPortalAccess(null);
      setSettingsOpen(false);
      setSettingsSection("overview");
      setExperimentBuilderOpen(false);
      setEditingExperiment(null);
      setExperimentBuilderPrompt("");
      setSettingsAssistantPrompt("");
      setHealthSnapshot(null);
      setHealthHistory([]);
      setRuntimeState(null);
      setConfigState(null);
      setValveEvents([]);
      setSalesSupportData(initialSalesSupportData);
      setData(initialLoadState);
      dataRef.current = initialLoadState;
      valveEventsRef.current = [];
      return;
    }
    void loadPortalAccess();
  }, [loadPortalAccess, sessionReady]);

  useEffect(() => {
    if (!sessionReady || !canReadProjectData) return;
    void loadExperimentCatalog();
  }, [canReadProjectData, loadExperimentCatalog, sessionReady, sessionRevision]);

  useEffect(() => {
    if (!sessionReady || !isAdmin) return;
    void loadHealthSnapshot();
  }, [isAdmin, loadHealthSnapshot, sessionReady]);

  useEffect(() => {
    if (!sessionReady || !canReadProjectData) return;
    void loadValveEvents();
  }, [
    activeDeviceId,
    activeProjectId,
    canReadProjectData,
    loadValveEvents,
    sessionReady,
  ]);

  useEffect(() => {
    if (
      !sessionReady ||
      !canReadProjectData ||
      portalView !== "experiment" ||
      experimentGraphMode === "vwc"
    ) return;
    void loadValveEvents();
  }, [
    canReadProjectData,
    experimentGraphMode,
    loadValveEvents,
    portalView,
    sessionReady,
  ]);

  useEffect(() => {
    if (!sessionReady || !canUseExperimentSettings) return;
    void loadDeviceSyncState();
  }, [canUseExperimentSettings, loadDeviceSyncState, sessionReady]);

  useEffect(() => {
    if (!sessionReady || !isAdmin) return;
    void loadSalesSupport();
  }, [isAdmin, loadSalesSupport, sessionReady]);

  useEffect(() => {
    if (!sessionReady || !isAdmin) return undefined;
    return scheduleVisiblePolling(() => loadHealthSnapshot({ silent: true }), healthSnapshotPollMs);
  }, [isAdmin, loadHealthSnapshot, sessionReady]);

  useEffect(() => {
    if (!sessionReady || !canReadProjectData || !activeProjectId || !activeDeviceId) return undefined;
    // Realtime inserts carry new events; this poll only backstops a dropped subscription.
    return scheduleVisiblePolling(() => loadValveEvents({ incremental: true }), healthSnapshotPollMs, { catchUpOnVisible: false });
  }, [
    activeDeviceId,
    activeProjectId,
    canReadProjectData,
    loadValveEvents,
    sessionReady,
  ]);

  useEffect(() => {
    if (!sessionReady || !canUseExperimentSettings) return undefined;
    // Controller state gates reviewed settings; it is refreshed immediately on return to the tab.
    return scheduleVisiblePolling(loadDeviceSyncState, healthSnapshotPollMs);
  }, [canUseExperimentSettings, loadDeviceSyncState, sessionReady]);

  useEffect(() => {
    if (!sessionReady || !isAdmin) return undefined;
    return scheduleVisiblePolling(() => loadSalesSupport({ silent: true }), supportPollMs);
  }, [isAdmin, loadSalesSupport, sessionReady]);

  useEffect(() => {
    if (!sessionReady || !canReadProjectData) return undefined;
    // Visible-tab watchdog alongside realtime; the return-to-tab handler reconciles after hidden time.
    return scheduleVisiblePolling(() => {
      watchdogRefreshCountRef.current += 1;
      const fullReconciliation =
        watchdogRefreshCountRef.current % fullReconciliationEveryPolls === 0;
      return refresh({ incremental: !fullReconciliation });
    }, autoRefreshMs, { catchUpOnVisible: false });
  }, [canReadProjectData, refresh, sessionReady]);

  useEffect(() => {
    if (!sessionReady || !canReadProjectData) return undefined;

    const shouldApplyReading = (reading: Partial<SensorReading> | null | undefined) => {
      if (!reading || isIgnoredDiagnosticReading(reading)) return false;
      const eventId = reading.event_id;
      if (typeof eventId !== "string") return false;
      if (selectedMode === "combined" || selectedMode === "auto") return true;
      if (selectedMode === "live") return eventId.startsWith("live-device:");
      return eventId.startsWith("balena-export-v2:");
    };

    // A controller reports every pot at once; apply each burst as one merge and one redraw.
    let pendingRows: Array<SensorReading & { device_id?: string }> = [];
    let flushTimer: number | null = null;
    const scope = scopeKeyRef.current;
    const flushRows = () => {
      flushTimer = null;
      const rows = pendingRows;
      pendingRows = [];
      if (!rows.length || scopeKeyRef.current !== scope) return;
      const nowIso = new Date().toISOString();
      const switchingToLive =
        selectedMode === "auto" &&
        rows.some((row) => row.event_id.startsWith("live-device:")) &&
        dataRef.current.effectiveMode !== "live";
      setData((current) => {
        const hasLive = rows.some((row) => row.event_id.startsWith("live-device:"));
        const accepted = selectedMode === "auto" && current.effectiveMode === "live"
          ? rows.filter((row) => row.event_id.startsWith("live-device:"))
          : rows;
        if (!accepted.length) return current;
        const effectiveMode = selectedMode === "auto" && hasLive ? "live" : current.effectiveMode;
        const next = readingsState(current, mergeRollingExperimentReadings(current.readings, accepted), accepted, nowIso, effectiveMode);
        const newestReceived = accepted.reduce<string | null>(
          (latest, row) => (row.server_received_at && (!latest || row.server_received_at > latest) ? row.server_received_at : latest),
          null,
        );
        return {
          ...next,
          latestIngestTime: newestReceived ?? current.latestIngestTime,
        };
      });
      if (switchingToLive) void refresh({ incremental: false });
    };

    const channel = supabase
      .channel(`exacth2o-dashboard-live-${activeProjectId}-${selectedMode}-${crypto.randomUUID()}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "sensor_readings",
          filter: `project_id=eq.${activeProjectId}`,
        },
        (payload) => {
          const row = payload.new as SensorReading & { device_id?: string };
          if (row.device_id !== activeDeviceId || !shouldApplyReading(row)) return;
          pendingRows.push(row);
          flushTimer ??= window.setTimeout(flushRows, realtimeBatchMs);
        },
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "latest_device_state",
          filter: `device_id=eq.${activeDeviceId}`,
        },
        (payload) => {
          const row = payload.new as LatestState;
          if (row.device_id !== activeDeviceId) return;
          setData((current) => ({
            ...current,
            latestState: row,
            latestIngestTime: row.updated_at ?? current.latestIngestTime,
            lastCheckedAt: new Date().toISOString(),
          }));
        },
      )
      .subscribe();

    return () => {
      if (flushTimer != null) window.clearTimeout(flushTimer);
      pendingRows = [];
      void supabase.removeChannel(channel);
    };
  }, [
    activeDeviceId,
    activeProjectId,
    canReadProjectData,
    refresh,
    sessionReady,
    selectedMode,
  ]);

  useEffect(() => {
    if (!sessionReady || !isAdmin || !activeProjectId || !activeDeviceId) return undefined;

    const channel = supabase
      .channel(`exacth2o-health-live-${activeProjectId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "device_health_snapshots",
          filter: `project_id=eq.${activeProjectId}`,
        },
        (payload) => {
          const row = payload.new as Partial<DeviceHealthSnapshot>;
          if (row.device_id !== activeDeviceId || row.ingest_complete !== true) return;
          setHealthHistory((current) => {
            const next = row as DeviceHealthSnapshot;
            const byId = new Map(current.map((item) => [item.id, item]));
            byId.set(next.id, next);
            return Array.from(byId.values())
              .sort((left, right) => Date.parse(right.captured_at) - Date.parse(left.captured_at))
              .slice(0, 300);
          });
          setHealthSnapshot((current) => selectHealthSnapshot([
            row as DeviceHealthSnapshot,
            ...(current ? [current] : []),
          ]));
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [activeDeviceId, activeProjectId, isAdmin, loadHealthSnapshot, sessionReady]);

  useEffect(() => {
    if (!sessionReady || !canUseExperimentSettings || !activeProjectId || !activeDeviceId) return undefined;

    const channel = supabase
      .channel(`exacth2o-device-sync-live-${activeProjectId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "device_runtime_state",
          filter: `project_id=eq.${activeProjectId}`,
        },
        (payload) => {
          const row = payload.new as Partial<DeviceRuntimeState>;
          if (row.device_id === activeDeviceId) {
            setRuntimeState(row as DeviceRuntimeState);
            return;
          }
          void loadDeviceSyncState();
        },
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "device_config_state",
          filter: `project_id=eq.${activeProjectId}`,
        },
        (payload) => {
          const row = payload.new as Partial<DeviceConfigState>;
          if (row.device_id === activeDeviceId) {
            setConfigState(row as DeviceConfigState);
            return;
          }
          void loadDeviceSyncState();
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [
    activeDeviceId,
    activeProjectId,
    canUseExperimentSettings,
    loadDeviceSyncState,
    sessionReady,
  ]);

  const trackedCommandIds = trackedCommand?.ids.join(",") ?? "";
  const trackedCommandSettled = trackedCommand
    ? trackedCommand.trackingStopped === true || trackedCommandProgress(trackedCommand, true).terminal
    : true;
  useEffect(() => {
    // Backstop for a missed realtime update: re-read the tracked commands until they finish.
    if (!sessionReady || !activeProjectId || !trackedCommandIds || trackedCommandSettled) return undefined;
    const ids = trackedCommandIds.split(",");
    const startedAt = Date.now();
    return scheduleVisiblePolling(async () => {
      if (Date.now() - startedAt > trackedCommandPollLimitMs) {
        // Say so rather than leaving an unfinished stage on screen indefinitely.
        setTrackedCommand((current) => current && current.ids.join(",") === trackedCommandIds
          ? { ...current, trackingStopped: true }
          : current);
        return;
      }
      const response = await withSupabaseTimeout(
        supabase.from("project_control_commands").select("id,status").eq("project_id", activeProjectId).in("id", ids),
        supabaseQueryTimeoutMs,
        "Command status",
      );
      if (response.error || !response.data) return;
      const rows = response.data as Array<{ id: string; status?: unknown }>;
      setTrackedCommand((current) => {
        if (!current || current.ids.join(",") !== trackedCommandIds) return current;
        const statuses = { ...current.statuses };
        for (const row of rows) if (isCommandStatus(row.status)) statuses[row.id] = row.status;
        return { ...current, statuses };
      });
    }, trackedCommandPollMs);
  }, [activeProjectId, sessionReady, trackedCommandIds, trackedCommandSettled]);

  useEffect(() => {
    if (!sessionReady || !canUseExperimentSettings || !activeProjectId) return undefined;

    const channel = supabase
      .channel(`exacth2o-control-activity-live-${activeProjectId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "project_control_commands",
          filter: `project_id=eq.${activeProjectId}`,
        },
        (payload) => {
          const row = payload.new as { id?: string; status?: unknown } | null;
          if (row?.id && isCommandStatus(row.status)) {
            const status = row.status;
            setTrackedCommand((current) => current && current.ids.includes(row.id as string)
              ? { ...current, statuses: { ...current.statuses, [row.id as string]: status } }
              : current);
          }
          void loadExperimentCatalog();
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [
    canUseExperimentSettings,
    activeProjectId,
    loadExperimentCatalog,
    sessionReady,
  ]);

  useEffect(() => {
    if (!sessionReady || !canReadProjectData || !activeProjectId || !activeDeviceId) return undefined;

    const channel = supabase
      .channel(`exacth2o-valve-events-live-${activeProjectId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "valve_events",
          filter: `project_id=eq.${activeProjectId}`,
        },
        (payload) => {
          const row = payload.new as ValveEvent;
          if (row.device_id !== activeDeviceId || isIgnoredDiagnosticValveEvent(row)) return;
          setValveEvents((current) => mergeValveEventRows(current, [row]));
        },
      )
      .subscribe((status) => {
        // Catch rows written between the initial load and the subscription becoming active.
        // A query already running may have started before the subscription went live, so this
        // one must start after it.
        if (status === "SUBSCRIBED") void loadValveEvents({ incremental: true, fresh: true });
      });

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [
    activeDeviceId,
    activeProjectId,
    canReadProjectData,
    loadValveEvents,
    sessionReady,
  ]);

  useEffect(() => {
    if (!sessionReady || !isAdmin || !activeProjectId) return undefined;

    const channel = supabase
      .channel(`exacth2o-sales-support-live-${activeProjectId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "support_threads",
          filter: `project_id=eq.${activeProjectId}`,
        },
        () => {
          void loadSalesSupport({ silent: true });
        },
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "quote_requests",
          filter: `project_id=eq.${activeProjectId}`,
        },
        () => {
          void loadSalesSupport({ silent: true });
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [activeProjectId, isAdmin, loadSalesSupport, sessionReady]);

  if (!sessionReady) {
    const isInviteAccept = authMode === "accept-invite";
    const isPasswordSetup = authMode === "set-password";
    const showTermsAgreement = !isPasswordSetup;
    const termsRequired = isInviteAccept;
    const authTitle = isPasswordSetup ? "Set Password" : isInviteAccept ? "Accept Invite" : "Sign In";
    const authNote = isPasswordSetup
      ? "Choose a password for this exactH2O account."
      : isInviteAccept
        ? "Use the invited email and choose a password."
        : "Use your exactH2O account.";
    const authSubmitText = loading
      ? isPasswordSetup
        ? "Saving..."
        : isInviteAccept
          ? "Accepting..."
          : "Signing in..."
      : isPasswordSetup
        ? "Save Password"
        : isInviteAccept
          ? "Accept Invite"
          : "Open Dashboard";

    return (
      <main className="portal-login-shell">
        <header className="portal-topbar">
          <a href="/" className="portal-logo" aria-label="ExactH2O website home">
            <img src={exactH2OLogo} alt="ExactH2O" />
          </a>
          <div className="portal-top-links">
            <a href="/support">Support</a>
          </div>
        </header>

        <section className="portal-login-panel" aria-label="Portal sign in">
          <div className="portal-login-card">
            <h2>{authTitle}</h2>
            <p className="portal-login-note">{authNote}</p>

            <form onSubmit={isPasswordSetup ? setAccountPassword : isInviteAccept ? acceptInvite : signIn}>
              {!isPasswordSetup ? (
                <div className="portal-form-group">
                  <label htmlFor="portalEmail">Email</label>
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
              ) : null}
              <div className="portal-form-group">
                <label htmlFor="portalPassword">Password</label>
                <input
                  id="portalPassword"
                  name="password"
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete={isInviteAccept || isPasswordSetup ? "new-password" : "current-password"}
                  required
                />
              </div>
              <div className="portal-form-row">
                {!isPasswordSetup ? (
                  <label className="portal-check">
                    <input
                      type="checkbox"
                      name="remember"
                      checked={rememberDevice}
                      onChange={(event) => setRememberDevice(event.target.checked)}
                    />
                    <span>Remember</span>
                  </label>
                ) : (
                  <span />
                )}
                {isInviteAccept || isPasswordSetup ? (
                  <button
                    className="portal-inline-action"
                    type="button"
                    onClick={() => switchAuthMode("sign-in")}
                  >
                    Sign in
                  </button>
                ) : (
                  <span />
                )}
              </div>
              {showTermsAgreement ? (
                <div className="portal-terms-prompt">
                  <label className="portal-check portal-terms-check">
                    <input
                      type="checkbox"
                      name="terms"
                      checked={termsAccepted}
                      onChange={(event) => {
                        if (event.target.checked) {
                          setTermsOpen(true);
                          return;
                        }
                        setTermsAccepted(false);
                      }}
                    />
                    <span>
                      I agree to the{" "}
                      <button
                        type="button"
                        className="portal-inline-action"
                        onClick={() => setTermsOpen(true)}
                      >
                        Software Access Terms
                      </button>
                      .
                    </span>
                  </label>
                  <p>
                    {termsRequired
                      ? "Required before accepting this invite."
                      : "Invite users will review and accept these terms before access."}
                  </p>
                </div>
              ) : null}
              <button
                className="portal-submit-btn"
                type="submit"
                disabled={loading || (!isPasswordSetup && !email) || !password || (termsRequired && !termsAccepted)}
              >
                {authSubmitText}
              </button>
              {authNotice ? <p className="portal-success-line">{authNotice}</p> : null}
              {loginError ? <p className="portal-error-line">{loginError}</p> : null}
            </form>

            <div className="portal-support-line">
              Need access? Ask for an invite or contact{" "}
              <a href={`mailto:${supportEmail}`}>{supportEmail}</a>.
            </div>
          </div>
        </section>
        <SoftwareTermsModal
          open={termsOpen}
          accepted={termsAccepted}
          onAgree={() => setTermsAccepted(true)}
          onClose={() => setTermsOpen(false)}
        />
      </main>
    );
  }

  const groupedPairings = Array.from(
    sortedPairings.reduce((groups, pairing) => {
      const current = groups.get(pairing.zone) ?? [];
      current.push(pairing);
      groups.set(pairing.zone, current);
      return groups;
    }, new Map<number, PairingRow[]>()),
  ).sort(([zoneA], [zoneB]) => zoneA - zoneB);
  const hasExperimentGraphOverview = selectedExperimentGraphGroups.length > 1;
  // Group comparison cards were replaced by the Waterline overview tab; Pots shows every pot.
  const showExperimentGraphOverview = false;
  const activeExperimentGraphGroup = selectedExperimentGraphGroups.find(
    (group) => group.id === selectedExperimentGraphGroupId,
  ) ?? selectedExperimentGraphGroups[0];
  const controlPanelStyle: CSSProperties | undefined = graphExpanded
    ? {
        width: panelSize.width,
        height: panelSize.height,
        ...(panelPosition
          ? { left: panelPosition.x, top: panelPosition.y, right: "auto" }
          : {}),
      }
    : undefined;
  const showSettingsControl = canUseExperimentSettings;
  const productSections = { bench: true, workbench: true };
  const recordAvailable = true;
  const visiblePairings = visibleExperimentPairings(data.pairings);
  const lastGoodCheckAt = lastSuccessfulCheckAt ?? (data.lastCheckedAt && !error ? Date.parse(data.lastCheckedAt) : null);
  const presence = runtimeState
    ? controllerPresence({
      stateFreshUntil: runtimeState.state_fresh_until,
      stateObservedAt: runtimeState.state_observed_at,
      controllerState: runtimeState.controller_state,
      lastSeenAt: data.latestState?.last_seen_at ?? data.latestState?.updated_at,
    }, clockNowMs)
    : null;
  const presenceLastSeenMs = presence?.lastSeenAt ? Date.parse(presence.lastSeenAt) : null;
  const installationState: InstallationState = !presence
    ? { status: "hidden" }
    : presence.status === "offline"
      ? { status: "offline", lastSeenAt: presenceLastSeenMs }
      : presence.status === "never"
        ? { status: "unknown" }
        : { status: "online" };
  const portalExceptions = homeExceptions({
    experiments: availableExperiments,
    pairings: visiblePairings,
    readings: data.readings,
    nowMs: clockNowMs,
    checked: lastGoodCheckAt != null,
    refresh: { failedAt: refreshFailedAt, lastSuccessAt: lastGoodCheckAt },
    controller: presence ? { offline: presence.status === "offline", lastSeenAt: presenceLastSeenMs } : null,
    formatTime: (ms) => formatMeasurementTime(ms) ?? "",
  });
  const dataSourceLabel = data.effectiveMode === "live" ? "live controller readings" : "imported snapshot readings";
  const routeExperiment = route.view === "experiment"
    ? availableExperiments.find((experiment) => experiment.id === route.experiment) ?? null
    : null;
  const catalogReady = experimentCatalog.length > 0 || experimentCatalogError != null || (!loading && lastGoodCheckAt != null);

  const portalActions = (
    <div className="header-actions">
      {portalAccess ? (
        <button className="header-action" type="button" onClick={signOut}>
          Sign out
        </button>
      ) : null}
    </div>
  );

  const experimentBuilder = experimentBuilderOpen && canCreateExperiment ? (
    <FeatureBoundary name="Experiment builder"><ExperimentBuilder
      key={editingExperiment?.currentRevisionId ?? "new-experiment"}
      projectId={activeProjectId}
      pairings={visibleExperimentPairings(data.pairings)}
      experiments={availableExperiments}
      inventoryUpdatedAt={configState?.updated_at ?? null}
      initialPrompt={experimentBuilderPrompt}
      direct
      experiment={editingExperiment}
      onClose={() => {
        setExperimentBuilderOpen(false);
        setEditingExperiment(null);
        setExperimentBuilderPrompt("");
      }}
      onCreated={async (slug) => {
        await loadExperimentCatalog();
        setExperimentBuilderOpen(false);
        setEditingExperiment(null);
        setExperimentBuilderPrompt("");
        openExperiment(slug);
      }}
    /></FeatureBoundary>
  ) : null;

  const portalHeader = (
    <header className="dashboard-header">
      <a
        className="dashboard-logo"
        href="/"
        aria-label="ExactH2O website home"
      >
        <img src={exactH2OLogo} alt="ExactH2O" />
      </a>
      <div className="portal-header-right">
        {portalActions}
      </div>
    </header>
  );

  if (accessLoading && !portalAccess) {
    return (
      <main className="dashboard-shell portal-admin-shell">
        {portalHeader}
        <section className="portal-loading-screen">
          <Loader2 className="chart-loading-spinner" size={32} aria-hidden="true" />
        </section>
      </main>
    );
  }

  if (!portalAccess) {
    return (
      <main className="dashboard-shell portal-admin-shell">
        {portalHeader}
        <section className="portal-loading-screen" aria-live="polite">
          <ShieldCheck size={32} aria-hidden="true" />
          <p>This account does not currently have portal access.</p>
          <button className="header-action" type="button" onClick={() => void signOut()}>
            Sign out
          </button>
        </section>
      </main>
    );
  }

  if (!isAdmin && portalView === "chamber" && portalAccess.gasMixerAllowed) {
    return <GasMixerResearcherView onBack={() => setPortalView("home")} />;
  }

  if (!projectAccess) {
    return (
      <main className="dashboard-shell portal-admin-shell">
        {portalHeader}
        <GasMixerResearcherHome
          allowed={portalAccess.gasMixerAllowed}
          onOpen={() => setPortalView("chamber")}
        />
      </main>
    );
  }

  const potsTabContent = (
    <>
      {error && !data.readings.length ? (
        <div className="banner error" role="alert">
          <AlertTriangle size={18} />
          Readings could not be loaded: {error}
        </div>
      ) : null}

      <MeasurementStatusBar
        freshness={experimentStatusFreshness}
        checkedAt={data.lastCheckedAt}
        refreshing={loading && series.some((item) => item.points.length > 0)}
        reportingPots={reportingPotCount}
        totalPots={sortedPairings.length}
        fetchError={data.readings.length ? error : null}
        progress={experimentProgressText(selectedExperiment, clockNowMs)}
      />

      <section
        ref={dashboardMainRef}
        className={`dashboard-main ${graphExpanded ? "is-expanded" : ""} ${showExperimentGraphOverview ? "is-experiment-overview" : ""}`}
      >
        {showExperimentGraphOverview ? (
          <section className="experiment-graph-overview">
            <div className="experiment-graph-toolbar">
              <div className="chart-view-toggle" aria-label="Graph view">
                <button type="button" className="is-selected">
                  VWC
                </button>
                <button
                  type="button"
                  onClick={() => setExperimentGraphMode("watering")}
                >
                  Watering
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setSelectedWateringDetail(null);
                    setExperimentGraphMode("overlay");
                  }}
                >
                  Overlay
                </button>
              </div>
            </div>
            <div className="experiment-graph-grid">
              {selectedExperimentGraphGroups.map((group) => {
                const target = groupTargets.get(group.id);
                const comparison = groupComparisons.get(group.id);
                const nowText = comparison?.latestMedian == null
                  ? "No readings in range"
                  : `Latest ${formatVwcReading(comparison.latestMedian)} median${comparison.reportingCount > 1 ? ` (${formatVwcReading(comparison.latestMin)}–${formatVwcReading(comparison.latestMax)})` : ""}${comparison.silentCount ? ` · ${comparison.silentCount} ${comparison.silentCount === 1 ? "pot" : "pots"} not reporting` : ""}`;
                return (
                  <button
                    type="button"
                    className="experiment-graph-card"
                    key={group.id}
                    aria-label={`Expand ${group.label} graph. ${target?.detail ?? ""} ${nowText}.`}
                    onClick={() => openExperimentGraphGroup(group.id)}
                  >
                    <span className="experiment-graph-card-head">
                      <strong>{group.label}</strong>
                      <em>{group.pairingNames.length} pots</em>
                      <Maximize2 size={16} aria-hidden="true" />
                      <span className="graph-card-facts">
                        {target ? (
                          <span className={`graph-target ${target.planMismatch ? "is-warning" : ""}`} title={target.detail}>
                            {target.label}
                          </span>
                        ) : null}
                        <span className="graph-now">{nowText}</span>
                      </span>
                    </span>
                    <span className="experiment-graph-chart">
                      <SensorCanvasChart
                        series={timeFilteredSeries}
                        visibleNames={groupVisibleNameSets.get(group.id) ?? emptyNameSet}
                        selectedName={null}
                        viewMode="traces"
                        onSelectSeries={ignoreSeriesSelection}
                        loading={loading && !series.some((item) => item.points.length)}
                        xDomain={selectedVwcTimeBounds}
                        compact
                        targetLines={groupTargetLines.get(group.id)}
                      />
                    </span>
                  </button>
                );
              })}
            </div>
            <div className="experiment-graph-range">
              <TimeRangeControl
                bounds={timeBounds}
                value={timeWindow}
                onChange={setTimeWindow}
              />
            </div>
          </section>
        ) : (
          <section className={`chart-card ${experimentGraphMode === "watering" ? "is-watering" : ""}`}>
            {hasExperimentGraphOverview && graphExpanded && experimentGraphMode === "vwc" && activeExperimentGraphGroup ? (
              <div className="expanded-graph-label">
                <strong>{activeExperimentGraphGroup.label}</strong>
                <span>
                  {activeExperimentGraphGroup.pairingNames.length} pots
                  {groupTargets.get(activeExperimentGraphGroup.id)
                    ? ` · ${groupTargets.get(activeExperimentGraphGroup.id)?.label}`
                    : ""}
                </span>
              </div>
            ) : null}
            <div className="chart-tools">
              <div className="chart-view-toggle" aria-label="Graph view">
                <button
                  type="button"
                  className={experimentGraphMode === "vwc" ? "is-selected" : ""}
                  onClick={() => {
                    setSelectedWateringDetail(null);
                    setExperimentGraphMode("vwc");
                  }}
                >
                  VWC
                </button>
                {!isObservationOnlyExperiment(selectedExperiment) ? (
                  <>
                    <button
                      type="button"
                      className={experimentGraphMode === "watering" ? "is-selected" : ""}
                      onClick={() => setExperimentGraphMode("watering")}
                    >
                      Watering
                    </button>
                    <button
                      type="button"
                      className={experimentGraphMode === "overlay" ? "is-selected" : ""}
                      onClick={() => {
                        setSelectedWateringDetail(null);
                        setExperimentGraphMode("overlay");
                      }}
                    >
                      Overlay
                    </button>
                  </>
                ) : null}
              </div>
              <button
                className="expand-button"
                type="button"
                aria-label={graphExpanded ? "Close expanded graph" : "Expand graph"}
                title={graphExpanded ? "Close" : "Expand"}
                onClick={toggleExpandedGraph}
              >
                {graphExpanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
              </button>
            </div>

            <section
              className="chart-panel-main"
              aria-label={
                experimentGraphMode === "watering"
                  ? "Watering activity chart"
                  : experimentGraphMode === "overlay"
                    ? "VWC and watering overlay chart"
                    : "All plants chart"
              }
            >
              {experimentGraphMode === "watering" ? (
                <ResearchWateringActivity
                  events={experimentWateringEvents}
                  pairings={visibleWateringPairings}
                  onSelectDetail={setSelectedWateringDetail}
                />
              ) : (
                <SensorCanvasChart
                  series={timeFilteredSeries}
                  visibleNames={chartVisibleNames}
                  selectedName={selectedSeriesName}
                  viewMode="traces"
                  onSelectSeries={selectPot}
                  loading={loading && !series.some((item) => item.points.length)}
                  xDomain={selectedVwcTimeBounds}
                  wateringEvents={experimentGraphMode === "overlay" ? experimentWateringEvents : undefined}
                  targetLines={visibleTargetLines}
                  describeTarget={describePotTarget}
                  headerSpace={hasExperimentGraphOverview && graphExpanded && experimentGraphMode === "vwc" ? 26 : 0}
                />
              )}
            </section>
            {experimentGraphMode !== "watering" ? (
              <div className="chart-bottom-controls">
                <TimeRangeControl
                  bounds={timeBounds}
                  value={timeWindow}
                  onChange={setTimeWindow}
                />
              </div>
            ) : null}
          </section>
        )}

        {!showExperimentGraphOverview ? (
          <aside
            ref={controlPanelRef}
            className="control-panel"
            style={controlPanelStyle}
          >
          <section>
            {graphExpanded ? (
              <div
                className="control-heading"
                onPointerDown={startPanelDrag}
                aria-label="Move controls"
              >
                <span />
              </div>
            ) : null}
            <div className="preset-buttons research-presets">
              <button
                type="button"
                className={`preset-filter preset-all ${potPreset === "all" ? "is-selected" : ""}`}
                onClick={() => applyPotPreset("all")}
              >
                All
              </button>
              {!isObservationOnlyExperiment(selectedExperiment) && !isCalibrationExperiment(selectedExperiment) ? (
                <>
                  <button
                    type="button"
                    className={`preset-filter preset-control ${potPreset === "control" ? "is-selected" : ""}`}
                    onClick={() => applyPotPreset("control")}
                  >
                    Control
                  </button>
                  <button
                    type="button"
                    className={`preset-filter preset-drought ${potPreset === "drought" ? "is-selected" : ""}`}
                    onClick={() => applyPotPreset("drought")}
                  >
                    Drought
                  </button>
                  <button
                    type="button"
                    className={`preset-filter preset-maize ${potPreset === "maize" ? "is-selected" : ""}`}
                    onClick={() => applyPotPreset("maize")}
                  >
                    Maize
                  </button>
                  <button
                    type="button"
                    className={`preset-filter preset-sorghum ${potPreset === "sorghum" ? "is-selected" : ""}`}
                    onClick={() => applyPotPreset("sorghum")}
                  >
                    Sorghum
                  </button>
                </>
              ) : null}
            </div>
          </section>

          {groupedPairings.map(([zone, groupPairings]) => {
            const plantGroups = new Set(
              groupPairings.map((pairing) => plantGroupForPairing(pairing, selectedExperiment)),
            );
            const plantGroup = plantGroups.size === 1 ? Array.from(plantGroups)[0] : "unknown";
            const label =
              !isObservationOnlyExperiment(selectedExperiment) &&
              !isCalibrationExperiment(selectedExperiment) &&
              plantGroup !== "unknown"
                ? plantGroupLabel(plantGroup)
                : `Zone ${zone}`;
            const allVisible = groupPairings.every((pairing) => !hiddenPots.has(pairing.name));
            return (
              <section className="pot-group" key={zone}>
                <div className="pot-group-head">
                  <h3>{label}</h3>
                  <button
                    type="button"
                    className={`group-toggle ${allVisible ? "is-on" : ""}`}
                    aria-label={`${allVisible ? "Hide" : "Show"} all ${label} pots`}
                    title={allVisible ? "Hide all" : "Show all"}
                    onClick={() => setGroupVisibility(groupPairings, !allVisible)}
                  >
                    <span />
                  </button>
                </div>
                <div>
                  {groupPairings.map((pairing) => {
                    const visible = !hiddenPots.has(pairing.name);
                    const potSeries = seriesByName.get(pairing.name);
                    const latest = latestPoint(potSeries);
                    const latestValue = latest?.value ?? null;
                    const potFreshness = measurementFreshness({
                      measuredAt: latest?.timestampMs,
                      expectedIntervalMs: potSeries?.expectedIntervalMs,
                      completed: experimentIsCompleted(selectedExperiment, clockNowMs),
                      nowMs: clockNowMs,
                    });
                    const showAge = latest != null && potFreshness.state !== "current" && potFreshness.state !== "historical";
                    return (
                      <button
                        key={pairing.name}
                        type="button"
                        className={`pot-toggle ${visible ? "is-on" : ""} ${selectedSeriesName === pairing.name ? "is-selected-pot" : ""}`}
                        onClick={() => togglePot(pairing.name)}
                        aria-label={`Pot ${pairing.pot_number}, ${describeVwcReading(latestValue)}${latest ? `, ${potFreshness.detail}` : ", no readings in the last 72 hours"}`}
                        title={latest ? `${formatMeasurementTime(latest.timestampMs)} · ${potFreshness.detail}` : "No readings in the last 72 hours"}
                      >
                        <span className="color-dot" style={{ background: colorForPairing(pairing) }} />
                        <span className="pot-reading">
                          <b>{pairing.pot_number}</b>
                          <strong>{formatVwcReading(latestValue)}</strong>
                          {showAge ? <span className="pot-age">{formatAge(potFreshness.ageMs)}</span> : null}
                        </span>
                        {!isObservationOnlyExperiment(selectedExperiment) && !isCalibrationExperiment(selectedExperiment) ? (
                          <em className={`treatment-dot ${treatmentForPairing(pairing, selectedExperiment)}`}>
                            {treatmentForPairing(pairing, selectedExperiment) === "control" ? "C" : "D"}
                          </em>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              </section>
            );
          })}
          {graphExpanded ? (
            <button
              type="button"
              className="panel-resize-grip"
              aria-label="Resize controls"
              title="Resize"
              onPointerDown={startPanelResize}
            />
          ) : null}
          </aside>
        ) : null}
      </section>
    </>
  );

  const productHeader = (
    <ProductHeader
      route={route}
      sections={productSections}
      onFindPot={() => setFindPotOpen(true)}
      onOpenSettings={showSettingsControl ? () => {
        prefetchSettings();
        setSettingsOpen(true);
      } : undefined}
      atBench={atBench}
      onToggleAtBench={projectAccess ? () => {
        const next = !atBench;
        setAtBench(next);
        rememberAtBench(next);
        navigatePortal(next ? { view: "pocket", pot: route.view === "pot" ? route.pot : route.view === "experiment" || route.view === "bench" ? route.pot : null, note: false } : { view: "home" });
      } : undefined}
      onSignOut={() => void signOut()}
    />
  );

  const settingsPanel = canUseExperimentSettings && settingsMounted ? (
    <FeatureBoundary name="Settings" hidden={!settingsOpen} resetKey={settingsOpen} fallback={settingsOpen ? <FeatureLoading name="Settings" /> : null}><PortalSettingsPanel
      open={settingsOpen}
      projectId={activeProjectId}
      portalRole={portalAccess.role}
      experiment={selectedExperiment}
      activeSection={settingsSection}
      data={data}
      runtimeState={runtimeState}
      configState={configState}
      pairings={sortedPairings}
      visiblePotCount={visiblePotCount}
      csvDownload={csvDownload}
      csvError={csvError}
      exportingCsv={exportingCsv}
      controlBusy={controlBusy}
      controlNotice={controlNotice}
      commandProgress={trackedCommand ? trackedCommandProgress(trackedCommand, !controllerOffline) : null}
      controlError={controlError}
      assistantInitialPrompt={settingsAssistantPrompt}
      operatorEmail={portalAccess.email ?? null}
      onClose={() => setSettingsOpen(false)}
      onSectionChange={setSettingsSection}
      onPrepareCsvDownload={prepareCsvDownload}
      onDownloadPairingsCsv={downloadPairingsCsv}
      onQueueCommand={queueControlCommand}
      onQueueSettingsPlan={queueSettingsPlan}
      onSignOut={signOut}
    /></FeatureBoundary>
  ) : null;

  const findPotDialog = (
    <FindPotDialog
      open={findPotOpen}
      onClose={() => setFindPotOpen(false)}
      pairings={visiblePairings}
      experiments={availableExperiments}
      routeFor={(pairingName) => ({ view: "pot", pot: pairingName })}
    />
  );

  const productShell = (content: ReactNode) => (
    <main className="px-shell">
      {productHeader}
      {content}
      {experimentBuilder}
      {settingsPanel}
      {findPotDialog}
      <HealthSelectedDetailDrawer
        detail={selectedWateringDetail}
        onClose={() => setSelectedWateringDetail(null)}
      />
    </main>
  );

  if (isAdmin && portalView === "analytics") {
    return productShell(
      <FeatureBoundary name="Web Analytics"><WebsiteAnalyticsWorkspace onBack={() => setPortalView("home")} /></FeatureBoundary>,
    );
  }

  if (isAdmin && portalView === "health") {
    return productShell(
      <FeatureBoundary name="System Health">
        <SystemHealthView
          snapshot={healthSnapshot}
          history={healthHistory}
          runtimeState={runtimeState}
          error={healthError}
          onBackHome={() => setPortalView("home")}
        />
      </FeatureBoundary>,
    );
  }

  if (isAdmin && portalView === "support") {
    return (
      <main className="dashboard-shell portal-admin-shell">
        <FeatureBoundary name="Sales & Support">
          <SalesSupportView
            data={salesSupportData}
            loading={salesSupportLoading}
            error={salesSupportError}
            onDeleteQuote={deleteQuoteRequest}
            onBackHome={() => setPortalView("home")}
          />
        </FeatureBoundary>
      </main>
    );
  }

  if (isAdmin && portalView === "walker") {
    return <FeatureBoundary name="Walker observation"><WalkerExperimentView onBack={() => setPortalView("home")} /></FeatureBoundary>;
  }

  if (isAdmin && portalView === "chamber") {
    return <ChamberControlView onBack={() => setPortalView("home")} />;
  }

  if (route.view === "workbench") {
    return productShell(
      <FeatureBoundary name="Workbench" fallback={<FeatureLoading name="Workbench" />}><WorkbenchView
        projectId={activeProjectId}
        deviceId={activeDeviceId}
        userId={portalAccess.userId ?? null}
        authorLabel={portalAccess.email ?? "portal member"}
        experiments={availableExperiments}
        pairings={visiblePairings}
        comparisonId={route.comparison}
        experimentId={route.experiment}
        canSave={canUseExperimentSettings}
        build={portalBuild}
      /></FeatureBoundary>,
    );
  }

  if (route.view === "trends") {
    return productShell(
      <FeatureBoundary name="Trends" fallback={<FeatureLoading name="Trends" />}><TrendsView
        experiments={availableExperiments}
        pairings={visiblePairings}
        readings={data.readings}
        nowMs={clockNowMs}
        asOfMs={lastGoodCheckAt}
        loadedWindowMs={rollingExperimentHistoryMs}
      /></FeatureBoundary>,
    );
  }

  const renderPotPage = (potKey: string, experimentContext: PortalExperiment | null, from: "bench" | null = null) => {
    const boundName = currentBench?.bindings.find((binding) => binding.researchPotId === potKey)?.pairingName ?? null;
    const match = resolvePot(potKey, visiblePairings, availableExperiments, {
      preferExperimentId: experimentContext?.id ?? null,
      boundPairingName: boundName,
      nowMs: clockNowMs,
    });
    if (!match) {
      return (
        <section className="px-page">
          <PortalLink className="px-crumb" to={experimentContext ? { view: "experiment", experiment: experimentContext.id, tab: "pots", pot: null } : { view: "home" }}>
            ← {experimentContext ? experimentContext.name : "Experiments"}
          </PortalLink>
          <p className="px-empty" role={loading ? "status" : "alert"}>
            {loading && !data.pairings.length ? "Loading pots…" : `No pot “${potKey}” on this project's controller.`}
          </p>
        </section>
      );
    }
    const potName = match.pairing.name;
    return (
      <FeatureBoundary name="Pot" fallback={<FeatureLoading name="Pot" />}><PotPage
        match={match}
        readings={data.readings.filter((reading) => reading.pairing_name === potName)}
        valveEvents={valveEvents.filter((event) => event.pairing_name === potName)}
        nowMs={clockNowMs}
        asOfMs={lastGoodCheckAt}
        loadedWindowMs={rollingExperimentHistoryMs}
        backTo={from === "bench"
          ? { label: "Bench", route: { view: "bench", pot: null } }
          : experimentContext
            ? { label: `${experimentContext.name} · Pots`, route: { view: "experiment", experiment: experimentContext.id, tab: "pots", pot: null } }
            : { label: "Experiments", route: { view: "home" } }}
      >
        <FeatureBoundary name="Notes" fallback={<FeatureLoading name="Notes" />}>
          <PotNotesSection
            userId={outboxScope?.userId ?? null}
            projectId={activeProjectId}
            deviceId={activeDeviceId}
            pairingName={potName}
            potNumber={match.pairing.pot_number}
            experimentId={match.current?.databaseId ?? null}
            binding={currentBench?.bindings.find((binding) => binding.pairingName === potName) ?? null}
            canWrite={canWriteNotes}
            outbox={noteOutbox}
          />
        </FeatureBoundary>
      </PotPage></FeatureBoundary>
    );
  };

  const pocketActive = route.view === "pocket" || (atBench && (route.view === "home" || route.view === "pot"));
  if (pocketActive && projectAccess) {
    const pocketPot = route.view === "pocket" ? route.pot : route.view === "pot" ? route.pot : null;
    return (
      <main className="px-shell">
        <FeatureBoundary name="At the bench" fallback={<FeatureLoading name="At the bench" />}>
          <PocketView
            potKey={pocketPot}
            writing={route.view === "pocket" && route.note}
            userId={outboxScope?.userId ?? "signed-out"}
            projectId={activeProjectId}
            deviceId={activeDeviceId}
            canWrite={canWriteNotes}
            pairings={visiblePairings}
            experiments={availableExperiments}
            readings={data.readings}
            bindings={currentBench?.bindings ?? []}
            nowMs={clockNowMs}
            asOfMs={lastGoodCheckAt}
            online={online}
            refreshFailed={refreshFailedAt != null && (lastGoodCheckAt == null || refreshFailedAt > lastGoodCheckAt)}
            outbox={noteOutbox}
            onLeave={() => {
              setAtBench(false);
              rememberAtBench(false);
              navigatePortal(pocketPot ? { view: "pot", pot: pocketPot } : { view: "home" });
            }}
          />
        </FeatureBoundary>
      </main>
    );
  }

  if (route.view === "bench") {
    if (route.pot) return productShell(renderPotPage(route.pot, null, "bench"));
    return productShell(
      <FeatureBoundary name="Bench" fallback={<FeatureLoading name="Bench" />}>
        <BenchView
          pairings={visiblePairings}
          experiments={availableExperiments}
          readings={data.readings}
          bindings={currentBench?.bindings ?? []}
          layout={currentBench?.layout ?? null}
          layoutVersions={currentBench?.versions ?? 0}
          layoutError={currentBench?.error ?? null}
          nowMs={clockNowMs}
          asOfMs={lastGoodCheckAt}
          canRecord={isAdmin && Boolean(outboxScope)}
          onRecord={async (document, note) => {
            const recorded = await recordBenchLayout(activeProjectId, activeDeviceId, document, note, portalAccess.email ?? "Administrator");
            setBenchData((current) => current && current.scope === benchScope
              ? { ...current, layout: recorded, versions: Math.max(current.versions, recorded.version), error: null }
              : current);
          }}
        />
      </FeatureBoundary>,
    );
  }

  if (route.view === "pot") {
    return productShell(renderPotPage(route.pot, null));
  }

  if (route.view === "experiment") {
    if (!routeExperiment) {
      return productShell(<ExperimentNotFound id={route.experiment} loading={!catalogReady || accessLoading} />);
    }
    if (route.pot) {
      return productShell(renderPotPage(route.pot, routeExperiment));
    }
    const experimentTabs: ExperimentTab[] = recordAvailable ? ["overview", "pots", "record"] : ["overview", "pots"];
    const tab: ExperimentTab = experimentTabs.includes(route.tab) ? route.tab : "overview";
    return productShell(
      <ExperimentPage
        experiment={routeExperiment}
        tab={tab}
        nowMs={clockNowMs}
        exceptions={portalExceptions}
        tabs={experimentTabs}
      >
        {tab === "overview" ? (
          <FeatureBoundary name="Overview" fallback={<FeatureLoading name="Overview" />}><WaterlineOverview
            experiment={routeExperiment}
            pairings={sortedPairings}
            readings={experimentReadings}
            valveEvents={valveEventsForExperiment(valveEvents, routeExperiment)}
            nowMs={clockNowMs}
            asOfMs={lastGoodCheckAt}
            loadedWindowMs={rollingExperimentHistoryMs}
            dataSourceLabel={dataSourceLabel}
          /></FeatureBoundary>
        ) : tab === "record" ? (
          <FeatureBoundary name="Record" fallback={<FeatureLoading name="Record" />}><RecordView
            key={routeExperiment.id}
            experiment={routeExperiment}
            projectId={activeProjectId}
            deviceId={activeDeviceId}
            pairings={visiblePairings}
            nowMs={clockNowMs}
            userId={portalAccess.userId ?? null}
          /></FeatureBoundary>
        ) : (
          <div className="px-pots-tab">
            {potsTabContent}
            <FeatureBoundary name="Pots" fallback={<FeatureLoading name="Pots" />}><PotsTable
              experiment={routeExperiment}
              pairings={sortedPairings}
              readings={experimentReadings}
              nowMs={clockNowMs}
              asOfMs={lastGoodCheckAt}
            /></FeatureBoundary>
          </div>
        )}
      </ExperimentPage>,
    );
  }

  const supportThreads = salesSupportData.threads.filter((item) => item.request_type !== "quote" && item.source !== "quote");
  const openSupportCount = supportThreads.filter((item) => item.status !== "closed" && item.status !== "won" && item.status !== "lost").length;
  const newSupportCount = supportThreads.filter((item) => item.status === "new").length;
  const quoteCount = salesSupportData.quotes.filter((item) => item.status !== "closed" && item.status !== "won" && item.status !== "lost").length;

  const adminTools = isAdmin ? (
    <>
      <WalkerAdminTile onOpen={() => setPortalView("walker")} />
      <div className="portal-compact-row">
        <ChamberControlAdminTile onOpen={() => setPortalView("chamber")} />
        <button type="button" className="portal-launch-card is-support" onClick={() => setPortalView("support")}>
          <span className="portal-launch-top">
            <span className="portal-launch-icon">
              <Mail size={20} />
            </span>
            {newSupportCount ? (
              <span className="portal-status-pill is-warning">NEW</span>
            ) : null}
          </span>
          <span className="portal-launch-copy">
            <span className="portal-launch-title">Sales &amp; Support</span>
            <strong>{salesSupportLoading ? "Loading..." : `${newSupportCount} new · ${openSupportCount + quoteCount} open`}</strong>
          </span>
          <span className="portal-launch-action">
            Open <ArrowRight size={14} />
          </span>
        </button>
      </div>
      <div className="portal-compact-row">
        <WebsiteAnalyticsTile onOpen={() => setPortalView("analytics")} />
      </div>
      <button type="button" className="portal-launch-card is-health" onClick={() => setPortalView("health")}>
        <span className="portal-launch-top">
          <span className="portal-launch-icon">
            <Server size={18} />
          </span>
        </span>
        <span className="portal-launch-copy">
          <span className="portal-launch-title">System Health</span>
          <strong>{healthLoading && !healthSnapshot ? "Loading..." : healthSnapshot ? `${formatHealthInteger(healthSnapshot.sensors_current)} / ${formatHealthInteger(healthSnapshot.sensors_expected)} sensors` : "No health snapshot"}</strong>
        </span>
        <span className="portal-launch-action">
          Open <ArrowRight size={14} />
        </span>
      </button>
    </>
  ) : null;

  return productShell(
    <QuietSpineHome
      experiments={availableExperiments}
      exceptions={portalExceptions}
      nowMs={clockNowMs}
      checking={lastGoodCheckAt == null && refreshFailedAt == null}
      catalogError={experimentCatalogError}
      installation={installationState}
      canCreate={canCreateExperiment}
      onNewExperiment={() => {
        setEditingExperiment(null);
        setExperimentBuilderOpen(true);
      }}
      onEditExperiment={(experiment) => {
        setEditingExperiment(experiment);
        setExperimentBuilderOpen(true);
      }}
      healthLink={isAdmin ? <PortalLink to={{ view: "health" }}>System health →</PortalLink> : undefined}
      tools={adminTools ?? (portalAccess.gasMixerAllowed ? <GasMixerResearcherTile onOpen={() => setPortalView("chamber")} /> : undefined)}
      recordAvailable={recordAvailable}
    />,
  );
}
