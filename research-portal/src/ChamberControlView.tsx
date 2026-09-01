import {
  AlertTriangle,
  ArrowLeft,
  Eye,
  Loader2,
  MousePointer2,
  MonitorUp,
  RefreshCw,
  ShieldCheck,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  gasMixerAccessDenied,
  gasMixerSessionRenewalDelay,
  normalizedMixerPoint,
  type GasMixerSessionAccess,
  type GasMixerSessionMode,
  type GasMixerRemoteStatus,
} from "./chamberControl";
import {
  createGasMixerSession,
  endGasMixerSession,
  loadGasMixerRemoteStatus,
  refreshGasMixerFrame,
  refreshGasMixerSession,
  sendGasMixerTap,
} from "./chamberControlClient";
import { GasMixerNativeControl } from "./GasMixerNativeControl";
import { LightingNativeControl } from "./LightingNativeControl";

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
  const { denied } = useGasMixerStatus();
  if (denied) return null;

  return (
    <button
      type="button"
      className="portal-launch-card is-chamber-control"
      onClick={onOpen}
    >
      <span className="portal-launch-top">
        <span className="portal-launch-icon"><MonitorUp size={20} /></span>
      </span>
      <span className="portal-launch-copy">
        <span className="portal-launch-title">Chamber Control</span>
        <strong>Gas Mixer</strong>
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
  const [frameRefreshBusy, setFrameRefreshBusy] = useState(false);
  const frameRefreshTimer = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (frameRefreshTimer.current !== null) {
        window.clearTimeout(frameRefreshTimer.current);
        frameRefreshTimer.current = null;
      }
    };
  }, [session?.session.id]);

  const scheduleFrameRefresh = (delayMs: number) => {
    if (!session) return;
    if (frameRefreshTimer.current !== null) {
      window.clearTimeout(frameRefreshTimer.current);
    }
    frameRefreshTimer.current = window.setTimeout(() => {
      frameRefreshTimer.current = null;
      setFrameRevision((value) => value + 1);
    }, delayMs);
  };

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
        const message = error instanceof Error ? error.message : "";
        setSessionError(/invalid or expired/i.test(message)
          ? null
          : message || "The secure mixer session ended. Request control again.");
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

  const refreshFrameNow = async () => {
    if (!session || frameRefreshBusy) return;
    const activeSessionId = session.session.id;
    setFrameRefreshBusy(true);
    setSessionError(null);
    try {
      const refreshed = await refreshGasMixerFrame(session.session_token);
      setSession((current) => current?.session.id === activeSessionId
        ? { ...current, frame_url: refreshed.frame_url }
        : current);
      setFrameRevision((value) => value + 1);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to refresh the mixer screen";
      if (/invalid or expired/i.test(message)) setSession(null);
      setSessionError(message);
    } finally {
      setFrameRefreshBusy(false);
    }
  };

  const sendTap = async (event: React.MouseEvent<HTMLImageElement>) => {
    if (!session || session.session.mode !== "control") return;
    const point = normalizedMixerPoint(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect());
    setSessionError(null);
    setSessionNotice("Sending tap to the physical mixer…");
    try {
      await sendGasMixerTap(session.session_token, point.x, point.y);
      setSessionNotice("Tap delivered to the mixer agent");
      scheduleFrameRefresh(0);
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
          <button type="button" className="chamber-back-button" onClick={leaveChamber}>
            <ArrowLeft size={17} /> Back
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
            <GasMixerNativeControl />

            <section className="chamber-module is-gas-mixer">
              <header className="is-iconless">
                <div>
                  <h2>Gas Mixer</h2>
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
                    <span className="gas-mixer-session-buttons">
                      <button
                        type="button"
                        onClick={() => void refreshFrameNow()}
                        disabled={frameRefreshBusy}
                        aria-label="Refresh mixer screen"
                      >
                        {frameRefreshBusy
                          ? <Loader2 className="chart-loading-spinner" size={15} />
                          : <RefreshCw size={15} />}
                        {frameRefreshBusy ? "Refreshing" : "Refresh"}
                      </button>
                      <button type="button" onClick={() => void closeSession()} aria-label="End mixer session">
                        <X size={15} /> End
                      </button>
                    </span>
                  </div>
                  <img
                    src={frameUrl}
                    alt="Live image of the exact Raspberry Pi gas mixer interface"
                    onClick={(event) => void sendTap(event)}
                    onLoad={() => scheduleFrameRefresh(500)}
                    onError={() => scheduleFrameRefresh(1_500)}
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
                  <small>{statusTime(status?.last_seen_at)}</small>
                </div>
              )}

              {sessionError ? <p className="gas-mixer-session-error" role="alert">{sessionError}</p> : null}
              {sessionNotice ? <p className="gas-mixer-session-notice">{sessionNotice}</p> : null}

              {!session ? (
                <footer className="gas-mixer-actions-footer">
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
                </footer>
              ) : null}
            </section>

            <LightingNativeControl />
          </div>
        )}
      </section>
    </main>
  );
}
