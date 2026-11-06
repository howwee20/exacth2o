import { toggleTraceSelection } from "./product/traceSelection";
import { formatLoadedReadingsCsv, formatPairingsCsv } from "./portalCsv";
import { useExpandedGraph } from "./charts/useExpandedGraph";
import { ExperimentPotGroups } from "./product/ExperimentPotGroups";
import { PotInspector } from './product/PotInspector';
import { DirectExperiment } from './product/DirectExperiment';
import { SavedTraceViews } from "./product/SavedTraceViews";
import { clearExperimentArchives, useExperimentReadings } from "./useExperimentReadings";
import { experimentTraceReadings } from "./experimentTraceReadings";
import { AlertTriangle, ArrowRight, Loader2, Mail, Maximize2, Minimize2, ShieldCheck } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChamberControlView, GasMixerResearcherHome, GasMixerResearcherTile, GasMixerResearcherView } from "./ChamberControlView";
import { WalkerMachineTile } from "./WalkerObservationView";
import { SystemSection } from "./product/SystemSection";
import { WebsiteAnalyticsTile } from "./WebsiteAnalyticsTile";
import exactH2OLogo from "./assets/exacth2o-logo.jpeg";
import { AuthScreen } from "./auth/AuthScreen";
import { usePortalAuth } from "./usePortalAuth";
import { websiteAnalyticsReportCache } from "./websiteAnalyticsClient";
import {
  authEventReload,
  expiredPortalSessionNotice,
  isSessionAuthorizationError,
  type AuthReloadState,
} from "./authSession";
import { SensorCanvasChart } from "./charts/SensorCanvasChart";
import { TimeRangeControl } from "./charts/TimeRangeControl";
import { filterSeriesByTime, timeBoundsForSeries } from "./charts/chartGeometry";
import { chartSeries } from "./charts/chartSeries";
import { pairingTargetText, targetLinesForPairings } from "./experimentMeasurement";
import { formatMeasurementTime } from "./measurementFreshness";
import { controllerPresence } from "./settingsPresentation";
import { isCommandStatus, settingsBatchCommandType, type TrackedCommand, trackedCommandProgress } from "./commandLifecycle";
import { loadPortalExperimentCatalog } from "./experimentClient";
import { experimentGraphGroups, experimentSidebarGroups } from "./experimentPresentation";
import { levelLabel } from "./experimentFactors";
import { deduplicateExperimentCatalog, type ExperimentId, isObservationOnlyExperiment, pairingsForExperiment, type PortalExperiment, portalExperimentById, valveEventsForExperiment } from "./experimentRegistry";
import { HealthSelectedDetailDrawer } from "./health/HealthPanels";
import { hasExperimentSettingsAccess, hasProjectDataReadAccess, hasSalesSupportAccess, parsePortalRole } from "./portalAccess";
import { autoRefreshMs, fullReconciliationEveryPolls, fullTimeWindow, healthSnapshotPollMs, healthSnapshotSelectColumns, incrementalCursorOverlapMs, incrementalValveEventRows, livePrefix, maxValveEventRows, portalAccessTimeoutMs, rememberEmailKey, supabaseQueryTimeoutMs, supportPollMs, wateringHistoryMs } from "./portalConstants";
import { type DataMode, type EffectiveMode, isIgnoredDiagnosticReading, isIgnoredDiagnosticValveEvent, mergeRollingExperimentReadings, pairingsFromDeviceConfigState, resolveEffectiveMode, rollingExperimentHistoryMs, visibleExperimentPairings } from "./portalData";
import { controlCommandLabel, errorMessage, functionErrorMessage, runtimeStateIsFresh, selectHealthSnapshot } from "./portalFormat";
import { orderedPairings, plantGroupForPairing, treatmentForPairing } from "./portalPresentation";
import { selectPortalAccessRow, selectProjectDevice } from "./portalProjectContext";
import { fetchReadingsForMode, incrementalReadingCursor, loadedReadingCounts, newestByTime } from "./portalReadings";
import { adminOnlyControlCommandTypes, type ChartSeries, type ControlCommandResponse, type CsvDownload, type DeviceConfigState, type DeviceHealthSnapshot, type DeviceRuntimeState, type ExperimentGraphMode, type HealthSelectedDetail, type LoadState, type PortalAccess, type PortalView, type PotPreset, type QueueControlCommand, type QueueSettingsPlan, type QuoteRequestRow, type RefreshOptions, type SalesSupportData, type SettingsSection, type SupportMessageRow, type SupportThreadRow, type TimeWindow } from "./portalTypes";
import { dedupeReadingsForExport, downloadJsonFile } from "./readingsExport";
import { type SettingsCommandDraft, stoppedSettingsCommandTypes } from "./settingsSpec";
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
import { navigatePortal, type PortalRoute, settingsSectionFromSearch, usePortalRoute } from "./portalRoute";
import { resolvePot } from "./potIdentity";
import { readingsForPairings } from "./pairingHistory";
import { ExperimentNotFound, ExperimentPage } from "./product/ExperimentPage";
import { FindPotDialog } from "./product/FindPotDialog";
import type { ManualWaterTarget } from "./product/ManualWaterPanel";
import { AutocalRunBanner } from "./autocalibrate/AutocalRunBanner";
import { autocalRunStore } from "./autocalibrate/runStore";
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
const AutocalibratePage = lazyFeature(() => import("./autocalibrate/AutocalibratePage").then((module) => ({ default: module.AutocalibratePage })));
const ArchiveExperimentDialog = lazyFeature(() => import("./product/ArchiveExperimentDialog").then((module) => ({ default: module.ArchiveExperimentDialog })));
const ExperimentBuilder = lazyFeature(() => import("./ExperimentBuilder").then((module) => ({ default: module.ExperimentBuilder })));
const SystemHealthView = lazyFeature(() => import("./health/SystemHealthView").then((module) => ({ default: module.SystemHealthView })));
const SalesSupportView = lazyFeature(() => import("./support/SalesSupportView").then((module) => ({ default: module.SalesSupportView })));
const WalkerExperimentView = lazyFeature(() => import("./walker/WalkerExperimentPage").then((module) => ({ default: module.WalkerExperimentPage })));
const WebsiteAnalyticsWorkspace = lazyFeature(() => import("./analytics/WebsiteAnalyticsWorkspace"));
// Experiment, pot and trend views load when first opened; the home and header stay in the entry.
const PotPage = lazyFeature(() => import("./product/PotPage").then((module) => ({ default: module.PotPage })));
const TrendsView = lazyFeature(() => import("./product/TrendsView").then((module) => ({ default: module.TrendsView })));
const BenchView = lazyFeature(() => import("./product/BenchView").then((module) => ({ default: module.BenchView })));
const PocketView = lazyFeature(() => import("./product/PocketView").then((module) => ({ default: module.PocketView })));
const ExperimentExport = lazyFeature(() => import("./product/ExperimentExport").then((module) => ({ default: module.ExperimentExport })));
const AccountPage = lazyFeature(() => import("./product/AccountPage").then((module) => ({ default: module.AccountPage })));
const RecordView = lazyFeature(() => import("./product/RecordView").then((module) => ({ default: module.RecordView })));
const ManualWaterPanel = lazyFeature(() => import("./product/ManualWaterPanel").then((module) => ({ default: module.ManualWaterPanel })));
const prefetchSettings = () => {
  void loadSettingsPanel().catch(() => undefined);
};

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

export default function App({ initialFindPot = false }: { initialFindPot?: boolean } = {}) {
  const [sessionReady, setSessionReady] = useState(false);
  const [sessionRevision, setSessionRevision] = useState(0);
  const authReloadState = useRef<AuthReloadState>({ userId: null, tokenExpiresAtMs: null });
  const [loading, setLoading] = useState(false);
  const [exportingCsv, setExportingCsv] = useState(false);
  const [csvDownload, setCsvDownload] = useState<CsvDownload | null>(null);
  const [csvError, setCsvError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const auth = usePortalAuth({
    setLoading,
    clearError: () => setError(null),
    resetPortalSessionUi: () => resetPortalSessionUi(),
    setSessionReady,
  });
  const { authMode, setAuthMode, setLoginError, setAuthNotice, setTermsOpen, setTermsAccepted, setEmail, setRememberDevice } = auth;
  const [selectedMode] = useState<DataMode>("auto");
  const [experimentGraphMode, setExperimentGraphMode] = useState<ExperimentGraphMode>("vwc");
  const [hiddenPots, setHiddenPots] = useState<Set<string>>(() => new Set());
  const [selectedSeriesName, setSelectedSeriesName] = useState<string | null>(null);
  const [selectedWateringDetail, setSelectedWateringDetail] = useState<HealthSelectedDetail | null>(null);
  const [timeWindow, setTimeWindow] = useState<TimeWindow>(fullTimeWindow);
  const [potsPanelOpen, setPotsPanelOpen] = useState(false);
  const { graphExpanded, setGraphExpanded, dashboardMainRef, toggleExpandedGraph } = useExpandedGraph();
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
  const [accessLoading, setAccessLoading] = useState(true);
  // The URL is the source of truth for what is on screen: Back, Forward, refresh and copied links work.
  const route = usePortalRoute();
  const portalView: PortalView = route.view === "experiment" || route.view === "pot"
    ? "experiment"
    : route.view === "health" || route.view === "support" || route.view === "walker" || route.view === "chamber" || route.view === "analytics" || route.view === "controller" || route.view === "account" || route.view === "autocalibrate"
      ? route.view
      : "home";
  const setPortalView = useCallback((view: PortalView) => {
    navigatePortal(view === "home" || view === "experiment" ? { view: "home" } : { view } as PortalRoute);
  }, []);
  const [findPotOpen, setFindPotOpen] = useState(initialFindPot);
  const [manualWaterOpen, setManualWaterOpen] = useState(false);
  const [manualWaterTarget, setManualWaterTarget] = useState<ManualWaterTarget>(null);
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
  const [archivingExperiment, setArchivingExperiment] = useState<PortalExperiment | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [duplicateExperiment, setDuplicateExperiment] = useState<PortalExperiment | null>(null);
  const [editingExperiment, setEditingExperiment] = useState<PortalExperiment | null>(null);
  const [experimentCatalogError, setExperimentCatalogError] = useState<string | null>(null);
  const [healthSnapshot, setHealthSnapshot] = useState<DeviceHealthSnapshot | null>(null);
  const [healthHistory, setHealthHistory] = useState<DeviceHealthSnapshot[]>([]);
  const [runtimeState, setRuntimeState] = useState<DeviceRuntimeState | null>(null);
  const [configState, setConfigState] = useState<DeviceConfigState | null>(null);
  const [valveEvents, setValveEvents] = useState<ValveEvent[]>([]);
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

  useEffect(() => {
    dataRef.current = data;
  }, [data]);

  useEffect(() => {
    valveEventsRef.current = valveEvents;
  }, [valveEvents]);

  const closeSettings = useCallback(() => {
    setSettingsOpen(false);
    // Installation tools open over a transient controller route. Back returns
    // straight to Experiments; experiment settings keep their original graph.
    if (route.view === "controller") navigatePortal({ view: "home" }, { replace: true });
  }, [route.view]);

  useEffect(() => {
    if (!settingsOpen) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeSettings();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeSettings, settingsOpen]);

  const availableExperiments = useMemo(
    () => deduplicateExperimentCatalog(experimentCatalog),
    [experimentCatalog],
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
      pairingsForExperiment(visibleExperimentPairings(data.pairings), selectedExperiment),
    ),
    [data.pairings, selectedExperiment],
  );
  const pairingByName = useMemo(
    () => new Map(sortedPairings.map((pairing) => [pairing.name, pairing])),
    [sortedPairings],
  );
  const experimentArchive = useExperimentReadings(selectedExperiment, portalAccess?.projectId ?? "", portalAccess?.deviceId ?? "",
    sessionReady && route.view === "experiment" && route.tab !== "record" && document.documentElement.dataset.portalMode !== "demo", portalAccess?.userId);
  const experimentReadings = useMemo(
    () => experimentTraceReadings(experimentArchive.readings, data.readings, selectedExperiment),
    [data.readings, experimentArchive.readings, selectedExperiment],
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
  const timeBounds = useMemo(() => {
    const loaded = timeBoundsForSeries(series);
    if (!loaded) return null;
    const start = selectedExperiment.startedAt ? Date.parse(selectedExperiment.startedAt) : loaded.startMs;
    const end = selectedExperiment.endedAt ? Date.parse(selectedExperiment.endedAt) : loaded.endMs;
    return { startMs: Number.isFinite(start) ? Math.min(start, loaded.startMs) : loaded.startMs,
      endMs: Number.isFinite(end) ? Math.max(end, loaded.endMs) : loaded.endMs };
  }, [series, selectedExperiment.startedAt, selectedExperiment.endedAt]);
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
  const fullExperimentValveEvents = useMemo(() => [...new Map(
    [...experimentArchive.valveEvents, ...valveEvents].map((event) => [event.event_id || event.id, event]),
  ).values()], [experimentArchive.valveEvents, valveEvents]);
  const experimentWateringEvents = useMemo(
    () => resolveHealthWateringEvents(
      valveEventsToHealthWateringEvents(
        valveEventsForExperiment(fullExperimentValveEvents, selectedExperiment),
        sortedPairings,
      ),
      sortedPairings,
    ),
    [selectedExperiment, sortedPairings, fullExperimentValveEvents],
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
  const controllerOffline = runtimeState
    ? controllerPresence({
      stateFreshUntil: runtimeState.state_fresh_until,
      stateObservedAt: runtimeState.state_observed_at,
      controllerState: runtimeState.controller_state,
      lastSeenAt: data.latestState?.last_seen_at ?? data.latestState?.updated_at,
    }, clockNowMs).status === "offline"
    : false;

  const visiblePotCount = series.filter(
    (item) => visibleNames.has(item.name) && item.rawPointCount > 0,
  ).length;
  const isAdmin = portalAccess?.role === "admin";
  const canUseSalesSupport = !accessLoading && hasSalesSupportAccess(portalAccess?.role, portalAccess?.salesSupportAllowed);
  const projectAccess = portalAccess?.accessScope === "project";
  const canReadProjectData = projectAccess && hasProjectDataReadAccess(portalAccess?.role);
  const isDemo = document.documentElement.dataset.portalMode === "demo";
  const canUseExperimentSettings = !isDemo && projectAccess && hasExperimentSettingsAccess(portalAccess?.role);
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

  // An autocalibration run belongs to the project and controller it started on.
  useEffect(() => {
    if (activeProjectId && activeDeviceId) autocalRunStore.stopUnlessFor(activeProjectId, activeDeviceId);
  }, [activeProjectId, activeDeviceId]);

  // Settings links open the requested section. Old Autocalibrate links now resolve
  // to the dedicated page and retain a reloadable URL.
  useEffect(() => {
    if (!sessionReady) return;
    const requested = settingsSectionFromSearch(window.location.search);
    if (route.view === "autocalibrate") {
      setSettingsOpen(false);
      if (requested) navigatePortal({view: "autocalibrate"}, {replace: true});
      return;
    }
    if (!canUseExperimentSettings) return;
    if (!requested) return;
    if (route.view !== "experiment" && route.view !== "controller") {
      navigatePortal({ view: "controller" }, { replace: true, extra: { settings: requested } });
      return;
    }
    setSettingsSection(requested);
    prefetchSettings();
    setSettingsOpen(true);
    navigatePortal(route, { replace: true, extra: { settings: null } });
  }, [sessionReady, canUseExperimentSettings, route]);

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
    setExportOpen(false);
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
  }, [setTermsAccepted, setTermsOpen]);

  if (uiExperimentId !== selectedExperimentId) {
    setUiExperimentId(selectedExperimentId);
    setExperimentGraphMode("vwc");
    setHiddenPots(new Set());
    setSelectedSeriesName(null);
    setSelectedWateringDetail(null);
    setTimeWindow(fullTimeWindow);
    setGraphExpanded(false);
    setPotsPanelOpen(false);
  }

  const openExperiment = useCallback((experimentId: ExperimentId) => {
    setSettingsOpen(false);
    navigatePortal({ view: "experiment", experiment: experimentId, tab: "pots", pot: null });
  }, []);

  const loadExperimentCatalog = useCallback(async () => {
    if (!canReadProjectData || !activeProjectId) {
      setExperimentCatalog([]);
      return;
    }
    const scope = scopeKeyRef.current;
    try {
      const catalog = await loadPortalExperimentCatalog(activeProjectId);
      if (scope !== scopeKeyRef.current) return;
      setExperimentCatalog(catalog);
      setExperimentCatalogError(null);
    } catch (nextError) {
      if (scope !== scopeKeyRef.current) return;
      setExperimentCatalogError(errorMessage(nextError));
    }
  }, [activeProjectId, canReadProjectData]);

  const expirePortalSession = useCallback(() => {
    setError(null);
    setLoginError(null);
    setAuthNotice(expiredPortalSessionNotice);
    setSessionReady(false);
  }, [setAuthNotice, setLoginError]);

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

  const [accessCheckError, setAccessCheckError] = useState<string | null>(null);
  const loadPortalAccess = useCallback(async () => {
    setAccessCheckError(null);
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
        ).catch(() => null);
        const gas_mixer_allowed = mixerAccess?.error == null && mixerAccess?.data === true;
        // A failed capability check hides only the inbox; research access remains usable.
        const supportAccess = accessRow.role === "admin" ? await withSupabaseTimeout(
          supabase.rpc("is_sales_support_staff", { check_project_id: accessRow.project_id }),
          portalAccessTimeoutMs, "Sales & Support access",
        ).catch(() => null) : null;
        const sales_support_allowed = supportAccess?.error == null && supportAccess?.data === true;
        if (accessRow.access_scope !== "project") {
          return { data: { ...accessRow, device_id: null, gas_mixer_allowed, sales_support_allowed, user_id: signedInUserId } };
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
            sales_support_allowed,
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
        salesSupportAllowed: response.data?.sales_support_allowed === true,
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
      setAccessCheckError("We could not check your portal access. Please retry.");
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
      setHealthError(null);
    }

    const scope = scopeKeyRef.current;
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

      if (scope !== scopeKeyRef.current) return;
      if (response.error) throw response.error;
      const snapshots = (response.data ?? []) as DeviceHealthSnapshot[];
      setHealthHistory(snapshots);
      setHealthSnapshot(selectHealthSnapshot(snapshots));
    } catch (err) {
      if (scope !== scopeKeyRef.current) return;
      if (!silent) setHealthError(errorMessage(err));
    }
  }, [activeDeviceId, activeProjectId, isAdmin]);

  const loadDeviceSyncState = useCallback(async () => {
    if (!canUseExperimentSettings || !activeProjectId || !activeDeviceId) {
      setRuntimeState(null);
      setConfigState(null);
      return;
    }

    const scope = scopeKeyRef.current;
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

      if (scope !== scopeKeyRef.current) return;
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
    if (!canUseSalesSupport || !activeProjectId) {
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
      if (loadId !== salesSupportLoadId.current) return;
      if (!silent) setSalesSupportError(errorMessage(err));
    } finally {
      if (!silent && loadId === salesSupportLoadId.current) setSalesSupportLoading(false);
    }
  }, [activeProjectId, canUseSalesSupport]);

  const deleteQuoteRequest = useCallback(async (quoteId: string) => {
    if (!canUseSalesSupport || !activeProjectId) throw new Error("Sales & Support access is required to delete quotes.");
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
  }, [activeProjectId, canUseSalesSupport, loadSalesSupport]);

  const runPortalRefresh = useCallback(
    async ({ incremental }: RefreshOptions) => {
      if (!activeProjectId || !activeDeviceId) return;
      const scope = scopeKeyRef.current;
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

        if (token !== loadTokenRef.current || scope !== scopeKeyRef.current) return;
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
          if (token !== loadTokenRef.current || scope !== scopeKeyRef.current) return;
          pairingsData = (legacyPairings.data ?? []) as PairingRow[];
        }
        pairingsData = visibleExperimentPairings(pairingsData);

        if (controllerConfig.data) {
          setConfigState(controllerConfig.data as DeviceConfigState);
        }

        // A full reconciliation of data already on screen is assembled off-screen and swapped
        // in once complete, so the chart never empties and refills. Only a first load (or a
        // switch between live and imported data) streams batches in as they arrive.
        const reconcileInPlace = !canIncrement && previous.readings.length > 0;
        setData((current) => ({
          ...current,
          pairings: pairingsData,
          latestState: latestState.data ?? null,
          latestIngestTime,
          lastCheckedAt: nowIso,
          effectiveMode,
          readings: current.readings,
          totalImportedReadings: current.totalImportedReadings,
          totalLiveReadings: current.totalLiveReadings,
        }));

        const applyReadingsBatch = (incomingReadings: SensorReading[]) => {
          if (token !== loadTokenRef.current || scope !== scopeKeyRef.current || incomingReadings.length === 0) return;
          setData((current) => readingsState(current, mergeRollingExperimentReadings(current.readings, incomingReadings), incomingReadings, nowIso, effectiveMode));
        };

        const fetched = await fetchReadingsForMode(
          activeProjectId,
          activeDeviceId,
          effectiveMode,
          newerThan,
          reconcileInPlace ? undefined : applyReadingsBatch,
        );
        if (reconcileInPlace && token === loadTokenRef.current && scope === scopeKeyRef.current) {
          setData((current) => {
            // Keep realtime rows that arrived while the reconciliation was running.
            const arrivedDuring = current.readings.filter((reading) =>
              Date.parse(reading.server_received_at) >= startedAtMs - incrementalCursorOverlapMs);
            if (selectedMode === "auto" && fetched.length === 0) return {...current, effectiveMode: previous.effectiveMode};
            const reconciled = mergeRollingExperimentReadings(fetched, arrivedDuring);
            return readingsState(current, reconciled, fetched, nowIso, effectiveMode);
          });
        }
        if (token === loadTokenRef.current && scope === scopeKeyRef.current) {
          // Only a completed check may make the home quiet; a failed one is stated, with the
          // time of the last good data.
          setLastSuccessfulCheckAt(Date.now());
          setRefreshFailedAt(null);
        }
      } catch (err) {
        if (token === loadTokenRef.current && scope === scopeKeyRef.current) {
          if (isSessionAuthorizationError(err)) {
            expirePortalSession();
            return;
          }
          setError(errorMessage(err));
          setRefreshFailedAt(Date.now());
        }
      } finally {
        if (token === loadTokenRef.current && scope === scopeKeyRef.current) {
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

  const runPortalRefreshRef = useRef(runPortalRefresh);
  runPortalRefreshRef.current = runPortalRefresh;

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
          await runPortalRefreshRef.current(currentOptions);
          nextOptions = pendingRefreshRef.current;
          pendingRefreshRef.current = null;
        }
      } finally {
        refreshInFlightRef.current = false;
      }
    },
    [refreshLatestReadings],
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
              device_id: activeDeviceId,
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
        return null;
      }
      if (!plan.commands.length || plan.questions.length) {
        setControlError("Resolve the request before applying settings.");
        return null;
      }
      for (const command of plan.commands) {
        if (!isAdmin && adminOnlyControlCommandTypes.has(command.command_type)) {
          setControlError("Administrator access is required for this controller command.");
          return null;
        }
      }

      const directCommands = plan.commands.filter(
        (command) => !stoppedSettingsCommandTypes.has(command.command_type),
      );
      if (directCommands.length) {
        if (plan.commands.length !== 1) {
          setControlError("System-state and export requests must be reviewed separately.");
          return null;
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
          return null;
        }
        await sendSingleControlCommand(
          direct.command_type,
          direct.payload,
          {
            confirm: direct.command_type === "update_system_state",
            operationIntent: plan.summary,
          },
        );
        return null;
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
        return null;
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
              device_id: activeDeviceId,
              client_request_id: commandIds[0],
              batch_id: batchId,
              expected_config_hash: reviewedConfigHash,
              expected_controller_state: reviewedControllerState,
              batch_commands: batchCommands,
              operation_intent: plan.summary,
              ...(/^Autocalibrat/i.test(plan.summary) ? { workflow: "autocalibration" } : {}),
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
        return { batchId, commandIds: commands.map((command) => command.id) };
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
            return { batchId, commandIds: recorded.map((command) => command.id) };
          } else {
            setControlError(`${errorMessage(nextError)} Safe to retry; the same batch IDs will be reused.`);
          }
        } catch {
          setControlError(`${errorMessage(nextError)} Safe to retry; the same batch IDs will be reused.`);
        }
      } finally {
        setControlBusy(false);
      }
      return null;
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

  async function signOut() {
    const unsent = noteOutbox.waiting.length;
    if (unsent && !window.confirm(`${unsent} ${unsent === 1 ? "note has" : "notes have"} not reached the record yet. ${unsent === 1 ? "It stays" : "They stay"} on this device, visible only to this account, and ${unsent === 1 ? "sends" : "send"} when you sign in here again. Sign out?`)) return;
    if (autocalRunStore.running && !window.confirm("An autocalibration run is in progress in this tab. Signing out stops it before its next pulse; its evidence so far is kept. Sign out?")) return;
    autocalRunStore.stop("The operator signed out, so the run stopped before its next pulse.");
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
    setHealthError(null);
    setSalesSupportData(initialSalesSupportData);
    setSalesSupportLoading(false);
    setSalesSupportError(null);
    setData(initialLoadState);
    dataRef.current = initialLoadState;
    setExperimentCatalog([]);
    websiteAnalyticsReportCache.clear();
  }


  function applyPotPreset(preset: Exclude<PotPreset, "custom">) {
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

  function toggleExperimentGraphGroup(groupId: string) {
    const group = selectedExperimentGraphGroups.find(item => item.id === groupId);
    if (!group) return;
    setSelectedSeriesName(null);
    setHiddenPots(current => toggleTraceSelection(current, group.pairingNames));
  }

  function togglePot(name: string) {
    setSelectedSeriesName(name);
    setHiddenPots(current => toggleTraceSelection(current, [name]));
  }

  function setGroupVisibility(pairings: PairingRow[], visible: boolean) {
    setHiddenPots((current) => {
      const next = new Set(current);
      for (const pairing of pairings) {
        if (visible) next.delete(pairing.name);
        else next.add(pairing.name);
      }
      return next;
    });
  }

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

  useEffect(() => {
    const rememberedEmail = window.localStorage.getItem(rememberEmailKey);
    if (rememberedEmail) {
      setEmail(rememberedEmail);
      setRememberDevice(true);
    }

    let active = true;
    const { data: authListener } = supabase.auth.onAuthStateChange((event, session) => {
      if (!active) return;
      if (event === "PASSWORD_RECOVERY") { setAuthMode("set-password"); setSessionReady(false); return; }
      if (authMode === "set-password" || authMode === "accept-invite" || authMode === "recover") return;
      // Same-user SIGNED_IN (every tab focus) and routine hourly refreshes
      // keep the loaded data; only a new user or a post-expiry refresh reloads.
      const decision = authEventReload(authReloadState.current, event, session);
      authReloadState.current = decision.next;
      if (session && decision.userChanged) setAccessLoading(true);
      setSessionReady(Boolean(session));
      if (decision.reload) setSessionRevision((current) => current + 1);
    });

    void supabase.auth.getSession().then(({ data: sessionData }) => {
      if (!active || authMode === "set-password" || authMode === "accept-invite") return;
      if (sessionData.session && authReloadState.current.userId !== sessionData.session.user.id) {
        setAccessLoading(true);
      }
      authReloadState.current = authEventReload(authReloadState.current, "INITIAL_SESSION", sessionData.session).next;
      setSessionReady(Boolean(sessionData.session));
    });

    return () => {
      active = false;
      authListener.subscription.unsubscribe();
    };
  }, [authMode, setAuthMode, setEmail, setRememberDevice]);

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
    setData(initialLoadState);
    dataRef.current = initialLoadState;
    setValveEvents([]);
    valveEventsRef.current = [];
    setRuntimeState(null);
    setConfigState(null);
    setHealthSnapshot(null);
    setHealthHistory([]);
    setExperimentCatalog([]);
    setExperimentCatalogError(null);
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
      setHealthSnapshot(null);
      setHealthHistory([]);
      setRuntimeState(null);
      setConfigState(null);
      setValveEvents([]);
      setSalesSupportData(initialSalesSupportData);
      setData(initialLoadState);
      dataRef.current = initialLoadState;
      valveEventsRef.current = [];
      // Nothing from the previous account stays visible to the next one.
      setExperimentCatalog([]);
      websiteAnalyticsReportCache.clear();
      clearExperimentArchives();
      return;
    }
    void loadPortalAccess();
  }, [loadPortalAccess, sessionReady, sessionRevision]);

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
    // Discard in-flight responses and cached customer details across permission/project changes.
    salesSupportLoadId.current += 1;
    setSalesSupportData(initialSalesSupportData);
    setSalesSupportError(null);
    setSalesSupportLoading(false);
  }, [activeProjectId, canUseSalesSupport, portalAccess?.userId]);

  useEffect(() => {
    if (!sessionReady || !canUseSalesSupport) return;
    void loadSalesSupport();
  }, [canUseSalesSupport, loadSalesSupport, sessionReady]);

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
    if (!sessionReady || !canUseSalesSupport) return undefined;
    return scheduleVisiblePolling(() => loadSalesSupport({ silent: true }), supportPollMs);
  }, [canUseSalesSupport, loadSalesSupport, sessionReady]);

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
    if (!sessionReady || !canUseSalesSupport || !activeProjectId) return undefined;

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
  }, [activeProjectId, canUseSalesSupport, loadSalesSupport, sessionReady]);

  if (!sessionReady) {
    return <AuthScreen {...auth} loading={loading} />;
  }

  const groupedPairings = experimentSidebarGroups(sortedPairings, selectedExperiment);

  const recordAvailable = true;
  const visiblePairings = visibleExperimentPairings(data.pairings);
  const currentPairingReadings = readingsForPairings(data.readings, visiblePairings);
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
        : { status: "online", lastSeenAt: presenceLastSeenMs };
  const portalExceptions = homeExceptions({
    experiments: availableExperiments,
    pairings: visiblePairings,
    readings: currentPairingReadings,
    nowMs: clockNowMs,
    checked: lastGoodCheckAt != null,
    refresh: { failedAt: refreshFailedAt, lastSuccessAt: lastGoodCheckAt },
    controller: presence ? { offline: presence.status === "offline", lastSeenAt: presenceLastSeenMs } : null,
    formatTime: (ms) => formatMeasurementTime(ms) ?? "",
  });
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
      key={editingExperiment?.currentRevisionId ?? duplicateExperiment?.id ?? "new-experiment"}
      projectId={activeProjectId}
      pairings={visibleExperimentPairings(data.pairings)}
      experiments={availableExperiments}
      inventoryUpdatedAt={configState?.updated_at ?? null}
      direct
      experiment={editingExperiment}
      template={duplicateExperiment}
      onClose={() => {
        setExperimentBuilderOpen(false);
        setEditingExperiment(null);
        setDuplicateExperiment(null);
      }}
      onCreated={async (slug) => {
        await loadExperimentCatalog();
        setExperimentBuilderOpen(false);
        setEditingExperiment(null);
        setDuplicateExperiment(null);
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
          <p>{accessCheckError ?? "This account does not currently have portal access."}</p>
          {accessCheckError && <button className="header-action" type="button" onClick={() => void loadPortalAccess()}>Retry access check</button>}
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
    <DirectExperiment key={selectedExperiment.id} experiment={selectedExperiment} pairings={sortedPairings} projectId={activeProjectId} inventoryUpdatedAt={configState?.updated_at ?? null} canEdit={canUseExperimentSettings} demo={isDemo} onRefresh={async()=>{await loadExperimentCatalog();await loadDeviceSyncState();}}>{direct => <>

      {error && !data.readings.length ? (
        <div className="banner error" role="alert">
          <AlertTriangle size={18} />
          Readings could not be loaded: {error}
        </div>
      ) : null}


      <section
        ref={dashboardMainRef}
        className={`dashboard-main has-top-pots ${graphExpanded ? "is-expanded" : ""}`}
      >
          <aside
            className={`control-panel px-pots-panel ${potsPanelOpen ? "is-open" : ""}`}
            aria-label="Pots"
          >
          <div className="px-trace-heading">
            <h2>Pots</h2>
            <button className="px-pots-disclosure" type="button" aria-expanded={potsPanelOpen} aria-controls="experiment-pots" onClick={() => setPotsPanelOpen(!potsPanelOpen)}>Pots <span aria-hidden="true">{potsPanelOpen ? "▴" : "▾"}</span></button>
            <span role="status">{visibleWateringPairings.length} of {sortedPairings.length}</span>
          </div>
          <div className="px-pots-body" id="experiment-pots">
          <section className="px-trace-controls">
            <div className="px-trace-actions">
              <button type="button" className="px-button is-small" onClick={() => applyPotPreset("all")}>Show all</button>
              <button type="button" className="px-button is-small" onClick={() => setHiddenPots(new Set(sortedPairings.map((pairing) => pairing.name)))}>Hide all</button>
            <SavedTraceViews key={`${portalAccess?.userId}:${activeProjectId}:${activeDeviceId}:${selectedExperiment.id}`}
              scope={JSON.stringify([portalAccess?.userId, activeProjectId, activeDeviceId, selectedExperiment.id])}
              experiment={selectedExperiment} names={sortedPairings.map(p => p.name)} visible={visibleWateringPairings.map(p => p.name)} bounds={timeBounds} window={timeWindow}
              onApply={(names, window) => { const included = new Set(names); setHiddenPots(new Set(sortedPairings.filter(p => !included.has(p.name)).map(p => p.name))); setTimeWindow(window); setSelectedSeriesName(null); }} />
            </div>
            {selectedExperimentGraphGroups.length > 1 ? <div className="preset-buttons research-presets">
              {selectedExperimentGraphGroups.map((group) => <button key={group.id} type="button" className={`preset-filter ${group.pairingNames.every(name => !hiddenPots.has(name)) ? "is-selected" : ""}`} aria-pressed={group.pairingNames.every(name => !hiddenPots.has(name))} onClick={() => toggleExperimentGraphGroup(group.id)}>{group.treatment === "observation" ? levelLabel(group.crop) : group.label}</button>)}
            </div> : null}
          </section>

          <ExperimentPotGroups
            groupedPairings={groupedPairings} hiddenPots={hiddenPots}
            selectedExperiment={selectedExperiment} seriesByName={seriesByName}
            clockNowMs={clockNowMs} affectedPots={direct.affected}
            selectedSeriesName={selectedSeriesName}
            setGroupVisibility={setGroupVisibility} togglePot={togglePot}
          />
          </div>
          </aside>
          <section className={`chart-card ${experimentGraphMode === "watering" ? "is-watering" : ""}`}>
            <div className="chart-tools">
              <div className="chart-view-toggle" aria-label="Graph view">
                <button
                  type="button"
                  className={experimentGraphMode === "vwc" ? "is-selected" : ""}
                  aria-pressed={experimentGraphMode === "vwc"}
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
                      aria-pressed={experimentGraphMode === "watering"}
                      onClick={() => setExperimentGraphMode("watering")}
                    >
                      Watering
                    </button>
                    <button
                      type="button"
                      className={experimentGraphMode === "overlay" ? "is-selected" : ""}
                      aria-pressed={experimentGraphMode === "overlay"}
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
                <>
                <div className="chart-bottom-controls watering-time-controls">
                  <TimeRangeControl bounds={timeBounds} value={timeWindow} onChange={setTimeWindow} />
                </div>
                <ResearchWateringActivity
                  events={experimentWateringEvents}
                  experiment={selectedExperiment}
                  windowOverride={selectedVwcTimeBounds ?? undefined}
                  pairings={visibleWateringPairings}
                  onSelectDetail={setSelectedWateringDetail}
                  onZoom={(bounds) => {
                    if (!timeBounds) return;
                    const span = Math.max(1, timeBounds.endMs - timeBounds.startMs);
                    setTimeWindow({ start: (bounds.startMs - timeBounds.startMs) / span * 100, end: (bounds.endMs - timeBounds.startMs) / span * 100 });
                  }}
                />
                </>
              ) : (
                <SensorCanvasChart
                  series={timeFilteredSeries}
                  visibleNames={chartVisibleNames}
                  selectedName={selectedSeriesName}
                  viewMode="traces"
                  onSelectSeries={setSelectedSeriesName}
                  loading={loading && !series.some((item) => item.points.length)}
                  xDomain={selectedVwcTimeBounds}
                  wateringEvents={experimentGraphMode === "overlay" ? experimentWateringEvents : undefined}
                  targetLines={direct.lines.length ? direct.lines : visibleTargetLines}
                  describeTarget={describePotTarget}
                  targetLayer={direct.targetLayer}
                  extraTargetValues={direct.extraTargetValues}
                  freezeScale={direct.freezeScale}
                  affectedNames={direct.affected}
                />
              )}
            </section>
            {experimentGraphMode !== "watering" ? <div className="chart-bottom-controls">
                <TimeRangeControl
                  bounds={timeBounds}
                  value={timeWindow}
                  onChange={setTimeWindow}
                />
              </div> : null}
          </section>


      </section>
    </>}</DirectExperiment>
  );

  const manualWaterAvailable = Boolean(canUseExperimentSettings && activeProjectId && activeDeviceId);
  const openManualWater = (potNumber: number | null) => {
    setManualWaterTarget(potNumber != null ? { mode: "pot", potNumber } : null);
    setManualWaterOpen(true);
  };
  const manualWaterPanel = manualWaterAvailable && manualWaterOpen
    ? <FeatureBoundary name="Manual water" fallback={null}><ManualWaterPanel open onClose={() => setManualWaterOpen(false)} projectId={activeProjectId} deviceId={activeDeviceId} controllerName="Controller" initial={manualWaterTarget} /></FeatureBoundary>
    : null;
  const openAutocalibrate = () => {
    setSettingsOpen(false);
    navigatePortal({ view: "autocalibrate" });
  };
  const productHeader = (
    <ProductHeader
        demo={isDemo}
      onFindPot={() => setFindPotOpen(true)}
      onOpenAccount={!isDemo ? () => navigatePortal({ view: "account" }) : undefined}
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

  const settingsPanel = canUseExperimentSettings && settingsMounted && (route.view === "experiment" || route.view === "controller") ? (
    <FeatureBoundary name="Settings" hidden={!settingsOpen} resetKey={settingsOpen} fallback={settingsOpen ? <FeatureLoading name="Settings" /> : null}><PortalSettingsPanel
      key={`${route.view}:${selectedExperiment.id}`}
      open={settingsOpen}
      scope={route.view === "controller" ? "installation" : "experiment"}
      projectId={activeProjectId}
      portalRole={portalAccess.role}
      experiment={selectedExperiment}
      activeSection={settingsSection}
      data={data}
      runtimeState={runtimeState}
      configState={configState}
      pairings={route.view === "controller" ? visiblePairings : sortedPairings}
      visiblePotCount={visiblePotCount}
      csvDownload={csvDownload}
      csvError={csvError}
      exportingCsv={exportingCsv}
      controlBusy={controlBusy}
      controlNotice={controlNotice}
      commandProgress={trackedCommand ? trackedCommandProgress(trackedCommand, !controllerOffline) : null}
      controlError={controlError}
      operatorEmail={portalAccess.email ?? null}
      onClose={closeSettings}
      onSectionChange={(section) => section === "autocalibrate" ? openAutocalibrate() : setSettingsSection(section)}
      onPrepareCsvDownload={prepareCsvDownload}
      onDownloadPairingsCsv={downloadPairingsCsv}
      onQueueCommand={queueControlCommand}
      onSignOut={signOut}
    /></FeatureBoundary>
  ) : null;

  const findPotDialog = (
    <FindPotDialog
      manualControl={canUseExperimentSettings && activeProjectId && activeDeviceId ? {projectId: activeProjectId, deviceId: activeDeviceId, controllerName: "Controller"} : undefined}
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
      <AutocalRunBanner onOpen={openAutocalibrate} />
      {content}
      {experimentBuilder}
      {archivingExperiment && canCreateExperiment ? <FeatureBoundary name="Archive experiment"><ArchiveExperimentDialog
        projectId={activeProjectId} experiment={archivingExperiment.id}
        onClose={() => setArchivingExperiment(null)}
        onArchived={loadExperimentCatalog}
      /></FeatureBoundary> : null}
      {settingsPanel}
      {exportOpen && routeExperiment ? <FeatureBoundary name="Experiment export"><ExperimentExport
        experiment={routeExperiment} pairings={sortedPairings} readings={experimentReadings}
        projectId={activeProjectId} deviceId={activeDeviceId}
        nowMs={clockNowMs} loadedWindowMs={rollingExperimentHistoryMs} initialNames={visibleWateringPairings.map(p=>p.name)} initialWindow={selectedVwcTimeBounds ?? undefined} onClose={() => setExportOpen(false)}
      /></FeatureBoundary> : null}
      {findPotDialog}
      {manualWaterPanel}
      <HealthSelectedDetailDrawer
        detail={selectedWateringDetail}
        onClose={() => setSelectedWateringDetail(null)}
      />
    </main>
  );

  if (route.view === "account" && !isDemo) {
    return productShell(<FeatureBoundary name="Account"><AccountPage key={activeProjectId} access={portalAccess} /></FeatureBoundary>);
  }
  if (route.view === "autocalibrate" && canReadProjectData) {
    return productShell(<FeatureBoundary name="Autocalibrate"><AutocalibratePage
      projectId={activeProjectId}
      deviceId={activeDeviceId || null}
      operator={portalAccess.email ?? null}
      portalRole={portalAccess.role}
      experiment={selectedExperiment}
      experiments={availableExperiments}
      pairings={visiblePairings}
      configHash={configState?.config_hash?.trim() || null}
      controllerState={runtimeStateIsFresh(runtimeState) ? runtimeState?.controller_state ?? null : null}
      controllerOnline={presence?.status === "online"}
      controlBusy={controlBusy}
      onQueueSettingsPlan={queueSettingsPlan}
      error={controlError}
      notice={controlNotice}
    /></FeatureBoundary>);
  }
  if (route.view === "controller" && canReadProjectData) {
    return productShell(<section className="px-page">
      <PortalLink className="px-home-button" to={{view:"home"}}>← Home</PortalLink>
      <div className="px-exp-head-row"><h1 className="px-title">Installation</h1>{canUseExperimentSettings ? <button className="px-button" onClick={() => {setSettingsSection("overview");prefetchSettings();setSettingsOpen(true);}}>Installation settings</button> : null}</div>
      <p className="px-subtitle">Shared sensing and irrigation for this installation</p>
      <dl className="px-facts px-card px-account-section">
        <div><dt>Connection</dt><dd>{presence?.status ?? "Checking"}</dd></div>
        <div><dt>Controller state</dt><dd>{presence?.controllerState ?? "Not reported"}</dd></div>
        <div><dt>Last seen</dt><dd>{presence?.lastSeenAt ? formatMeasurementTime(Date.parse(presence.lastSeenAt)) : "Not reported"}</dd></div>
        <div><dt>Pot pairings</dt><dd>{visiblePairings.length}</dd></div>
      </dl>
      {isAdmin ? <PortalLink className="px-button" to={{view:"health"}}>System health and diagnostics →</PortalLink> : null}
      <h2 className="px-section-title">Experiments on this controller</h2>
      <ul className="px-notification-list">{availableExperiments.map((experiment) => <li key={experiment.id}><PortalLink to={{view:"experiment",experiment:experiment.id,tab:"pots",pot:null}}>{experiment.name}</PortalLink><span className="px-muted">{experiment.pairingNames.length} {experiment.pairingNames.length === 1 ? "pot" : "pots"}</span></li>)}</ul>
    </section>);
  }

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

  if (canUseSalesSupport && portalView === "support") {
    return productShell(
        <FeatureBoundary name="Sales & Support">
          <SalesSupportView
            key={`${portalAccess?.userId}:${activeProjectId}`}
            data={salesSupportData}
            loading={salesSupportLoading}
            error={salesSupportError}
            onDeleteQuote={deleteQuoteRequest}
            onBackHome={() => setPortalView("home")}
          />
        </FeatureBoundary>
    );
  }

  if (isAdmin && portalView === "walker") {
    return productShell(<FeatureBoundary name="Walker observation"><WalkerExperimentView onBack={() => setPortalView("home")} /></FeatureBoundary>);
  }

  if (isAdmin && portalView === "chamber") {
    return productShell(<ChamberControlView onBack={() => setPortalView("home")} />);
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
    return (
      <FeatureBoundary name="Pot" fallback={<FeatureLoading name="Pot" />}><PotPage
        match={match}
        readings={readingsForPairings(data.readings, [match.pairing])}
        nowMs={clockNowMs}
        asOfMs={lastGoodCheckAt}
        loadedWindowMs={rollingExperimentHistoryMs}
        backTo={from === "bench"
          ? { label: "Bench", route: { view: "bench", pot: null } }
          : experimentContext
            ? { label: `${experimentContext.name} · Traces`, route: { view: "experiment", experiment: experimentContext.id, tab: "pots", pot: null } }
            : { label: "Experiments", route: { view: "home" } }}
      /></FeatureBoundary>
    );
  };

  const pocketActive = route.view === "pocket" || (atBench && (route.view === "home" || route.view === "pot"));
  if (pocketActive && projectAccess) {
    const pocketPot = route.view === "pocket" ? route.pot : route.view === "pot" ? route.pot : null;
    return (
      <main className="px-shell">
        <FeatureBoundary name="At the bench" fallback={<FeatureLoading name="At the bench" />}>
          <PocketView
            key={`${outboxScope?.userId}:${activeProjectId}:${activeDeviceId}`}
            potKey={pocketPot}
            writing={route.view === "pocket" && route.note}
            userId={outboxScope?.userId ?? "signed-out"}
            projectId={activeProjectId}
            deviceId={activeDeviceId}
            canWrite={canWriteNotes}
            pairings={visiblePairings}
            experiments={availableExperiments}
            readings={currentPairingReadings}
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
            onManualWater={manualWaterAvailable ? openManualWater : undefined}
          />
        </FeatureBoundary>
        <AutocalRunBanner onOpen={openAutocalibrate} />
        {manualWaterPanel}
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
          readings={currentPairingReadings}
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
    const tab = route.tab === "record" && !recordAvailable ? "pots" : route.tab;
    return productShell(
      <ExperimentPage
        experiment={routeExperiment}
        tab={tab}
        onExport={() => setExportOpen(true)}
        exceptions={portalExceptions}
        recordAvailable={recordAvailable}
        secondaryActions={canUseExperimentSettings ? <>
          <button onClick={() => { setEditingExperiment(routeExperiment);setDuplicateExperiment(null);setExperimentBuilderOpen(true); }}>Edit experiment</button>
          <button onClick={() => { setSettingsSection("overview");prefetchSettings();setSettingsOpen(true); }}>Settings</button>
          <button onClick={() => { setEditingExperiment(null);setDuplicateExperiment(routeExperiment);setExperimentBuilderOpen(true); }}>Duplicate experiment</button>
        </> : null}
        actions={<button className="px-button is-small" onClick={() => setExportOpen(true)}>Export</button>}
      >
        {tab === "record" ? (
          <FeatureBoundary name="Record" fallback={<FeatureLoading name="Record" />}><RecordView
            key={`${portalAccess.userId}:${activeProjectId}:${activeDeviceId}:${routeExperiment.id}`}
            experiment={routeExperiment}
            projectId={activeProjectId}
            deviceId={activeDeviceId}
            pairings={visiblePairings}
            nowMs={clockNowMs}
            userId={portalAccess.userId ?? null}
          /></FeatureBoundary>
        ) : (
          <div className="px-pots-tab">
            {experimentArchive.loading ? <p className="px-loaded-range" role="status">Loading experiment data… {experimentArchive.progress.toLocaleString()} readings</p> : null}
            {experimentArchive.error ? <p className="px-notice is-bad" role="alert">Full experiment data could not be loaded. The graph shows the available readings. <button className="px-button is-small" onClick={experimentArchive.retry}>Retry</button></p> : null}
            <div className="px-pot-chart" aria-label="Pot traces">{potsTabContent}</div>
          </div>
        )}
        {route.pot ? <PotInspector onClose={()=>navigatePortal({view:"experiment",experiment:routeExperiment.id,tab,pot:null})}>{renderPotPage(route.pot,routeExperiment)}</PotInspector> : null}
      </ExperimentPage>,
    );
  }

  const supportThreads = salesSupportData.threads.filter((item) => item.request_type !== "quote" && item.source !== "quote");
  const openSupportCount = supportThreads.filter((item) => item.status !== "closed" && item.status !== "won" && item.status !== "lost").length;
  const newSupportCount = supportThreads.filter((item) => item.status === "new").length;
  const quoteCount = salesSupportData.quotes.filter((item) => item.status !== "closed" && item.status !== "won" && item.status !== "lost").length;

  const adminTools = isAdmin ? (
    <>
      {canUseSalesSupport ? <div className="portal-compact-row">
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
      </div> : null}
      <div className="portal-compact-row">
        <WebsiteAnalyticsTile onOpen={() => setPortalView("analytics")} />
      </div>
    </>
  ) : null;

  return productShell(
    <QuietSpineHome
      experiments={availableExperiments}
      systemName={isDemo ? undefined : "Rhee Lab"}
      exceptions={portalExceptions}
      nowMs={clockNowMs}
      checking={Boolean(activeDeviceId) && lastGoodCheckAt == null && refreshFailedAt == null}
      catalogError={experimentCatalogError}
      installation={installationState}
      canCreate={canCreateExperiment && catalogReady && Boolean(configState?.updated_at)}
      onNewExperiment={() => {
        setEditingExperiment(null);
        setDuplicateExperiment(null);
        setExperimentBuilderOpen(true);
      }}
      onEditExperiment={(experiment) => {
        setEditingExperiment(experiment);
        setExperimentBuilderOpen(true);
      }}
      onArchiveExperiment={!isDemo ? setArchivingExperiment : undefined}
      healthLink={!isDemo && (canUseExperimentSettings || isAdmin) ? <div className="px-node-actions">
        {isAdmin ? <PortalLink to={{ view: "health" }}>System health →</PortalLink> : null}
        {canUseExperimentSettings ? <PortalLink to={{ view: "autocalibrate" }}>Autocalibrate →</PortalLink> : null}
      </div> : undefined}
      machines={!isDemo ? <>
        {isAdmin ? <WalkerMachineTile onOpen={() => setPortalView("walker")} onOpenExperiment={id => navigatePortal({ view: "walker" }, { extra: { study: id } })} /> : null}
        {isAdmin || portalAccess.gasMixerAllowed ? <SystemSection name="Chamber" defaultExpanded={false} description="Gas mixer · Lighting" action={<button type="button" className="px-button" onClick={() => setPortalView("chamber")}>Open system</button>}><p className="px-system-description">Control and schedules</p></SystemSection> : null}
      </> : undefined}
      tools={isDemo ? undefined : adminTools ?? (portalAccess.gasMixerAllowed ? <GasMixerResearcherTile onOpen={() => setPortalView("chamber")} /> : undefined)}
      recordAvailable={recordAvailable}
    />,
  );
}
