import { AlertTriangle,ArrowRight,Loader2,Mail,Maximize2,Minimize2,ShieldCheck } from "lucide-react";
import { type ReactNode,useCallback,useEffect,useMemo,useRef,useState } from "react";
import { ChamberControlView,ChamberHealthView,GasMixerResearcherHome,GasMixerResearcherView } from "./ChamberControlView";
import { WalkerHealthView,WalkerMachineTile } from "./WalkerObservationView";
import { WebsiteAnalyticsTile } from "./WebsiteAnalyticsTile";
import exactH2OLogo from "./assets/exacth2o-logo.jpeg";
import { AuthScreen } from "./auth/AuthScreen";
import {
authEventReload,
type AuthReloadState,
expiredPortalSessionNotice
} from "./authSession";
import { AutocalRunBanner } from "./autocalibrate/AutocalRunBanner";
import { autocalRunStore } from "./autocalibrate/runStore";
import { type BenchLayoutVersion,loadLatestBenchLayout,loadPotBindings,type PotBinding,recordBenchLayout } from "./benchClient";
import { SensorCanvasChart } from "./charts/SensorCanvasChart";
import { TimeRangeControl } from "./charts/TimeRangeControl";
import { filterSeriesByTime,timeBoundsForSeries } from "./charts/chartGeometry";
import { chartSeries } from "./charts/chartSeries";
import { useExpandedGraph } from "./charts/useExpandedGraph";
import { trackedCommandProgress } from "./commandLifecycle";
import { loadPortalExperimentCatalog } from "./experimentClient";
import { levelLabel } from "./experimentFactors";
import { experimentIsCompleted,orderHomeExperiments,pairingTargetText,targetLinesForPairings } from "./experimentMeasurement";
import { experimentGraphGroups,experimentSidebarGroups } from "./experimentPresentation";
import { deduplicateExperimentCatalog,type ExperimentId,isObservationOnlyExperiment,pairingsForExperiment,type PortalExperiment,portalExperimentById,valveEventsForExperiment } from "./experimentRegistry";
import { experimentTraceReadings } from "./experimentTraceReadings";
import { HealthSelectedDetailDrawer } from "./health/HealthPanels";
import { homeExceptions } from "./homeExceptions";
import { FeatureBoundary,FeatureLoading,lazyFeature } from "./lazyFeature";
import { formatMeasurementTime } from "./measurementFreshness";
import { usePageClock } from "./pageClock";
import { readingsForPairings } from "./pairingHistory";
import { hasExperimentSettingsAccess,hasProjectDataReadAccess,hasSalesSupportAccess } from "./portalAccess";
import { fullTimeWindow,rememberEmailKey } from "./portalConstants";
import { type DataMode,rollingExperimentHistoryMs,visibleExperimentPairings } from "./portalData";
import { errorMessage,runtimeStateIsFresh } from "./portalFormat";
import { orderedPairings,plantGroupForPairing,treatmentForPairing } from "./portalPresentation";
import { navigatePortal,type PortalRoute,settingsSectionFromSearch,usePortalRoute } from "./portalRoute";
import { portalSystemName } from "./portalProjectContext";
import { initialSalesSupportData } from "./portalState";
import { type ChartSeries,type DeviceConfigState,type DeviceHealthSnapshot,type DeviceRuntimeState,type ExperimentGraphMode,type HealthSelectedDetail,type LoadState,type PortalAccess,type PortalView,type PotPreset,type RefreshOptions,type SettingsSection,type TimeWindow } from "./portalTypes";
import { resolvePot } from "./potIdentity";
import { DirectExperiment } from './product/DirectExperiment';
import { ExperimentNotFound,ExperimentPage } from "./product/ExperimentPage";
import { ExperimentPotGroups } from "./product/ExperimentPotGroups";
import { FindPotDialog } from "./product/FindPotDialog";
import type { ManualWaterTarget } from "./product/ManualWaterPanel";
import { PortalLink } from "./product/PortalLink";
import { PotInspector } from './product/PotInspector';
import { ProductHeader } from "./product/ProductHeader";
import { type InstallationState,QuietSpineHome } from "./product/QuietSpineHome";
import { SavedTraceViews } from "./product/SavedTraceViews";
import { MachineHome, MachineTile, ProjectMachineTile } from "./product/MachineHome";
import { atBenchRemembered,rememberAtBench } from "./product/pocketMode";
import { toggleTraceSelection } from "./product/traceSelection";
import { useNoteOutbox } from "./product/useNoteOutbox";
import { controllerPresence } from "./settingsPresentation";
import { supabase } from "./supabase";
import { type PairingRow,type ValveEvent } from "./types";
import { useControllerCommands } from "./useControllerCommands";
import { useControllerStatus } from "./useControllerStatus";
import { clearExperimentArchives,useExperimentReadings } from "./useExperimentReadings";
import { usePortalAccess } from "./usePortalAccess";
import { usePortalAuth } from "./usePortalAuth";
import { usePortalCsv } from "./usePortalCsv";
import { usePortalReadings } from "./usePortalReadings";
import { useSalesSupport } from "./useSalesSupport";
import { createCoalescedTrigger } from "./visiblePolling";
import { ResearchWateringActivity } from "./watering/WateringActivity";
import { resolveHealthWateringEvents,valveEventsToHealthWateringEvents } from "./wateringEvents";
import { overlayTimeBounds } from "./wateringOverlay";
import { websiteAnalyticsReportCache } from "./websiteAnalyticsClient";


// Features loaded on first use: the sign-in page and home stay small, and admin-only views never
// reach researchers' browsers unless opened.
const loadSettingsPanel = () => import("./settings/PortalSettingsPanel").then((module) => ({ default: module.PortalSettingsPanel }));
const PortalSettingsPanel = lazyFeature(loadSettingsPanel);
const AutocalibratePage = lazyFeature(() => import("./autocalibrate/AutocalibratePage").then((module) => ({ default: module.AutocalibratePage })));
const AutocalibrateWorkspace = lazyFeature(() => import("./autocalibrate/AutocalibrateWorkspace").then((module) => ({ default: module.AutocalibrateWorkspace })));
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
/** Returning to the tab reconciles at most this often. */
const returnReconcileSpacingMs = 30_000;
/** After this long hidden, the return reconciliation reloads everything instead of the newest rows. */
const longAbsenceFullReloadMs = 6 * 60 * 60_000;

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



export default function App({ initialFindPot = false }: { initialFindPot?: boolean } = {}) {
  const [sessionReady, setSessionReady] = useState(false);
  const [sessionRevision, setSessionRevision] = useState(0);
  const authReloadState = useRef<AuthReloadState>({ userId: null, tokenExpiresAtMs: null });
  const [loading, setLoading] = useState(false);
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
  const defaultSystemExperiment = useMemo(
    () => orderHomeExperiments(availableExperiments, clockNowMs)[0] ?? null,
    [availableExperiments, clockNowMs],
  );
  const selectedExperiment = useMemo<PortalExperiment>(() => {
    if (route.view !== "controller") return portalExperimentById(selectedExperimentId, availableExperiments);
    return defaultSystemExperiment ?? {
      id: "system-readings",
      name: portalSystemName(portalAccess?.projectId ?? "", portalAccess?.projectName),
      shortDescription: "",
      mode: "observation",
      wateringState: "off",
      groupNames: [],
      pairingNames: visibleExperimentPairings(data.pairings).map(pairing => pairing.name),
      assignments: [],
    };
  }, [route.view, selectedExperimentId, availableExperiments, defaultSystemExperiment, portalAccess?.projectId, portalAccess?.projectName, data.pairings]);
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
    sessionReady && ((route.view === "experiment" && route.tab !== "record") || (route.view === "controller" && defaultSystemExperiment !== null)) && document.documentElement.dataset.portalMode !== "demo", portalAccess?.userId);
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
  const showChamberTile = portalAccess?.email?.trim().toLowerCase() === "alamriek@msu.edu";
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
    if (!sessionReady || !canReadProjectData || route.view !== "controller" || !defaultSystemExperiment || settingsOpen || settingsSectionFromSearch(window.location.search)) return;
    navigatePortal({ view: "experiment", experiment: defaultSystemExperiment.id, tab: "pots", pot: null }, { replace: true });
  }, [sessionReady, canReadProjectData, route.view, defaultSystemExperiment, settingsOpen]);

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



  if (uiExperimentId !== selectedExperiment.id) {
    setUiExperimentId(selectedExperiment.id);
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
  const { accessCheckError, loadPortalAccess } = usePortalAccess({ setAccessLoading, recoverPortalSession, setPortalAccess, expirePortalSession, setExperimentCatalog, setExperimentBuilderOpen, setEditingExperiment, setExperimentCatalogError });
  const { loadDeviceSyncState, loadValveEvents } = useControllerStatus({ isAdmin, activeProjectId, activeDeviceId, setHealthError, scopeKeyRef, setHealthHistory, setHealthSnapshot, canUseExperimentSettings, setRuntimeState, setConfigState, canReadProjectData, setValveEvents, valveEventsRef, valveLoadInFlightRef, sessionReady, portalView, experimentGraphMode });

  const { salesSupportData, setSalesSupportData, salesSupportLoading, setSalesSupportLoading, salesSupportError, setSalesSupportError, deleteQuoteRequest } = useSalesSupport({ canUseSalesSupport, activeProjectId, portalAccess, sessionReady });
  const { runPortalRefresh, runPortalRefreshRef, refresh } = usePortalReadings({ activeProjectId, activeDeviceId, scopeKeyRef, loadTokenRef, setError, setLoading, dataRef, selectedMode, recoverPortalSession, setConfigState, setData, setLastSuccessfulCheckAt, setRefreshFailedAt, expirePortalSession, realtimeRefreshInFlightRef, refreshInFlightRef, pendingRefreshRef, sessionReady, canReadProjectData, watchdogRefreshCountRef });

  runPortalRefreshRef.current = runPortalRefresh;
  const { exportingCsv, csvDownload, setCsvDownload, csvError, setCsvError, prepareCsvDownload, downloadPairingsCsv } = usePortalCsv({ route, experimentReadings, data, pairingByName, selectedExperiment, sortedPairings });
  const { controlBusy, setControlBusy, controlNotice, setControlNotice, trackedCommand, setTrackedCommand, controlError, setControlError, queueSettingsPlan, queueControlCommand } = useControllerCommands({ canUseExperimentSettings, activeProjectId, activeDeviceId, isAdmin, prepareCsvDownload, downloadPairingsCsv, configState, runtimeState, sessionReady, loadExperimentCatalog });


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
  }, [setControlBusy, setControlError, setControlNotice, setCsvDownload, setCsvError, setTermsAccepted, setTermsOpen]);

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
  }, [scopeKey, setTrackedCommand]);

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
  }, [loadPortalAccess, sessionReady, sessionRevision, setSalesSupportData]);

  useEffect(() => {
    if (!sessionReady || !canReadProjectData) return;
    void loadExperimentCatalog();
  }, [canReadProjectData, loadExperimentCatalog, sessionReady, sessionRevision]);

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
    ? activeDeviceId
      ? { status: "unknown", message: lastGoodCheckAt == null ? "Checking controller…" : "Awaiting first connection" }
      : { status: "hidden" }
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
  const routeExperiment = route.view === "controller" ? selectedExperiment : route.view === "experiment"
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

  const newExperimentPage = route.view === "new-experiment";
  const experimentBuilder = (experimentBuilderOpen || newExperimentPage) && canCreateExperiment ? (
    <FeatureBoundary name="Experiment builder"><ExperimentBuilder
      key={`${activeProjectId}:${newExperimentPage ? "new-experiment" : editingExperiment?.currentRevisionId ?? duplicateExperiment?.id ?? "new-experiment"}`}
      projectId={activeProjectId}
      pairings={visibleExperimentPairings(data.pairings)}
      experiments={availableExperiments}
      inventoryUpdatedAt={configState?.updated_at ?? null}
      direct
      experiment={newExperimentPage ? null : editingExperiment}
      template={newExperimentPage ? null : duplicateExperiment}
      presentation={newExperimentPage ? "inline" : "modal"}
      systemName={portalSystemName(activeProjectId, portalAccess?.projectName)}
      renderCalibration={(draft) => <FeatureBoundary name="Autocalibrate"><AutocalibrateWorkspace
        projectId={activeProjectId}
        deviceId={activeDeviceId || null}
        operator={portalAccess?.email ?? null}
        portalRole={portalAccess?.role ?? "viewer"}
        scope="experiment"
        experiment={{ id: !newExperimentPage && editingExperiment ? editingExperiment.id : "new-experiment", name: draft.name || "New experiment", shortDescription: draft.description, mode: draft.mode, groupNames: [], pairingNames: draft.assignments.map(assignment => assignment.pairing_name) }}
        experiments={availableExperiments}
        pairings={visiblePairings}
        configHash={configState?.config_hash?.trim() || null}
        controllerState={runtimeStateIsFresh(runtimeState) ? runtimeState?.controller_state ?? null : null}
        controllerOnline={presence?.status === "online"}
        controlBusy={controlBusy}
        onQueueSettingsPlan={queueSettingsPlan}
      /></FeatureBoundary>}
      onClose={() => {
        setExperimentBuilderOpen(false);
        setEditingExperiment(null);
        setDuplicateExperiment(null);
        if (newExperimentPage) navigatePortal({ view: "home" });
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
  if (!isAdmin && route.view === "chamber-health" && portalAccess.gasMixerAllowed) {
    return <main className="px-shell">{portalHeader}<ChamberHealthView onBack={() => setPortalView("home")} /></main>;
  }

  if (!projectAccess) {
    return (
      <main className="dashboard-shell portal-admin-shell">
        {portalHeader}
        <GasMixerResearcherHome
          allowed={showChamberTile && portalAccess.gasMixerAllowed}
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
                {(!isObservationOnlyExperiment(selectedExperiment) || experimentWateringEvents.length > 0 || visibleTargetLines.length > 0) ? (
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
      {!newExperimentPage ? experimentBuilder : null}
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

  const experimentHome = (
    <QuietSpineHome
      experiments={availableExperiments}
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
      recordAvailable={recordAvailable}
    />
  );

  if (route.view === "account" && !isDemo) {
    return productShell(<FeatureBoundary name="Account"><AccountPage key={activeProjectId} access={portalAccess} /></FeatureBoundary>);
  }
  if (newExperimentPage) {
    return productShell(<section className="px-page px-new-experiment-page">
      <PortalLink className="px-home-button" to={{ view: "home" }}>← Home</PortalLink>
      {!canCreateExperiment ? <p role="alert">Researcher or administrator access is required to create an experiment.</p>
        : experimentBuilder}
    </section>);
  }
  if (route.view === "autocalibrate" && canReadProjectData) {
    return productShell(<FeatureBoundary name="Autocalibrate"><AutocalibratePage
      systemName={portalSystemName(activeProjectId, portalAccess.projectName)}
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

  if (isAdmin && portalView === "analytics") {
    return productShell(
      <FeatureBoundary name="Web Analytics"><WebsiteAnalyticsWorkspace onBack={() => setPortalView("home")} /></FeatureBoundary>,
    );
  }

  if (canReadProjectData && portalView === "health") {
    return productShell(
      <FeatureBoundary name="System Health">
        <SystemHealthView
          systemName={portalSystemName(activeProjectId, portalAccess.projectName)}
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

  if (isAdmin && route.view === "walker-health") {
    return productShell(<WalkerHealthView onBack={() => setPortalView("home")} />);
  }
  if ((isAdmin || portalAccess.gasMixerAllowed) && route.view === "chamber-health") {
    return productShell(<ChamberHealthView onBack={() => setPortalView("home")} />);
  }

  if (isAdmin && (portalView === "walker" || route.view === "walker-home" || route.view === "walker-new-experiment")) {
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
          <PortalLink className="px-crumb" to={experimentContext ? { view: "experiment", experiment: experimentContext.id, tab: "pots", pot: null } : { view: isDemo ? "home" : "controller" }}>
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
            : { label: "Experiments", route: { view: isDemo ? "home" : "controller" } }}
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

  if (route.view === "experiment" || route.view === "controller") {
    if (!routeExperiment) {
      return productShell(<ExperimentNotFound id={route.view === "experiment" ? route.experiment : "system"} loading={!catalogReady || accessLoading} />);
    }
    const tab = route.view === "experiment" ? route.tab === "record" && !recordAvailable ? "pots" : route.tab : "pots";
    const pot = route.view === "experiment" ? route.pot : null;
    const savedExperiment = route.view === "experiment" || defaultSystemExperiment !== null;
    return productShell(
      <ExperimentPage
        experiment={routeExperiment}
        tab={tab}
        onExport={savedExperiment ? () => setExportOpen(true) : undefined}
        exceptions={portalExceptions}
        recordAvailable={recordAvailable && savedExperiment}
        secondaryActions={canUseExperimentSettings ? <>
          <button onClick={() => { setEditingExperiment(null);setDuplicateExperiment(null);setExperimentBuilderOpen(true); }}>Create experiment</button>
          {savedExperiment ? <>
          <button onClick={() => { setEditingExperiment(routeExperiment);setDuplicateExperiment(null);setExperimentBuilderOpen(true); }}>Edit experiment</button>
          <button onClick={() => navigatePortal({ view: "experiment", experiment: routeExperiment.id, tab: "pots", pot: null }, { extra: { settings: "overview" } })}>Settings</button>
          <button onClick={() => { setEditingExperiment(null);setDuplicateExperiment(routeExperiment);setExperimentBuilderOpen(true); }}>Duplicate experiment</button>
          </> : null}
        </> : null}
        actions={<>
          {availableExperiments.length > 1 ? <label className="px-select">Experiment<select aria-label="Experiment" value={routeExperiment.id} onChange={event => openExperiment(event.target.value)}>
            {orderHomeExperiments(availableExperiments, clockNowMs).map(experiment => <option key={experiment.id} value={experiment.id}>{experiment.name}</option>)}
          </select></label> : null}
          {savedExperiment ? <button className="px-button is-small" onClick={() => setExportOpen(true)}>Export</button> : null}
        </>}
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
            {experimentCatalogError ? <p className="px-notice" role="alert">The experiment list could not be refreshed. Showing available readings.</p> : null}
            {experimentArchive.loading ? <p className="px-loaded-range" role="status">Loading experiment data… {experimentArchive.progress.toLocaleString()} readings</p> : null}
            {experimentArchive.error ? <p className="px-notice is-bad" role="alert">Full experiment data could not be loaded. The graph shows the available readings. <button className="px-button is-small" onClick={experimentArchive.retry}>Retry</button></p> : null}
            <div className="px-pot-chart" aria-label="Pot traces">{potsTabContent}</div>
          </div>
        )}
        {pot ? <PotInspector onClose={()=>navigatePortal({view:"experiment",experiment:routeExperiment.id,tab,pot:null})}>{renderPotPage(pot,routeExperiment)}</PotInspector> : null}
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

  if (isDemo) return productShell(experimentHome);

  const systemName = portalSystemName(activeProjectId, portalAccess.projectName);
  const systemStatus = installationState.status === "online" ? "Online"
    : installationState.status === "offline" ? "Offline"
    : installationState.status === "unknown" && installationState.message ? installationState.message
    : "Status unavailable";
  return productShell(
    <MachineHome tools={adminTools}>
      <MachineTile name={systemName}
        detail={defaultSystemExperiment && !experimentIsCompleted(defaultSystemExperiment, clockNowMs) ? defaultSystemExperiment.name
          : experimentCatalogError ? "Experiment unavailable" : catalogReady ? "No active experiment" : "Loading experiment…"}
        status={systemStatus} to={{ view: "controller" }} healthTo={{ view: "health" }}
        creation={canCreateExperiment ? { to: { view: "new-experiment" } } : { unavailable: "Researcher or administrator access is required." }} />
      {portalAccess.projectDirectory?.filter(project => project.id !== activeProjectId).map(project =>
        <ProjectMachineTile key={project.id} projectId={project.id} name={project.name} />,
      )}
      {isAdmin ? <WalkerMachineTile /> : null}
      {showChamberTile && (isAdmin || portalAccess.gasMixerAllowed) ? <MachineTile name="Chamber" detail="No active experiment" to={{ view: "chamber" }} healthTo={{ view: "chamber-health" }} creation={{ unavailable: "Experiment creation is not available for Chamber yet." }} /> : null}
    </MachineHome>,
  );
}
