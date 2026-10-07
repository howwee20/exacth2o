import { supabase } from "./supabase";
import { withSupabaseTimeout } from "./supabaseTimeout";

export type AnalyticsReportName = "overview" | "acquisition" | "journeys" | "demo" | "quote" | "experience" | "quality";
export type AnalyticsRange = { preset: "7d" | "30d" | "90d" } | { start: string; end: string };
export type AnalyticsDevice = "all" | "desktop" | "mobile" | "tablet";

export type ReportEnvelope<T> = {
  status: "ready" | "setup" | "collecting" | "unavailable";
  report: string;
  updatedAt?: string | null;
  stale?: boolean;
  /** Part of the report could not be computed; shown, but not stored by the server. */
  partial?: boolean;
  failure?: string;
  dashboardUrl?: string | null;
  timezone?: string;
  range?: {
    start: string;
    end: string;
    days: number;
    preset: string | null;
    includesToday: boolean;
    previousStart: string;
    previousEnd: string;
    device: AnalyticsDevice;
    timezone: string;
  };
} & Partial<T>;

export function reportKey(report: AnalyticsReportName, range: AnalyticsRange, device: AnalyticsDevice) {
  return JSON.stringify([report, "preset" in range ? range.preset : `${range.start}..${range.end}`, device]);
}

/**
 * Small bounded cache of report responses for this page. Switching tabs or
 * filters back and forth does not refetch; the server keeps its own
 * five-minute cache and refresh lease.
 */
export class ReportCache {
  private entries = new Map<string, { at: number; value: ReportEnvelope<unknown> }>();
  constructor(private readonly limit = 24, private readonly maxAgeMs = 60_000) {}

  get(key: string, nowMs = Date.now()) {
    const entry = this.entries.get(key);
    if (!entry || nowMs - entry.at > this.maxAgeMs) return null;
    return entry.value;
  }

  /** Last value regardless of age, for showing while a refresh runs. */
  peek(key: string) {
    return this.entries.get(key)?.value ?? null;
  }

  set(key: string, value: ReportEnvelope<unknown>, nowMs = Date.now()) {
    this.entries.delete(key);
    this.entries.set(key, { at: nowMs, value });
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  get size() {
    return this.entries.size;
  }
}

/**
 * Which of two answers for the same report to show. Responses can arrive out of order, and
 * while another request holds the server's refresh lease an answer may be "collecting" with no
 * rows: a stored report is never replaced by one without rows or by an older stored report.
 */
export function preferReport<T>(current: ReportEnvelope<T> | null, next: ReportEnvelope<T>) {
  if (!current || current.status !== "ready") return next;
  if (next.status !== "ready") return current;
  return (next.updatedAt ?? "") >= (current.updatedAt ?? "") ? next : current;
}

export async function fetchReport<T>(report: AnalyticsReportName, range: AnalyticsRange, device: AnalyticsDevice) {
  const response = await withSupabaseTimeout(
    (signal) => supabase.functions.invoke<ReportEnvelope<T>>("website-analytics", { body: { report, range, device }, signal }),
    30_000,
    "Website analytics",
  );
  if (response.error || !response.data?.status) throw response.error ?? new Error("Analytics unavailable");
  return response.data;
}
