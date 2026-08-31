import {
  AlertTriangle,
  ArrowLeft,
  Eye,
  Lightbulb,
  Loader2,
  MousePointer2,
  MonitorUp,
  Radio,
  ShieldCheck,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import {
  gasMixerAccessDenied,
  gasMixerSessionRenewalDelay,
  gasMixerStatusLabel,
  normalizedMixerPoint,
  type GasMixerSessionAccess,
  type GasMixerSessionMode,
  type GasMixerRemoteStatus,
} from "./chamberControl";
import {
  createGasMixerSession,
  endGasMixerSession,
  loadGasMixerRemoteStatus,
  refreshGasMixerSession,
  sendGasMixerTap,
} from "./chamberControlClient";

function statusTime(value: string | null | undefined) {
  if (!value) return "No device heartbeat yet";
  return `Last device heartbeat ${new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value))}`;
}

function useGasMixerStatus() {
  const [status, setStatus] = useState<GasMixerRemoteStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    const refresh = () => {
      loadGasMixerRemoteStatus()
        .then((nextStatus) => {
          if (!active) return;
          setStatus(nextStatus);
          setDenied(false);
          setFailed(false);
        })
        .catch((error: { code?: string; message?: string }) => {
          if (!active) return;
          setDenied(gasMixerAccessDenied(error));
          setFailed(!gasMixerAccessDenied(error));
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    };

    refresh();
    const timer = window.setInterval(refresh, 15_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  return { status, loading, denied, failed };
}

export function ChamberControlAdminTile({ onOpen }: { onOpen: () => void }) {
  const { status, loading, denied, failed } = useGasMixerStatus();
  if (denied) return null;

  return (
    <button
      type="button"
      className="portal-launch-card is-chamber-control"
      onClick={onOpen}
    >
      <span className="portal-launch-top">
        <span className="portal-launch-icon"><MonitorUp size={20} /></span>
        <span className={`portal-experiment-progress ${status?.online ? "is-running" : "is-failed"}`}>
          {loading ? <Loader2 size={12} /> : failed ? <AlertTriangle size={12} /> : <Radio size={12} />}
          {loading ? "Checking" : failed ? "Unavailable" : status?.online ? "Online" : "Agent pending"}
        </span>
      </span>
      <span className="portal-launch-copy">
        <span className="portal-launch-title">Chamber Control</span>
        <strong>Gas Mixer</strong>
        <em>{failed ? "Status check failed" : gasMixerStatusLabel(status)}</em>
        <em>Lighting automation · next integration</em>
      </span>
    </button>
  );
}

export function ChamberControlView({ onBack }: { onBack: () => void }) {
  const { status, loading, denied, failed } = useGasMixerStatus();
  const [session, setSession] = useState<GasMixerSessionAccess | null>(null);
  const [sessionBusy, setSessionBusy] = useState<GasMixerSessionMode | "end" | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [sessionNotice, setSessionNotice] = useState<string | null>(null);
  const [frameRevision, setFrameRevision] = useState(0);

  useEffect(() => {
    if (!session) return undefined;
    const timer = window.setInterval(() => setFrameRevision((value) => value + 1), 750);
    return () => window.clearInterval(timer);
  }, [session]);

  useEffect(() => {
    if (!session) return undefined;
    let cancelled = false;
    let timer: number | undefined;
    const activeSessionId = session.session.id;

    const renew = async () => {
      try {
        const renewed = await refreshGasMixerSession(session.session_token);
        if (cancelled) return;
        setSession((current) => current?.session.id === activeSessionId ? renewed : current);
        setSessionError(null);
      } catch (error) {
        if (cancelled) return;
        const remainingMs = Date.parse(session.session.expires_at) - Date.now();
        if (remainingMs > 10_000) {
          timer = window.setTimeout(() => void renew(), 5_000);
          return;
        }
        setSession((current) => current?.session.id === activeSessionId ? null : current);
        setSessionNotice(null);
        setSessionError(error instanceof Error
          ? error.message
          : "The secure mixer session ended. Request control again.");
      }
    };

    timer = window.setTimeout(
      () => void renew(),
      gasMixerSessionRenewalDelay(session.session.expires_at),
    );
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [session]);

  const beginSession = async (mode: GasMixerSessionMode) => {
    setSessionBusy(mode);
    setSessionError(null);
    setSessionNotice(null);
    try {
      setSession(await createGasMixerSession(mode));
      setFrameRevision(0);
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : "Unable to start the mixer session");
    } finally {
      setSessionBusy(null);
    }
  };

  const closeSession = async () => {
    const activeSession = session;
    setSession(null);
    setSessionError(null);
    setSessionNotice(null);
    if (!activeSession) return;
    setSessionBusy("end");
    try {
      await endGasMixerSession(activeSession.session_token);
    } catch {
      // The five-minute server expiry remains authoritative if the close request fails.
    } finally {
      setSessionBusy(null);
    }
  };

  const leaveChamber = () => {
    void closeSession();
    onBack();
  };

  const sendTap = async (event: React.MouseEvent<HTMLImageElement>) => {
    if (!session || session.session.mode !== "control") return;
    const point = normalizedMixerPoint(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect());
    setSessionError(null);
    setSessionNotice("Sending tap to the physical mixer…");
    try {
      await sendGasMixerTap(session.session_token, point.x, point.y);
      setSessionNotice("Tap delivered to the mixer agent");
    } catch (error) {
      setSessionNotice(null);
      const message = error instanceof Error ? error.message : "Unable to send mixer input";
      if (/invalid or expired/i.test(message)) setSession(null);
      setSessionError(message);
    }
  };

  const frameUrl = session
    ? `${session.frame_url}${session.frame_url.includes("?") ? "&" : "?"}frame=${frameRevision}`
    : null;

  return (
    <main className="dashboard-shell chamber-control-shell">
      <section className="chamber-control-page">
        <header className="chamber-control-heading">
          <div>
            <span className="chamber-control-eyebrow">System admin · installation control</span>
            <h1>Chamber Control</h1>
            <p>One workspace for the chamber's gas environment and lighting system.</p>
          </div>
          <button type="button" className="header-action" onClick={leaveChamber}>
            <ArrowLeft size={15} /> Home
          </button>
        </header>

        {denied ? (
          <section className="chamber-access-denied" role="alert">
            <ShieldCheck size={28} />
            <div>
              <h2>Installation permission required</h2>
              <p>A portal administrator role alone does not grant access to this chamber.</p>
            </div>
          </section>
        ) : (
          <div className="chamber-module-stack">
            <section className="chamber-module is-gas-mixer">
              <header>
                <span className="chamber-module-icon"><MonitorUp size={21} /></span>
                <div>
                  <span>Module 1</span>
                  <h2>Gas Mixer</h2>
                  <p>The exact interface running on the Raspberry Pi—never a reconstructed copy.</p>
                </div>
                <span className={`chamber-status ${status?.online ? "is-online" : "is-offline"}`}>
                  {loading ? "Checking" : status?.online ? "Online" : "Agent pending"}
                </span>
              </header>

              {session && frameUrl ? (
                <div className={`gas-mixer-live-stage is-${session.session.mode}`}>
                  <div className="gas-mixer-session-bar">
                    <span>
                      {session.session.mode === "control" ? <MousePointer2 size={15} /> : <Eye size={15} />}
                      {session.session.mode === "control" ? "Control session" : "View-only session"}
                    </span>
                    <small>Secure lease auto-renews while this page is open</small>
                    <button type="button" onClick={() => void closeSession()} aria-label="End mixer session">
                      <X size={15} /> End
                    </button>
                  </div>
                  <img
                    src={frameUrl}
                    alt="Live image of the exact Raspberry Pi gas mixer interface"
                    onClick={(event) => void sendTap(event)}
                    draggable={false}
                  />
                  {session.session.mode === "control" ? (
                    <p className="gas-mixer-control-note">Tap the image to operate that same point on the physical touchscreen.</p>
                  ) : null}
                </div>
              ) : (
                <div className="gas-mixer-stage" aria-live="polite">
                  {loading ? <Loader2 className="chart-loading-spinner" size={30} /> : null}
                  {!loading && failed ? <AlertTriangle size={30} /> : null}
                  {!loading && !failed ? <MonitorUp size={38} /> : null}
                  <strong>{failed ? "Connection status unavailable" : gasMixerStatusLabel(status)}</strong>
                  <p>
                    {status?.online
                      ? "The device agent is connected. Start a short-lived, audited session below."
                      : "The physical Pi and its mixer application remain unchanged while the outbound screen agent connects."}
                  </p>
                  <small>{statusTime(status?.last_seen_at)}</small>
                </div>
              )}

              {sessionError ? <p className="gas-mixer-session-error" role="alert">{sessionError}</p> : null}
              {sessionNotice ? <p className="gas-mixer-session-notice">{sessionNotice}</p> : null}

              <footer>
                <span><ShieldCheck size={15} /> Admin capability checked per installation</span>
                {!session ? (
                  <span className="gas-mixer-session-actions">
                    <button
                      type="button"
                      disabled={!status?.online || sessionBusy !== null}
                      onClick={() => void beginSession("view")}
                    >
                      {sessionBusy === "view" ? <Loader2 size={14} /> : <Eye size={14} />} Secure view
                    </button>
                    <button
                      type="button"
                      disabled={!status?.online || !status.remote_control_allowed || sessionBusy !== null}
                      onClick={() => void beginSession("control")}
                    >
                      {sessionBusy === "control" ? <Loader2 size={14} /> : <MousePointer2 size={14} />} Request control
                    </button>
                  </span>
                ) : null}
              </footer>
            </section>

            <section className="chamber-module is-lighting">
              <header>
                <span className="chamber-module-icon"><Lightbulb size={21} /></span>
                <div>
                  <span>Module 2 · next</span>
                  <h2>Lighting Automation</h2>
                  <p>The separate NetBeans/Windows controller will connect here after Gas Mixer validation.</p>
                </div>
                <span className="chamber-status is-planned">Planned</span>
              </header>
              <div className="lighting-preview" aria-label="Lighting controls planned for the next integration">
                <label><span>Light</span><input type="checkbox" disabled /></label>
                <label><span>Intensity</span><input type="range" min="0" max="100" value="0" readOnly disabled /></label>
              </div>
            </section>
          </div>
        )}
      </section>
    </main>
  );
}
