import {
  Fragment,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  AlertTriangle,
  Bell,
  CalendarClock,
  Check,
  Loader2,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  X,
} from "lucide-react";
import {
  applyLifecycle,
  cancelAutomation,
  createMonitor,
  createSchedule,
  draftMonitor,
  draftSchedule,
  preflightLifecycle,
  type LifecyclePreflight,
  type MonitorPlan,
  type SchedulePlan,
} from "./experimentClient";
import { settingsCommandLabel } from "./settingsSpec";
import { supabase } from "./supabase";

function inlineText(value: string) {
  return value.split(/(\*\*[^*]+\*\*)/g).filter(Boolean).map((part, index) =>
    part.startsWith("**") && part.endsWith("**")
      ? <strong key={`${part}-${index}`}>{part.slice(2, -2)}</strong>
      : <Fragment key={`${part}-${index}`}>{part}</Fragment>
  );
}

export function AssistantMessageBody({ content }: { content: string }) {
  const lines = content.split(/\n/).map((line) => line.trim()).filter(Boolean);
  const output: ReactNode[] = [];
  let list: string[] = [];
  const flushList = () => {
    if (!list.length) return;
    const items = list;
    list = [];
    output.push(
      <ul key={`list-${output.length}`}>
        {items.map((item, index) => <li key={`${item}-${index}`}>{inlineText(item)}</li>)}
      </ul>,
    );
  };
  lines.forEach((line) => {
    if (/^[-*]\s+/.test(line)) {
      list.push(line.replace(/^[-*]\s+/, ""));
      return;
    }
    flushList();
    output.push(<p key={`paragraph-${output.length}`}>{inlineText(line)}</p>);
  });
  flushList();
  return <>{output}</>;
}

type ReviewProps = {
  projectId: string;
  initialPrompt: string;
  onClose: () => void;
  onChanged: () => void;
};

export function ScheduleReview({
  projectId,
  initialPrompt,
  onClose,
  onChanged,
}: ReviewProps) {
  const [plan, setPlan] = useState<SchedulePlan | null>(null);
  const [reviewToken, setReviewToken] = useState("");
  const [revision, setRevision] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(true);
  const [complete, setComplete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timezone = useMemo(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    [],
  );

  const build = useCallback(async (request: string, current?: SchedulePlan) => {
    setBusy(true);
    setError(null);
    try {
      const result = await draftSchedule(projectId, request, timezone, current);
      setPlan(result.plan);
      setReviewToken(result.review_token);
      setConfirmed(false);
      setRevision("");
      if (result.validation_messages.length) {
        setError(result.validation_messages.join(" "));
      }
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Could not review the schedule.");
    } finally {
      setBusy(false);
    }
  }, [projectId, timezone]);

  useEffect(() => {
    void build(initialPrompt);
  }, [build, initialPrompt]);

  const approve = async () => {
    if (!plan || !reviewToken || !confirmed || plan.questions.length) return;
    setBusy(true);
    setError(null);
    try {
      await createSchedule(projectId, plan, reviewToken);
      setComplete(true);
      onChanged();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Could not create the schedule.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="portal-inline-settings assistant-operation-review">
      <header>
        <h2>Review schedule</h2>
        <button type="button" onClick={onClose} aria-label="Close schedule review">
          <X size={17} />
        </button>
      </header>
      {busy && !plan ? (
        <div className="assistant-operation-loading">
          <Loader2 className="chart-loading-spinner" size={17} />
          Building the schedule
        </div>
      ) : complete && plan ? (
        <div className="assistant-operation-complete">
          <Check size={18} />
          <div>
            <strong>{plan.name} scheduled</strong>
            <p>{new Date(plan.run_at ?? "").toLocaleString()} · {plan.recurrence}</p>
          </div>
          <button type="button" className="settings-secondary-button" onClick={onClose}>Done</button>
        </div>
      ) : plan ? (
        <div className="assistant-operation-body">
          <div className="assistant-operation-summary">
            <CalendarClock size={19} />
            <div>
              <strong>{plan.name}</strong>
              <p>
                {plan.run_at ? new Date(plan.run_at).toLocaleString() : "Time required"}
                {" · "}{plan.recurrence}
              </p>
            </div>
          </div>
          <div className="assistant-operation-command-list">
            {plan.settings_plan.commands.map((command, index) => (
              <div key={`${command.command_type}-${index}`}>
                <strong>{settingsCommandLabel(command.command_type)}</strong>
                <span>{command.effect}</span>
              </div>
            ))}
          </div>
          {plan.questions.length ? (
            <div className="settings-callout is-error">
              <AlertTriangle size={17} />
              <div>{plan.questions.map((question) => <p key={question}>{question}</p>)}</div>
            </div>
          ) : null}
          <div className="settings-assistant-revise">
            <input
              value={revision}
              onChange={(event) => setRevision(event.target.value)}
              placeholder="Change this schedule"
            />
            <button
              type="button"
              className="settings-secondary-button"
              onClick={() => void build(revision, plan)}
              disabled={busy || !revision.trim()}
            >
              Revise
            </button>
          </div>
          <label className="settings-assistant-confirm">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            I reviewed the time and changes.
          </label>
          <button
            type="button"
            className="settings-primary-button"
            disabled={busy || !confirmed || plan.questions.length > 0}
            onClick={() => void approve()}
          >
            {busy ? <Loader2 className="chart-loading-spinner" size={15} /> : <CalendarClock size={15} />}
            Create schedule
          </button>
        </div>
      ) : null}
      {error ? <p className="settings-error-line" role="alert">{error}</p> : null}
    </section>
  );
}

function monitorCondition(plan: MonitorPlan) {
  if (plan.metric === "controller_health") return "Controller becomes unhealthy";
  if (plan.metric === "sensor_stale") {
    return `No reading for ${plan.window_minutes} minutes`;
  }
  const direction = {
    above: "above",
    below: "below",
    increase_by: "increases by",
    decrease_by: "decreases by",
    stale: "stale",
    unhealthy: "unhealthy",
  }[plan.comparator];
  return `${direction} ${plan.threshold}% within ${plan.window_minutes} minutes`;
}

export function MonitorReview({
  projectId,
  initialPrompt,
  onClose,
  onChanged,
}: ReviewProps) {
  const [plan, setPlan] = useState<MonitorPlan | null>(null);
  const [reviewToken, setReviewToken] = useState("");
  const [revision, setRevision] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(true);
  const [complete, setComplete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const build = useCallback(async (request: string, current?: MonitorPlan) => {
    setBusy(true);
    setError(null);
    try {
      const result = await draftMonitor(projectId, request, current);
      setPlan(result.plan);
      setReviewToken(result.review_token);
      setConfirmed(false);
      setRevision("");
      if (result.validation_messages.length) setError(result.validation_messages.join(" "));
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Could not review the monitor.");
    } finally {
      setBusy(false);
    }
  }, [projectId]);

  useEffect(() => {
    void build(initialPrompt);
  }, [build, initialPrompt]);

  const approve = async () => {
    if (!plan || !reviewToken || !confirmed || plan.questions.length) return;
    setBusy(true);
    setError(null);
    try {
      await createMonitor(projectId, plan, reviewToken);
      setComplete(true);
      onChanged();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Could not create the monitor.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="portal-inline-settings assistant-operation-review">
      <header>
        <h2>Review monitor</h2>
        <button type="button" onClick={onClose} aria-label="Close monitor review">
          <X size={17} />
        </button>
      </header>
      {busy && !plan ? (
        <div className="assistant-operation-loading">
          <Loader2 className="chart-loading-spinner" size={17} />
          Building the monitor
        </div>
      ) : complete && plan ? (
        <div className="assistant-operation-complete">
          <Check size={18} />
          <div>
            <strong>{plan.name} is active</strong>
            <p>ExactH2O will check every {plan.check_every_minutes} minutes.</p>
          </div>
          <button type="button" className="settings-secondary-button" onClick={onClose}>Done</button>
        </div>
      ) : plan ? (
        <div className="assistant-operation-body">
          <div className="assistant-operation-summary">
            <Bell size={19} />
            <div>
              <strong>{plan.name}</strong>
              <p>{plan.experiment ?? "System"} · {monitorCondition(plan)}</p>
            </div>
          </div>
          {plan.pairing_names.length ? (
            <div className="assistant-operation-pots">
              {plan.pairing_names.map((pairing) => (
                <span key={pairing}>{pairing.replace(/^Zone(\d+)-Pot/, "Z$1 · Pot ")}</span>
              ))}
            </div>
          ) : null}
          {plan.questions.length ? (
            <div className="settings-callout is-error">
              <AlertTriangle size={17} />
              <div>{plan.questions.map((question) => <p key={question}>{question}</p>)}</div>
            </div>
          ) : null}
          <div className="settings-assistant-revise">
            <input
              value={revision}
              onChange={(event) => setRevision(event.target.value)}
              placeholder="Change this monitor"
            />
            <button
              type="button"
              className="settings-secondary-button"
              onClick={() => void build(revision, plan)}
              disabled={busy || !revision.trim()}
            >
              Revise
            </button>
          </div>
          <label className="settings-assistant-confirm">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            Create this portal alert.
          </label>
          <button
            type="button"
            className="settings-primary-button"
            disabled={busy || !confirmed || plan.questions.length > 0}
            onClick={() => void approve()}
          >
            {busy ? <Loader2 className="chart-loading-spinner" size={15} /> : <Bell size={15} />}
            Start monitoring
          </button>
        </div>
      ) : null}
      {error ? <p className="settings-error-line" role="alert">{error}</p> : null}
    </section>
  );
}

export function LifecycleReview({
  projectId,
  request,
  onClose,
  onChanged,
}: {
  projectId: string;
  request: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const parsed = useMemo(() => {
    try {
      const value = JSON.parse(request) as {
        experiment?: string;
        action?: "complete" | "restore";
      };
      return {
        experiment: value.experiment ?? "",
        action: value.action === "restore" ? "restore" as const : "complete" as const,
      };
    } catch {
      return { experiment: request, action: "complete" as const };
    }
  }, [request]);
  const [review, setReview] = useState<LifecyclePreflight | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(true);
  const [complete, setComplete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setBusy(true);
    void preflightLifecycle(projectId, parsed.experiment, parsed.action)
      .then((value) => {
        if (active) setReview(value);
      })
      .catch((nextError) => {
        if (active) {
          setError(nextError instanceof Error ? nextError.message : "Could not review the action.");
        }
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [parsed.action, parsed.experiment, projectId]);

  const apply = async () => {
    if (!review || !review.can_apply || !confirmed) return;
    setBusy(true);
    setError(null);
    try {
      await applyLifecycle(projectId, review);
      setComplete(true);
      onChanged();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Could not apply the action.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="portal-inline-settings assistant-operation-review">
      <header>
        <h2>{parsed.action === "restore" ? "Restore experiment" : "Complete experiment"}</h2>
        <button type="button" onClick={onClose} aria-label="Close lifecycle review">
          <X size={17} />
        </button>
      </header>
      {busy && !review ? (
        <div className="assistant-operation-loading">
          <Loader2 className="chart-loading-spinner" size={17} />
          Checking the experiment
        </div>
      ) : complete && review ? (
        <div className="assistant-operation-complete">
          <Check size={18} />
          <div>
            <strong>{review.experiment_name} updated</strong>
            <p>Its readings and history remain saved.</p>
          </div>
          <button type="button" className="settings-secondary-button" onClick={onClose}>Done</button>
        </div>
      ) : review ? (
        <div className="assistant-operation-body">
          <div className="assistant-operation-summary">
            <RotateCcw size={19} />
            <div>
              <strong>{review.experiment_name}</strong>
              <p>{review.reason}</p>
            </div>
          </div>
          {!review.can_apply ? (
            <div className="settings-callout is-error">
              <AlertTriangle size={17} />
              <p>No change was made.</p>
            </div>
          ) : (
            <>
              <label className="settings-assistant-confirm">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />
                I reviewed this lifecycle change.
              </label>
              <button
                type="button"
                className="settings-primary-button"
                disabled={busy || !confirmed}
                onClick={() => void apply()}
              >
                {busy ? <Loader2 className="chart-loading-spinner" size={15} /> : <Check size={15} />}
                {parsed.action === "restore" ? "Restore" : "Complete"}
              </button>
            </>
          )}
        </div>
      ) : null}
      {error ? <p className="settings-error-line" role="alert">{error}</p> : null}
    </section>
  );
}

type ScheduleRow = {
  id: string;
  name: string;
  status: string;
  recurrence: string;
  next_run_at: string | null;
  last_error: string | null;
};

type MonitorRow = {
  id: string;
  name: string;
  status: string;
  last_state: string;
  last_evaluated_at: string | null;
};

type MonitorEventRow = {
  id: string;
  monitor_id: string;
  state: string;
  summary: string;
  observed_at: string;
};

export function AssistantAutomationPanel({
  projectId,
  refreshKey,
}: {
  projectId: string;
  refreshKey: number;
}) {
  const [schedules, setSchedules] = useState<ScheduleRow[]>([]);
  const [monitors, setMonitors] = useState<MonitorRow[]>([]);
  const [events, setEvents] = useState<MonitorEventRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cancelCandidate, setCancelCandidate] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const [scheduleResult, monitorResult, eventResult] = await Promise.all([
      supabase
        .from("assistant_schedules")
        .select("id,name,status,recurrence,next_run_at,last_error")
        .eq("project_id", projectId)
        .order("created_at", { ascending: false })
        .limit(20),
      supabase
        .from("assistant_monitors")
        .select("id,name,status,last_state,last_evaluated_at")
        .eq("project_id", projectId)
        .order("created_at", { ascending: false })
        .limit(20),
      supabase
        .from("assistant_monitor_events")
        .select("id,monitor_id,state,summary,observed_at")
        .eq("project_id", projectId)
        .order("created_at", { ascending: false })
        .limit(10),
    ]);
    const firstError = scheduleResult.error ?? monitorResult.error ?? eventResult.error;
    if (firstError) setError(firstError.message);
    setSchedules((scheduleResult.data ?? []) as ScheduleRow[]);
    setMonitors((monitorResult.data ?? []) as MonitorRow[]);
    setEvents((eventResult.data ?? []) as MonitorEventRow[]);
    setLoading(false);
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const cancel = async (
    type: "schedule" | "monitor",
    id: string,
  ) => {
    const key = `${type}:${id}`;
    if (cancelCandidate !== key) {
      setCancelCandidate(key);
      return;
    }
    setError(null);
    try {
      await cancelAutomation(projectId, type, id);
      setCancelCandidate(null);
      await load();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Could not cancel the item.");
    }
  };

  if (!loading && !schedules.length && !monitors.length && !events.length) return null;
  return (
    <section className="assistant-automation-panel">
      <header>
        <div>
          <ShieldCheck size={17} />
          <h2>Automation</h2>
        </div>
        <button type="button" onClick={() => void load()} aria-label="Refresh automation">
          <RefreshCw size={15} />
        </button>
      </header>
      {loading ? (
        <div className="assistant-operation-loading">
          <Loader2 className="chart-loading-spinner" size={16} />
          Refreshing
        </div>
      ) : (
        <div className="assistant-automation-grid">
          {schedules.length ? (
            <div>
              <h3>Schedules</h3>
              {schedules.map((schedule) => (
                <article key={schedule.id}>
                  <CalendarClock size={15} />
                  <div>
                    <strong>{schedule.name}</strong>
                    <span>
                      {schedule.next_run_at
                        ? new Date(schedule.next_run_at).toLocaleString()
                        : schedule.status}
                      {" · "}{schedule.recurrence}
                    </span>
                    {schedule.last_error ? <em>{schedule.last_error}</em> : null}
                  </div>
                  {["active", "paused", "failed"].includes(schedule.status) ? (
                    <button
                      type="button"
                      onClick={() => void cancel("schedule", schedule.id)}
                    >
                      {cancelCandidate === `schedule:${schedule.id}` ? "Confirm" : "Cancel"}
                    </button>
                  ) : <span className={`assistant-state is-${schedule.status}`}>{schedule.status}</span>}
                </article>
              ))}
            </div>
          ) : null}
          {monitors.length ? (
            <div>
              <h3>Monitors</h3>
              {monitors.map((monitor) => (
                <article key={monitor.id}>
                  <Bell size={15} />
                  <div>
                    <strong>{monitor.name}</strong>
                    <span>
                      {monitor.last_state}
                      {monitor.last_evaluated_at
                        ? ` · ${new Date(monitor.last_evaluated_at).toLocaleString()}`
                        : " · waiting for first check"}
                    </span>
                  </div>
                  {["active", "paused"].includes(monitor.status) ? (
                    <button
                      type="button"
                      onClick={() => void cancel("monitor", monitor.id)}
                    >
                      {cancelCandidate === `monitor:${monitor.id}` ? "Confirm" : "Cancel"}
                    </button>
                  ) : <span className={`assistant-state is-${monitor.status}`}>{monitor.status}</span>}
                </article>
              ))}
            </div>
          ) : null}
        </div>
      )}
      {events.length ? (
        <div className="assistant-alert-feed">
          <h3>Recent alerts</h3>
          {events.map((event) => (
            <article key={event.id}>
              {event.state === "triggered" ? <AlertTriangle size={15} /> : <Check size={15} />}
              <div>
                <strong>{event.summary}</strong>
                <span>{new Date(event.observed_at).toLocaleString()}</span>
              </div>
            </article>
          ))}
        </div>
      ) : null}
      {error ? <p className="settings-error-line" role="alert">{error}</p> : null}
    </section>
  );
}
