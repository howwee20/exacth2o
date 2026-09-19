import { useEffect, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, Check, CheckCircle2, CircleHelp, Copy, Info, WifiOff, XCircle } from "lucide-react";
import { middleEllipsis, type ControllerPresence, type StatusTone } from "./settingsPresentation";
import "./settingsChrome.css";

const toneIcons = {
  ok: CheckCircle2,
  warning: AlertTriangle,
  bad: XCircle,
  unknown: CircleHelp,
  info: Info,
} as const;

// Status is always icon plus text, so it never depends on color alone.
export function StatusChip({ tone, children }: { tone: StatusTone; children: ReactNode }) {
  const Icon = toneIcons[tone];
  return (
    <span className={`settings-chip is-${tone}`}>
      <Icon size={13} aria-hidden="true" />
      <span>{children}</span>
    </span>
  );
}

export function CopyableId({ value, label, maxLength = 22 }: { value?: string | null; label: string; maxLength?: number }) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<number | null>(null);

  useEffect(() => () => {
    if (resetTimer.current != null) window.clearTimeout(resetTimer.current);
  }, []);

  if (!value) return <span className="settings-empty-value">Not reported</span>;

  async function copy() {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      if (resetTimer.current != null) window.clearTimeout(resetTimer.current);
      resetTimer.current = window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  }

  return (
    <span className="settings-copyable">
      <code title={value}>{middleEllipsis(value, maxLength)}</code>
      <button type="button" onClick={() => void copy()} aria-label={copied ? `${label} copied` : `Copy ${label}`}>
        {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
      </button>
      <span className="settings-visually-hidden" role="status">{copied ? `${label} copied` : ""}</span>
    </span>
  );
}

export function ControllerOfflineBanner({
  presence,
  formattedLastSeen,
}: {
  presence: ControllerPresence;
  formattedLastSeen: string;
}) {
  if (presence.status === "online") return null;
  const neverSeen = presence.status === "never";
  return (
    <div className="settings-offline-banner" role="status">
      <WifiOff size={18} aria-hidden="true" />
      <div>
        <strong>
          {neverSeen ? "The controller has not reported yet." : `Controller offline since ${formattedLastSeen}.`}
        </strong>
        <p>
          {neverSeen
            ? "Settings below come from the project records. Live status will appear once the controller connects."
            : "Everything below is the last known state. Changes you request are queued and only take effect after the controller reconnects and confirms them."}
        </p>
      </div>
    </div>
  );
}

export function SettingsEmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="settings-empty-state">
      <strong>{title}</strong>
      {children ? <p>{children}</p> : null}
    </div>
  );
}
