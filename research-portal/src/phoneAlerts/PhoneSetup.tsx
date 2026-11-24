import { useEffect, useState } from "react";
import { phoneSetupCode } from "./setupCode";
import { supabase } from "../supabase";

async function phone<T>(
  action: string,
  extra: Record<string, unknown> = {},
): Promise<T> {
  const { data, error } = await supabase.functions.invoke("phone-alerts", {
    body: { action, ...extra },
  });
  if (error) {
    const body = await error.context?.json?.().catch(() => null);
    throw new Error(body?.error || "Could not reach phone alerts. Try again.");
  }
  return data as T;
}
type PhoneStatus = { connected: boolean; publicKey: string };

export function PhoneSetup({
  projectId,
  onConnected,
  setupView = "new-experiment",
}: {
  projectId: string;
  onConnected?: (connected: boolean) => void;
  setupView?: "account" | "new-experiment";
}) {
  const [status, setStatus] = useState<PhoneStatus | null>(null);
  const [message, setMessage] = useState("");
  const [working, setWorking] = useState(false);
  const [qr, setQr] = useState("");
  const [refresh, setRefresh] = useState(0);
  const apple =
    /iPad|iPhone|iPod/i.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const needsHome =
    apple &&
    !matchMedia("(display-mode: standalone)").matches &&
    !(navigator as Navigator & { standalone?: boolean }).standalone;
  const supported =
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window;
  useEffect(() => {
    let active = true;
    phone<PhoneStatus>("status")
      .then((s) => {
        if (active) {
          setStatus(s);
          onConnected?.(s.connected);
        }
      })
      .catch((e) => {
        if (active) setMessage(e.message);
      });
    return () => {
      active = false;
    };
  }, [refresh, onConnected]);
  async function run(action: () => Promise<void>) {
    setWorking(true);
    setMessage("");
    try {
      await action();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Phone setup failed.");
    } finally {
      setWorking(false);
    }
  }
  async function connect() {
    if (!status) return;
    const permission = await Notification.requestPermission();
    if (permission !== "granted")
      throw new Error(
        "Allow notifications for ExactH2O in your browser or phone settings.",
      );
    const registration = await navigator.serviceWorker.register(
      "/portal-push.js",
      { scope: "/portal" },
    );
    await navigator.serviceWorker.ready;
    let sub = await registration.pushManager.getSubscription();
    if (!sub) {
      const bytes = Uint8Array.from(
        atob(status.publicKey.replace(/-/g, "+").replace(/_/g, "/")),
        (ch) => ch.charCodeAt(0),
      );
      sub = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: bytes,
      });
    }
    await phone("connect", { subscription: sub.toJSON() });
    setStatus({ ...status, connected: true });
    onConnected?.(true);
    setMessage("This device is connected.");
  }
  async function showCode() {
    setQr(await phoneSetupCode(projectId, setupView));
  }
  return (
    <div className="moisture-phone">
      {needsHome ? (
        <p>
          On iPhone or iPad, tap Share → Add to Home Screen. Open ExactH2O from its
          icon, sign in, then go to Account &amp; access → Notifications and tap Connect this phone.
        </p>
      ) : null}
      {!needsHome && !supported ? (
        <p>
          This browser cannot receive push alerts. Open setup on a supported
          phone.
        </p>
      ) : null}
      <div className="moisture-actions">
        {supported && !needsHome && (
          <button
          className="is-secondary moisture-key"
            type="button"
            disabled={!status || working}
            onClick={() => void run(connect)}
          >
            {status?.connected
              ? "Use this device for alerts"
              : apple || /Android|Mobile/i.test(navigator.userAgent) ? "Connect this phone" : "Connect this browser"}
          </button>
        )}
        <button
          className="is-secondary moisture-key"
          type="button"
          disabled={working}
          onClick={() => void run(showCode)}
        >
          Connect by QR code
        </button>
        {status?.connected && (
          <button
          className="is-secondary moisture-key"
            type="button"
            disabled={working}
            onClick={() =>
              void run(async () => {
                const result = await phone<{ status: string }>("test");
                setMessage(
                  result.status === "sent"
                    ? "Test accepted by the push service. Check your connected device."
                    : "Test " +
                        result.status +
                        ". Check the device connection.",
                );
              })
            }
          >
            Send test alert
          </button>
        )}
      </div>
      {qr && (
        <div className="moisture-qr">
          <img
            src={qr}
            alt="Scan to connect your phone to ExactH2O"
            width="176"
            height="176"
          />
          <p>
            Scan, sign in with the same account, and connect your phone. Then
            check the connection here.
          </p>
        </div>
      )}
      {(qr || !status) && (
        <button
          className="xb-link"
          type="button"
          disabled={working}
          onClick={() => {
            setMessage("");
            setRefresh((n) => n + 1);
          }}
        >
          Check connection
        </button>
      )}
      {status?.connected && (
        <details>
          <summary>Manage connected device</summary>
          <p>
            Alerts go to one device per account. Connecting another replaces it.
          </p>
          <button
          className="is-secondary moisture-key"
            type="button"
            disabled={working}
            onClick={() =>
              void run(async () => {
                await phone("disconnect");
                setStatus({ ...status, connected: false });
                onConnected?.(false);
                setMessage("Device disconnected for all experiments.");
              })
            }
          >
            Disconnect device from all experiments
          </button>
        </details>
      )}
      {message && <p role="status">{message}</p>}
    </div>
  );
}
