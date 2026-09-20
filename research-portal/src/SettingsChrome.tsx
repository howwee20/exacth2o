import { useEffect, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, ArrowRight, Check, CheckCircle2, CircleHelp, Copy, Info, WifiOff, XCircle, type LucideIcon } from "lucide-react";
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

// Shown beside actions, never as a page banner: a request made while the
// controller is away is only queued, and must not read as if it took effect.
export function QueuedChangeNote({ presence }: { presence: ControllerPresence }) {
  if (presence.status === "online") return null;
  return (
    <p className="settings-queued-note" role="note">
      <WifiOff size={15} aria-hidden="true" />
      <span>
        {presence.status === "never"
          ? "The controller has not connected yet. A change you request here is only queued; nothing changes until the controller connects and confirms it."
          : "The controller is offline. A change you request here is only queued; nothing changes until the controller reconnects and confirms it."}
      </span>
    </p>
  );
}

export function ReadinessTile({
  icon: Icon,
  title,
  tone,
  status,
  lines,
  actionLabel,
  onAction,
}: {
  icon: LucideIcon;
  title: string;
  tone: StatusTone;
  status: string;
  lines: Array<{ label: string; value: ReactNode }>;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <section className="settings-readiness-tile">
      <header>
        <span className="settings-readiness-icon" aria-hidden="true"><Icon size={18} /></span>
        <h3>{title}</h3>
        <StatusChip tone={tone}>{status}</StatusChip>
      </header>
      <dl>
        {lines.map((line) => (
          <div key={line.label}>
            <dt>{line.label}</dt>
            <dd>{line.value}</dd>
          </div>
        ))}
      </dl>
      {actionLabel && onAction ? (
        <button type="button" className="settings-text-action" onClick={onAction}>
          {actionLabel} <ArrowRight size={14} aria-hidden="true" />
        </button>
      ) : null}
    </section>
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
