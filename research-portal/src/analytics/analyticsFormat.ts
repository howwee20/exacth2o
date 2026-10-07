/**
 * Formatting for website analytics. At ExactH2O's traffic levels the counts
 * are the finding; percentages are shown beside them, and small denominators
 * and missing baselines are said plainly instead of implying precision.
 */

/** Below this many in the denominator a percentage is labelled a small sample. */
export const smallSampleThreshold = 20;
/** Below this many observations a percentile is not shown. */
export const minPercentileSamples = 5;
export const collectionStartDate = "2026-10-01";

/** "1 failed attempt", "3 failed attempts". */
export function countLabel(value: number | null | undefined, singular: string, plural = `${singular}s`) {
  return `${formatCount(value)} ${value === 1 ? singular : plural}`;
}

export function formatCount(value: number | null | undefined) {
  return value == null || !Number.isFinite(value) ? "—" : Math.round(value).toLocaleString("en-US");
}

/** "3 of 12 (25%)"; "0 of 0" without a percentage. */
export function formatShare(part: number, whole: number) {
  if (!whole) return `${formatCount(part)} of ${formatCount(whole)}`;
  const percent = (part / whole) * 100;
  const digits = percent > 0 && percent < 10 ? 1 : 0;
  return `${formatCount(part)} of ${formatCount(whole)} (${percent.toFixed(digits)}%)`;
}

export function shareNote(whole: number) {
  return whole > 0 && whole < smallSampleThreshold ? "small sample" : null;
}

/**
 * Comparison text. A zero baseline has no meaningful percentage change, and a
 * baseline that starts before collection began is not a real baseline.
 */
export function formatChange(input: {
  value: number;
  previous: number | null;
  change: number | null;
  previousStart?: string | null;
}) {
  if (input.previousStart && input.previousStart < collectionStartDate) {
    return { text: "No comparison: previous period predates collection", tone: "neutral" as const };
  }
  if (input.previous == null) return { text: "No comparison", tone: "neutral" as const };
  if (input.previous === 0) {
    return { text: input.value === 0 ? "No change from 0" : `No comparison (previous period: 0)`, tone: "neutral" as const };
  }
  const change = input.change ?? (input.value - input.previous) / input.previous;
  const percent = Math.round(change * 100);
  const text = `${percent > 0 ? "+" : ""}${percent}% vs ${formatCount(input.previous)}`;
  return { text, tone: percent > 0 ? "up" as const : percent < 0 ? "down" as const : "neutral" as const };
}

export function formatDay(date: string, options: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" }) {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { ...options, timeZone: "UTC" });
}

export function formatRange(start: string, end: string) {
  const sameYear = start.slice(0, 4) === end.slice(0, 4);
  return `${formatDay(start, { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) })} – ${formatDay(end, { month: "short", day: "numeric", year: "numeric" })}`;
}

export function formatMs(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "—";
  return value >= 1000 ? `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)} s` : `${Math.round(value)} ms`;
}

export type VitalRating = "good" | "needs improvement" | "poor";

/** Core Web Vitals thresholds (web.dev), applied to the 75th percentile. */
export function rateVital(metric: "lcp" | "inp" | "cls", value: number | null | undefined): VitalRating | null {
  if (value == null || !Number.isFinite(value)) return null;
  const [good, poor] = metric === "lcp" ? [2500, 4000] : metric === "inp" ? [200, 500] : [0.1, 0.25];
  return value <= good ? "good" : value <= poor ? "needs improvement" : "poor";
}

/** Aggregate rows to CSV; values are counts and labels from fixed vocabularies. */
export function toCsv(headers: string[], rows: Array<Array<string | number | null | undefined>>) {
  const escape = (value: string | number | null | undefined) => {
    const text = value == null ? "" : String(value);
    // Neutralise spreadsheet formulas as well as quoting.
    const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return [headers, ...rows].map((row) => row.map(escape).join(",")).join("\n");
}

/** UTM value: lower case, words joined by hyphens, letters/digits/._- only, at most 60 characters. */
export function utmValue(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9._-]/g, "").slice(0, 60);
}

export const campaignPages = [
  ["/", "Home"],
  ["/applications", "Applications"],
  ["/about", "About"],
  ["/support", "Support"],
  ["/quote", "Get Quote"],
] as const;

export function campaignUrl(input: { page: string; source: string; medium: string; campaign: string; content?: string }) {
  const page = campaignPages.some(([path]) => path === input.page) ? input.page : "/";
  const url = new URL(page, "https://exacth2o.com");
  const fields: Array<[string, string | undefined]> = [
    ["utm_source", input.source],
    ["utm_medium", input.medium],
    ["utm_campaign", input.campaign],
    ["utm_content", input.content],
  ];
  for (const [key, value] of fields) {
    const cleaned = utmValue(value ?? "");
    if (cleaned) url.searchParams.set(key, cleaned);
  }
  return url.href;
}
