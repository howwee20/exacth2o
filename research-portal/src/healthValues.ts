import { formatSettingsTimestamp } from "./portalFormat";

export function healthRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function healthNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

export function healthString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function healthBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

export function healthTimestampMs(value: unknown): number | null {
  const textValue = healthString(value);
  if (!textValue) return null;
  const ms = Date.parse(textValue);
  return Number.isFinite(ms) ? ms : null;
}
export function healthDateWithAge(value: string | null | undefined) {
  if (!value) return "Not synced";
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return formatSettingsTimestamp(value);
  const ageMinutesValue = Math.max(0, Math.round((Date.now() - ms) / 60000));
  const age =
    ageMinutesValue < 1 ? "now" :
    ageMinutesValue < 60 ? `${ageMinutesValue}m ago` :
    `${Math.floor(ageMinutesValue / 60)}h ${ageMinutesValue % 60}m ago`;
  return `${formatSettingsTimestamp(value)} (${age})`;
}

export function healthAgeText(value: string | null | undefined) {
  if (!value) return "Not synced";
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return "Not synced";
  const ageMinutesValue = Math.max(0, Math.round((Date.now() - ms) / 60000));
  if (ageMinutesValue < 1) return "now";
  if (ageMinutesValue < 60) return `${ageMinutesValue}m ago`;
  return `${Math.floor(ageMinutesValue / 60)}h ${ageMinutesValue % 60}m ago`;
}

export function formatHealthDetailValue(value: number | null | undefined, unit = "") {
  if (value == null || !Number.isFinite(value)) return "No value";
  const rounded = Math.abs(value - Math.round(value)) < 0.001 ? String(Math.round(value)) : String(Number(value.toFixed(2)));
  return unit ? `${rounded}${unit}` : rounded;
}

export function healthEventText(value: unknown) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

export function healthFirstEventText(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = healthEventText(record[key]);
    if (value) return value;
  }
  return null;
}

export function healthFirstText(record: Record<string, unknown>, keys: string[]) {
  return healthFirstEventText(record, keys) ?? "Not synced";
}
