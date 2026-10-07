// Website analytics reports: request validation, cache identity, fixed query
// templates and result shaping. Pure functions, shared by the Edge Function and
// its tests. The browser chooses only a report name, a date range and a device
// filter from fixed lists; every value placed in a query is validated here.
// No query text, column or project is ever taken from a request.

export const timezone = "America/Detroit";
export const schemaVersion = "website-v2";
/** Public capture began with the 2026-10-01 analytics release. */
export const collectionStartDate = "2026-10-01";
/** Custom ranges may not begin before this date. */
export const earliestRangeDate = "2026-09-01";
export const maxRangeDays = 180;
/**
 * PostHog returns at most 100 rows for a query without LIMIT. Every report query carries this
 * explicit limit (PostHog's maximum is 50,000); a result that reaches it is treated as an error,
 * never shown as a complete report.
 */
export const maxReportRows = 10_000;
export const reportNames = ["tile", "overview", "acquisition", "journeys", "demo", "quote", "experience", "quality"];
export const rangePresets = { "7d": 7, "30d": 30, "90d": 90 };
/** Browser-reported device type ($device_type) is available for every event since launch. */
export const deviceFilters = { all: null, desktop: "Desktop", mobile: "Mobile", tablet: "Tablet" };
/** Deliberate actions that make a session "engaged" (alongside two or more page views). */
export const engagementEvents = ["demo_clicked", "quote_clicked", "demo_interacted", "quote_form_started"];
export const funnelSteps = [
  ["landed", "Visited the site"],
  ["applications", "Viewed Applications"],
  ["demo_viewed", "Saw the demo"],
  ["demo_interacted", "Used the demo"],
  ["quote_page", "Opened the quote page"],
  ["form_started", "Started the quote form"],
  ["submitted", "Quote accepted"],
];

const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const dayMs = 86_400_000;

export function dateInZone(date, zone = timezone) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

/** Calendar arithmetic on YYYY-MM-DD strings (noon UTC avoids any daylight-saving edge). */
export function shiftDate(day, delta) {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

export function dayCount(start, end) {
  return Math.round((Date.parse(`${end}T12:00:00Z`) - Date.parse(`${start}T12:00:00Z`)) / dayMs) + 1;
}

export function dateRange(start, end) {
  const days = [];
  for (let day = start; day <= end; day = shiftDate(day, 1)) days.push(day);
  return days;
}

function isRealDate(value) {
  return typeof value === "string" && datePattern.test(value) && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;
}

/**
 * Validate a report request. An empty body is the original seven-day summary
 * used by the home tile. Returns { ok, request } or { ok: false, error }.
 */
export function parseReportRequest(body, now = new Date()) {
  const input = body && typeof body === "object" ? body : {};
  const today = dateInZone(now);
  const report = input.report ?? "tile";
  if (!reportNames.includes(report)) return { ok: false, error: "Unknown report" };
  const requestedDevice = input.device ?? "all";
  if (!Object.hasOwn(deviceFilters, requestedDevice)) return { ok: false, error: "Unknown device filter" };
  // Data quality and the home tile always describe all traffic.
  const device = report === "quality" || report === "tile" ? "all" : requestedDevice;

  let start;
  let end;
  let preset = null;
  const range = input.range && typeof input.range === "object" ? input.range : {};
  if (report === "tile") {
    preset = "7d";
  } else if (range.preset != null || (range.start == null && range.end == null)) {
    preset = range.preset ?? "30d";
    if (!Object.hasOwn(rangePresets, preset)) return { ok: false, error: "Unknown range" };
  }
  if (preset) {
    end = today;
    start = shiftDate(today, -(rangePresets[preset] - 1));
  } else {
    if (!isRealDate(range.start) || !isRealDate(range.end)) return { ok: false, error: "Dates must be YYYY-MM-DD" };
    start = range.start;
    end = range.end;
    if (start > end) return { ok: false, error: "Start must not be after end" };
    if (end > today) return { ok: false, error: "End must not be in the future" };
    if (start < earliestRangeDate) return { ok: false, error: `Ranges start no earlier than ${earliestRangeDate}` };
    if (dayCount(start, end) > maxRangeDays) return { ok: false, error: `Ranges are limited to ${maxRangeDays} days` };
  }
  const days = dayCount(start, end);
  return {
    ok: true,
    request: {
      report,
      preset,
      start,
      end,
      days,
      today,
      includesToday: end === today,
      previousStart: shiftDate(start, -days),
      previousEnd: shiftDate(start, -1),
      device,
    },
  };
}

/** Cache identity: report, range, filter, time zone, schema version and, for open ranges, today's date. */
export function reportCacheKey(request, { region, project }) {
  return [
    schemaVersion,
    region,
    project,
    request.report,
    request.start,
    request.end,
    request.device,
    timezone,
    request.includesToday ? request.today : "closed",
  ].join(":");
}

/** Ranges that include today refresh every five minutes; closed ranges for six hours. */
export function reportTtlMs(request) {
  return request.includesToday ? 5 * 60_000 : 6 * 60 * 60_000;
}

/* ----- Query templates ------------------------------------------------ */

const site = "properties.site = 'exacth2o-public' AND properties.internal = false";
const localDay = `toDate(toTimeZone(timestamp, '${timezone}'))`;
// Normalised page: "/applications.html" and "/applications" are one page.
const rawPath = "coalesce(properties.page, properties.$pathname, '')";
const pagePath = `if(${rawPath} = '/index.html', '/', if(endsWith(${rawPath}, '.html'), substring(${rawPath}, 1, length(${rawPath}) - 5), ${rawPath}))`;
const sessionId = "properties.$session_id";

function assertDate(day) {
  if (!isRealDate(day)) throw new Error("Invalid date in report query");
  return day;
}

/** Local-day window with a coarse UTC prefilter so ClickHouse can prune partitions. */
function windowFilter(start, end) {
  return `timestamp >= toDateTime('${assertDate(shiftDate(start, -1))} 00:00:00') AND timestamp < toDateTime('${assertDate(shiftDate(end, 2))} 00:00:00') AND ${localDay} >= toDate('${assertDate(start)}') AND ${localDay} <= toDate('${assertDate(end)}')`;
}

function deviceFilter(device) {
  const value = deviceFilters[device];
  if (value === undefined) throw new Error("Invalid device filter");
  return value ? ` AND properties.$device_type = '${value}'` : "";
}

/** When the current range is still running, the previous period is cut at the same elapsed time. */
function previousCutoff(request) {
  if (!request.includesToday) return "";
  return ` AND (${localDay} >= toDate('${assertDate(request.start)}') OR timestamp <= now() - toIntervalDay(${Number(request.days)}))`;
}

const inList = (values) => values.map((value) => `'${value}'`).join(", ");

/**
 * Every report row has one shape so sections can share a single UNION ALL query. HogQL's
 * toFloat is a nullable Float64 cast (ClickHouse's toFloat64 is not exposed by HogQL).
 */
function row(section, a, b, n1 = "0", n2 = "0", n3 = "0", n4 = "0") {
  return `'${section}' AS section, toString(${a}) AS a, toString(${b}) AS b, toFloat(${n1}) AS n1, toFloat(${n2}) AS n2, toFloat(${n3}) AS n3, toFloat(${n4}) AS n4`;
}

const inquiries = "uniqExactIf(submission_id, event = 'quote_submitted' AND submission_id != '') + countIf(event = 'quote_submitted' AND submission_id = '')";

function eventsSubquery(request, { previous = false, extra = "" } = {}) {
  const start = previous ? request.previousStart : request.start;
  const period = previous ? `if(${localDay} >= toDate('${assertDate(request.start)}'), 'current', 'previous')` : "'current'";
  return `SELECT event, distinct_id, timestamp, ${sessionId} AS sid, coalesce(properties.submission_id, '') AS submission_id, ${period} AS period, ${localDay} AS day, ${pagePath} AS page${extra}
    FROM events WHERE ${site} AND ${windowFilter(start, request.end)}${previous ? previousCutoff(request) : ""}${deviceFilter(request.device)}`;
}

function sessionsSubquery(request, { previous = false } = {}) {
  const start = previous ? request.previousStart : request.start;
  const period = previous ? `argMin(if(${localDay} >= toDate('${assertDate(request.start)}'), 'current', 'previous'), timestamp)` : "'current'";
  return `SELECT ${sessionId} AS sid, ${period} AS period,
      argMinIf(coalesce(properties.$referring_domain, '$direct'), timestamp, event = '$pageview') AS referrer,
      argMinIf(coalesce(properties.$current_url, ''), timestamp, event = '$pageview') AS entry_url,
      argMinIf(${pagePath}, timestamp, event = '$pageview') AS landing,
      argMaxIf(${pagePath}, timestamp, event = '$pageview') AS exit_page,
      argMinIf(coalesce(properties.$device_type, 'Unknown'), timestamp, event = '$pageview') AS device_type,
      countIf(event = '$pageview') AS pageviews,
      countIf(event IN (${inList(engagementEvents)})) AS actions,
      countIf(event = '$pageview' AND ${pagePath} = '/applications') AS c_app,
      minIf(timestamp, event = '$pageview' AND ${pagePath} = '/applications') AS t_app,
      countIf(event = 'demo_viewed') AS c_dv,
      minIf(timestamp, event = 'demo_viewed') AS t_dv,
      countIf(event = 'demo_interacted') AS c_di,
      minIf(timestamp, event = 'demo_interacted') AS t_di,
      countIf(event = '$pageview' AND ${pagePath} = '/quote') AS c_q,
      minIf(timestamp, event = '$pageview' AND ${pagePath} = '/quote') AS t_q,
      countIf(event = 'quote_form_started') AS c_fs,
      minIf(timestamp, event = 'quote_form_started') AS t_fs,
      countIf(event = 'quote_submitted') AS c_sub,
      minIf(timestamp, event = 'quote_submitted') AS t_sub
    FROM events WHERE ${site} AND ${windowFilter(start, request.end)}${previous ? previousCutoff(request) : ""}${deviceFilter(request.device)} AND ${sessionId} IS NOT NULL
    GROUP BY sid HAVING pageviews > 0`;
}

const engaged = "pageviews >= 2 OR actions > 0";

/** Fixed HogQL for a validated request: { main, secondary? }, each with an explicit row limit. */
export function buildReportQueries(request) {
  const parts = reportQueryParts(request);
  const limited = (query) => `SELECT * FROM (\n${query}\n) LIMIT ${maxReportRows}`;
  return parts.secondary
    ? { main: limited(parts.main), secondary: limited(parts.secondary) }
    : { main: limited(parts.main) };
}

function reportQueryParts(request) {
  const union = (parts) => parts.map((part) => `SELECT ${part}`).join("\nUNION ALL\n");
  switch (request.report) {
    case "tile":
    case "overview": {
      const events = eventsSubquery(request, { previous: true });
      const sessions = sessionsSubquery(request, { previous: true });
      return {
        main: union([
          `${row("period", "period", "''", "uniqExactIf(distinct_id, event = '$pageview')", "uniqExactIf(sid, event = '$pageview')", "countIf(event = '$pageview')", inquiries)} FROM (${events}) GROUP BY period`,
          `${row("engaged", "period", "''", "count()", `countIf(${engaged})`, "countIf(actions > 0)", "countIf(c_q > 0)")} FROM (${sessions}) GROUP BY period`,
          `${row("actions", "period", "''", "countIf(event = 'demo_clicked')", "countIf(event = 'quote_clicked')", "uniqExactIf(sid, event = 'demo_interacted')", "uniqExactIf(sid, event = 'quote_form_started')")} FROM (${events}) GROUP BY period`,
          `${row("day", "day", "''", "uniqExactIf(distinct_id, event = '$pageview')", "uniqExactIf(sid, event = '$pageview')", "countIf(event = '$pageview')", inquiries)} FROM (${events}) WHERE period = 'current' GROUP BY day`,
        ]),
      };
    }
    case "acquisition": {
      const sessions = sessionsSubquery(request);
      const outcomes = `count(), countIf(${engaged}), countIf(c_q > 0), countIf(c_sub > 0)`;
      const [n1, n2, n3, n4] = outcomes.split(", ");
      const campaign = "concat(extractURLParameter(entry_url, 'utm_source'), ' | ', extractURLParameter(entry_url, 'utm_medium'), ' | ', extractURLParameter(entry_url, 'utm_campaign'))";
      return {
        main: union([
          `${row("referrer", "referrer", "''", n1, n2, n3, n4)} FROM (${sessions}) GROUP BY referrer`,
          `${row("campaign", campaign, "''", n1, n2, n3, n4)} FROM (${sessions}) GROUP BY ${campaign}`,
          `${row("landing", "landing", "''", n1, n2, n3, n4)} FROM (${sessions}) GROUP BY landing`,
          `${row("device", "device_type", "''", n1, n2, n3, n4)} FROM (${sessions}) GROUP BY device_type`,
        ]),
      };
    }
    case "journeys": {
      const sessions = sessionsSubquery(request);
      const s2 = "c_app > 0";
      const s3 = `${s2} AND c_dv > 0 AND t_dv >= t_app`;
      const s4 = `${s3} AND c_di > 0 AND t_di >= t_dv`;
      const s5 = `${s4} AND c_q > 0 AND t_q >= t_di`;
      const s6 = `${s5} AND c_fs > 0 AND t_fs >= t_q`;
      const s7 = `${s6} AND c_sub > 0 AND t_sub >= t_fs`;
      const q2 = "c_q > 0 AND c_fs > 0 AND t_fs >= t_q";
      const q3 = `${q2} AND c_sub > 0 AND t_sub >= t_fs`;
      return {
        main: union([
          `${row("funnel", "'demo_path'", "''", "count()", `countIf(${s2})`, `countIf(${s3})`, `countIf(${s4})`)} FROM (${sessions})`,
          `${row("funnel", "'demo_path_end'", "''", `countIf(${s5})`, `countIf(${s6})`, `countIf(${s7})`, "0")} FROM (${sessions})`,
          `${row("funnel", "'quote_path'", "''", "countIf(c_q > 0)", `countIf(${q2})`, `countIf(${q3})`, "0")} FROM (${sessions})`,
          `${row("route", "'direct'", "''", "countIf(landing = '/quote')", "countIf(landing = '/quote' AND c_sub > 0)", "0", "0")} FROM (${sessions})`,
          `${row("route", "'without_applications'", "''", "countIf(c_q > 0 AND c_app = 0)", "countIf(c_q > 0 AND c_app = 0 AND c_sub > 0)", "0", "0")} FROM (${sessions})`,
          `${row("route", "'after_applications'", "''", "countIf(c_q > 0 AND c_app > 0 AND t_app <= t_q)", "countIf(c_q > 0 AND c_app > 0 AND t_app <= t_q AND c_sub > 0)", "0", "0")} FROM (${sessions})`,
          `${row("entry", "landing", "''", "count()", `countIf(${engaged})`, "countIf(c_q > 0)", "countIf(c_sub > 0)")} FROM (${sessions}) GROUP BY landing`,
          `${row("exit", "exit_page", "''", "count()", "countIf(pageviews = 1)", "0", "0")} FROM (${sessions}) GROUP BY exit_page`,
        ]),
        // Page seen immediately before the first quote-page view in each session.
        secondary: `SELECT ${row("before_quote", "previous_page", "''", "count()")} FROM (
          SELECT if(quote_index > 1, arrayElement(paths, quote_index - 1), '(entered on quote page)') AS previous_page
          FROM (
            SELECT ${sessionId} AS sid,
              arrayMap(x -> x.2, arraySort(x -> x.1, groupArrayIf(tuple(timestamp, ${pagePath}), event = '$pageview'))) AS paths,
              indexOf(paths, '/quote') AS quote_index
            FROM events WHERE ${site} AND ${windowFilter(request.start, request.end)}${deviceFilter(request.device)} AND ${sessionId} IS NOT NULL
            GROUP BY sid
          ) WHERE quote_index > 0
        ) GROUP BY previous_page`,
      };
    }
    case "demo": {
      const events = eventsSubquery(request, { extra: ", coalesce(properties.action, '') AS action, coalesce(properties.view, '') AS view, coalesce(properties.placement, '') AS placement, properties.load_ms AS load_ms" });
      const sessions = sessionsSubquery(request);
      return {
        main: union([
          `${row("stage", "'applications'", "''", "uniqExactIf(sid, event = '$pageview' AND page = '/applications')", "countIf(event = '$pageview' AND page = '/applications')")} FROM (${events})`,
          `${row("stage", "'demo_viewed'", "''", "uniqExactIf(sid, event = 'demo_viewed')", "countIf(event = 'demo_viewed')")} FROM (${events})`,
          `${row("stage", "'demo_ready'", "''", "uniqExactIf(sid, event = 'demo_ready')", "countIf(event = 'demo_ready')")} FROM (${events})`,
          `${row("stage", "'demo_interacted'", "''", "uniqExactIf(sid, event = 'demo_interacted')", "countIf(event = 'demo_interacted')")} FROM (${events})`,
          `${row("stage", "'demo_load_failed'", "''", "uniqExactIf(sid, event = 'demo_load_failed')", "countIf(event = 'demo_load_failed')")} FROM (${events})`,
          `${row("action", "action", "view", "count()", "uniqExact(sid)")} FROM (${events}) WHERE event = 'demo_interacted' GROUP BY action, view`,
          `${row("link", "placement", "''", "count()", "uniqExact(sid)")} FROM (${events}) WHERE event = 'demo_clicked' GROUP BY placement`,
          `${row("wait", "'load_ms'", "''", "count()", "quantile(0.5)(toFloat(load_ms))", "quantile(0.9)(toFloat(load_ms))")} FROM (${events}) WHERE event = 'demo_ready' AND load_ms IS NOT NULL`,
          `${row("to_quote", "'after_interaction'", "''", "countIf(c_di > 0)", "countIf(c_di > 0 AND c_q > 0 AND t_q >= t_di)", "countIf(c_di > 0 AND c_sub > 0 AND t_sub >= t_di)")} FROM (${sessions})`,
        ]),
      };
    }
    case "quote": {
      const events = eventsSubquery(request, { extra: ", coalesce(properties.reason, '') AS reason, coalesce(properties.status_class, '') AS status_class, coalesce(properties.placement, '') AS placement, coalesce(properties.issue_list, '') AS issue_list" });
      return {
        main: union([
          `${row("step", "'quote_page'", "''", "uniqExactIf(sid, event = '$pageview' AND page = '/quote')", "countIf(event = '$pageview' AND page = '/quote')")} FROM (${events})`,
          `${row("step", "'form_viewed'", "''", "uniqExactIf(sid, event = 'quote_form_viewed')", "countIf(event = 'quote_form_viewed')")} FROM (${events})`,
          `${row("step", "'form_started'", "''", "uniqExactIf(sid, event = 'quote_form_started')", "countIf(event = 'quote_form_started')")} FROM (${events})`,
          `${row("step", "'validation_failed'", "''", "uniqExactIf(sid, event = 'quote_validation_failed')", "countIf(event = 'quote_validation_failed')")} FROM (${events})`,
          `${row("step", "'submit_attempted'", "''", "uniqExactIf(submission_id, event = 'quote_submit_attempted' AND submission_id != '')", "countIf(event = 'quote_submit_attempted')")} FROM (${events})`,
          `${row("step", "'submitted'", "''", inquiries, "countIf(event = 'quote_submitted')")} FROM (${events})`,
          `${row("step", "'submit_failed'", "''", "uniqExactIf(submission_id, event = 'quote_submit_failed' AND submission_id != '')", "countIf(event = 'quote_submit_failed')")} FROM (${events})`,
          `${row("issue", "issue", "''", "count()")} FROM (SELECT arrayJoin(splitByChar('|', issue_list)) AS issue FROM (${events}) WHERE event = 'quote_validation_failed' AND issue_list != '') GROUP BY issue`,
          `${row("failure", "reason", "status_class", "count()")} FROM (${events}) WHERE event = 'quote_submit_failed' GROUP BY reason, status_class`,
          `${row("link", "placement", "''", "count()", "uniqExact(sid)")} FROM (${events}) WHERE event = 'quote_clicked' GROUP BY placement`,
        ]),
      };
    }
    case "experience": {
      const events = eventsSubquery(request, { extra: ", coalesce(properties.device_class, lower(coalesce(properties.$device_type, 'unknown'))) AS device_class, properties.lcp_ms AS lcp_ms, properties.inp_ms AS inp_ms, properties.cls AS cls, coalesce(properties.kind, '') AS kind, coalesce(properties.source, '') AS source, coalesce(properties.resource_type, '') AS resource_type, toFloat(properties.$prev_pageview_max_scroll_percentage) AS scroll" });
      // One section per metric so each percentile is over the page views that reported it.
      const vitalRows = ["lcp_ms", "inp_ms", "cls"].flatMap((metric) => [
        `${row(`vital_${metric}`, "page", "device_class", "count()", `quantile(0.75)(toFloat(${metric}))`, `quantile(0.5)(toFloat(${metric}))`)} FROM (${events}) WHERE event = 'web_vitals' AND ${metric} IS NOT NULL GROUP BY page, device_class`,
        `${row(`vital_${metric}`, "page", "'all'", "count()", `quantile(0.75)(toFloat(${metric}))`, `quantile(0.5)(toFloat(${metric}))`)} FROM (${events}) WHERE event = 'web_vitals' AND ${metric} IS NOT NULL GROUP BY page`,
      ]);
      return {
        main: union([
          ...vitalRows,
          `${row("vitals_pages", "page", "device_class", "count()")} FROM (${events}) WHERE event = 'web_vitals' GROUP BY page, device_class`,
          `${row("error", "page", "concat(kind, ':', source, ':', resource_type)", "count()", "uniqExact(sid)")} FROM (${events}) WHERE event = 'page_error' GROUP BY page, concat(kind, ':', source, ':', resource_type)`,
          `${row("failure", "event", "''", "count()", "uniqExact(sid)")} FROM (${events}) WHERE event IN ('demo_load_failed', 'quote_submit_failed') GROUP BY event`,
          `${row("scroll", "page", "''", "count()", "quantile(0.5)(scroll)", "countIf(scroll >= 0.75)")} FROM (${events}) WHERE event = '$pageleave' AND scroll IS NOT NULL GROUP BY page`,
        ]),
      };
    }
    case "quality": {
      const since = collectionStartDate;
      const schemaVersionExpr = "coalesce(toString(properties.ev), '1')";
      return {
        main: union([
          `${row("event", "event", "''", `countIf(${localDay} >= toDate('${assertDate(request.start)}'))`, "toUnixTimestamp(min(timestamp))", "toUnixTimestamp(max(timestamp))")} FROM events WHERE ${site} AND ${windowFilter(since, request.end)} GROUP BY event`,
          `${row("schema", schemaVersionExpr, "''", "count()", "toUnixTimestamp(min(timestamp))", "toUnixTimestamp(max(timestamp))")} FROM events WHERE ${site} AND ${windowFilter(since, request.end)} GROUP BY ${schemaVersionExpr}`,
          `${row("volume", `${localDay}`, "''", "count()", "uniqExactIf(distinct_id, event = '$pageview')")} FROM events WHERE ${site} AND ${windowFilter(request.start, request.end)} GROUP BY ${localDay}`,
        ]),
      };
    }
    default:
      throw new Error("Unknown report");
  }
}

/* ----- Result shaping ------------------------------------------------- */

/**
 * Validate PostHog's result rows: [section, a, b, n1, n2, n3, n4].
 * @param {unknown} results
 * @returns {ReportRow[]}
 */
export function parseRows(results, hasMore = false) {
  if (!Array.isArray(results)) throw new Error("Incomplete query result");
  if (hasMore || results.length >= maxReportRows) throw new Error("Report rows truncated");
  return results.map((row) => {
    if (!Array.isArray(row) || row.length < 7) throw new Error("Incomplete query result");
    const number = (value) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    };
    return { section: String(row[0]), a: String(row[1] ?? ""), b: String(row[2] ?? ""), n1: number(row[3]), n2: number(row[4]), n3: number(row[5]), n4: number(row[6]) };
  });
}

const count = (value) => (value == null ? 0 : Math.round(value));

/** Change against the previous period; null (shown as "no comparison") when the baseline is zero. */
export function comparison(current, previous) {
  if (previous == null) return null;
  if (previous === 0) return { previous, change: null };
  return { previous, change: (current - previous) / previous };
}

/** Top rows by sessions, the rest folded into "Other". */
function topRows(rows, limit = 12) {
  const sorted = rows.slice().sort((left, right) => right.sessions - left.sessions || left.key.localeCompare(right.key));
  if (sorted.length <= limit) return sorted;
  const rest = sorted.slice(limit);
  const other = rest.reduce((sum, item) => ({
    key: "Other",
    sessions: sum.sessions + item.sessions,
    engaged: sum.engaged + item.engaged,
    quoteSessions: sum.quoteSessions + item.quoteSessions,
    inquirySessions: sum.inquirySessions + item.inquirySessions,
  }), { key: "Other", sessions: 0, engaged: 0, quoteSessions: 0, inquirySessions: 0 });
  return [...sorted.slice(0, limit), other];
}

function outcomeRows(rows, section, label = (key) => key) {
  return topRows(rows.filter((row) => row.section === section).map((row) => ({
    key: label(row.a),
    sessions: count(row.n1),
    engaged: count(row.n2),
    quoteSessions: count(row.n3),
    inquirySessions: count(row.n4),
  })));
}

const referrerLabel = (value) => (!value || value === "$direct" ? "Direct or unknown" : value);
const campaignLabel = (value) => {
  const [source, medium, campaign] = value.split(" | ");
  return !source && !medium && !campaign ? "No campaign tags" : [source || "(no source)", medium || "(no medium)", campaign || "(no campaign)"].join(" / ");
};
const pageLabel = (value) => value || "(unknown page)";

/**
 * @typedef {{ section: string, a: string, b: string, n1: number | null, n2: number | null, n3: number | null, n4: number | null }} ReportRow
 * @typedef {{ current: number, previous: number, days: Record<string, number>, campaigns?: Array<{ key: string, inquiries: number }> }} CanonicalInquiries
 */

/**
 * Turn query rows (and canonical server counts) into the report payload.
 * `canonical` is { current, previous, days: { [date]: n } } of accepted
 * inquiries from quote_requests, or null when unavailable.
 */
/**
 * @param {any} request
 * @param {ReportRow[]} rows
 * @param {{ secondary?: ReportRow[] | null, canonical?: CanonicalInquiries | null }} [options]
 */
export function shapeReport(request, rows, options = {}) {
  // null secondary rows mean the secondary query failed: shown as "not available", never as zero.
  const secondary = options.secondary === undefined ? [] : options.secondary;
  // Server records have no device; with a device filter they are left out rather than compared.
  const canonical = request.device && request.device !== "all" ? null : options.canonical ?? null;
  const bySection = (section) => rows.filter((row) => row.section === section);
  const period = (section, name) => bySection(section).find((row) => row.a === name) ?? null;
  const range = {
    start: request.start,
    end: request.end,
    days: request.days,
    preset: request.preset,
    includesToday: request.includesToday,
    previousStart: request.previousStart,
    previousEnd: request.previousEnd,
    device: request.device,
    timezone,
  };

  if (request.report === "tile" || request.report === "overview") {
    const current = period("period", "current");
    const previous = period("period", "previous");
    const engagedCurrent = period("engaged", "current");
    const engagedPrevious = period("engaged", "previous");
    const actionsCurrent = period("actions", "current");
    const actionsPrevious = period("actions", "previous");
    const metric = (currentValue, previousValue) => ({ value: count(currentValue), ...comparisonFields(count(currentValue), previousValue == null ? 0 : count(previousValue)) });
    const dayRows = new Map(bySection("day").map((row) => [row.a, row]));
    const days = dateRange(request.start, request.end).map((date) => {
      const row = dayRows.get(date);
      return {
        date,
        visitors: count(row?.n1),
        sessions: count(row?.n2),
        pageviews: count(row?.n3),
        inquiries: count(row?.n4),
        acceptedInquiries: canonical ? count(canonical.days?.[date]) : null,
        partial: date === request.today,
      };
    });
    const overview = {
      visitors: metric(current?.n1, previous?.n1),
      sessions: metric(current?.n2, previous?.n2),
      pageviews: metric(current?.n3, previous?.n3),
      engagedSessions: metric(engagedCurrent?.n2, engagedPrevious?.n2),
      quotePageSessions: metric(engagedCurrent?.n4, engagedPrevious?.n4),
      demoClicks: metric(actionsCurrent?.n1, actionsPrevious?.n1),
      quoteClicks: metric(actionsCurrent?.n2, actionsPrevious?.n2),
      demoInteractionSessions: metric(actionsCurrent?.n3, actionsPrevious?.n3),
      formStartSessions: metric(actionsCurrent?.n4, actionsPrevious?.n4),
      analyticsInquiries: metric(current?.n4, previous?.n4),
      acceptedInquiries: canonical ? metric(canonical.current, canonical.previous) : null,
      days,
    };
    if (request.report === "overview") return { range, ...overview };
    // The home tile keeps its original fields for portal bundles already in browsers.
    return {
      range,
      visitors: overview.visitors.value,
      demoClicks: overview.demoClicks.value,
      quoteClicks: overview.quoteClicks.value,
      inquiries: canonical ? count(canonical.current) : overview.analyticsInquiries.value,
      inquirySource: canonical ? "server" : "analytics",
      demoInteractionSessions: overview.demoInteractionSessions.value,
      days: days.map((day) => ({ date: day.date, visitors: day.visitors })),
    };
  }

  if (request.report === "acquisition") {
    return {
      range,
      referrers: outcomeRows(rows, "referrer", referrerLabel),
      campaigns: outcomeRows(rows, "campaign", campaignLabel),
      landingPages: outcomeRows(rows, "landing", pageLabel),
      devices: outcomeRows(rows, "device", (value) => value || "Unknown"),
      canonicalCampaigns: canonical?.campaigns ?? null,
    };
  }

  if (request.report === "journeys") {
    const demoPath = period("funnel", "demo_path");
    const demoPathEnd = period("funnel", "demo_path_end");
    const quotePath = period("funnel", "quote_path");
    const steps = [demoPath?.n1, demoPath?.n2, demoPath?.n3, demoPath?.n4, demoPathEnd?.n1, demoPathEnd?.n2, demoPathEnd?.n3];
    const route = (name) => {
      const value = period("route", name);
      return { sessions: count(value?.n1), inquirySessions: count(value?.n2) };
    };
    return {
      range,
      demoFunnel: funnelSteps.map(([key, label], index) => ({ key, label, sessions: count(steps[index]) })),
      quoteFunnel: [
        { key: "quote_page", label: "Opened the quote page", sessions: count(quotePath?.n1) },
        { key: "form_started", label: "Started the form", sessions: count(quotePath?.n2) },
        { key: "submitted", label: "Quote accepted", sessions: count(quotePath?.n3) },
      ],
      routes: {
        direct: route("direct"),
        withoutApplications: route("without_applications"),
        afterApplications: route("after_applications"),
      },
      entryPages: outcomeRows(rows, "entry", pageLabel),
      exitPages: bySection("exit").map((row) => ({ key: pageLabel(row.a), sessions: count(row.n1), singlePage: count(row.n2) }))
        .sort((left, right) => right.sessions - left.sessions).slice(0, 12),
      beforeQuote: secondary == null ? null : secondary.filter((row) => row.section === "before_quote")
        .map((row) => ({ key: pageLabel(row.a), sessions: count(row.n1) }))
        .sort((left, right) => right.sessions - left.sessions).slice(0, 10),
    };
  }

  if (request.report === "demo") {
    const stage = (name) => {
      const value = period("stage", name);
      return { sessions: count(value?.n1), events: count(value?.n2) };
    };
    const wait = period("wait", "load_ms");
    const toQuote = period("to_quote", "after_interaction");
    return {
      range,
      stages: {
        applications: stage("applications"),
        viewed: stage("demo_viewed"),
        ready: stage("demo_ready"),
        interacted: stage("demo_interacted"),
        loadFailed: stage("demo_load_failed"),
      },
      actions: bySection("action").map((row) => ({ action: row.a, view: row.b || null, events: count(row.n1), sessions: count(row.n2) }))
        .sort((left, right) => right.events - left.events),
      demoLinks: bySection("link").map((row) => ({ placement: row.a || "unknown", events: count(row.n1), sessions: count(row.n2) })),
      readyWait: { samples: count(wait?.n1), medianMs: wait?.n1 ? wait?.n2 : null, p90Ms: wait?.n1 ? wait?.n3 : null },
      afterInteraction: { sessions: count(toQuote?.n1), reachedQuote: count(toQuote?.n2), submitted: count(toQuote?.n3) },
    };
  }

  if (request.report === "quote") {
    const step = (name) => {
      const value = period("step", name);
      return { count: count(value?.n1), events: count(value?.n2) };
    };
    return {
      range,
      steps: {
        quotePage: step("quote_page"),
        formViewed: step("form_viewed"),
        formStarted: step("form_started"),
        validationFailed: step("validation_failed"),
        submitAttempted: step("submit_attempted"),
        submitted: step("submitted"),
        submitFailed: step("submit_failed"),
      },
      acceptedInquiries: canonical ? { current: count(canonical.current), previous: count(canonical.previous) } : null,
      issues: bySection("issue").map((row) => ({ issue: row.a, events: count(row.n1) })).sort((left, right) => right.events - left.events),
      failures: bySection("failure").map((row) => ({ reason: row.a, statusClass: row.b, events: count(row.n1) })),
      quoteLinks: bySection("link").map((row) => ({ placement: row.a || "unknown", events: count(row.n1), sessions: count(row.n2) })),
    };
  }

  if (request.report === "experience") {
    const metrics = { lcp: "vital_lcp_ms", inp: "vital_inp_ms", cls: "vital_cls" };
    const vitals = new Map();
    for (const [name, section] of Object.entries(metrics)) {
      for (const item of bySection(section)) {
        const key = `${item.a}|${item.b}`;
        const entry = vitals.get(key) ?? { page: item.a, device: item.b };
        entry[name] = { samples: count(item.n1), p75: item.n2, p50: item.n3 };
        vitals.set(key, entry);
      }
    }
    return {
      range,
      vitals: Array.from(vitals.values()).sort((left, right) => left.page.localeCompare(right.page) || left.device.localeCompare(right.device)),
      vitalPageViews: bySection("vitals_pages").map((row) => ({ page: row.a, device: row.b, pageViews: count(row.n1) })),
      errors: bySection("error").map((row) => ({ page: row.a, category: row.b, events: count(row.n1), sessions: count(row.n2) })),
      failures: bySection("failure").map((row) => ({ event: row.a, events: count(row.n1), sessions: count(row.n2) })),
      scroll: bySection("scroll").map((row) => ({ page: row.a, samples: count(row.n1), medianMaxScroll: row.n2, reached75: count(row.n3) })),
    };
  }

  if (request.report === "quality") {
    const iso = (seconds) => (seconds == null || seconds <= 0 ? null : new Date(seconds * 1000).toISOString());
    const volumes = new Map(bySection("volume").map((row) => [row.a, row]));
    return {
      range,
      collectionStartDate,
      events: bySection("event").map((row) => ({ event: row.a, inRange: count(row.n1), firstSeen: iso(row.n2), lastSeen: iso(row.n3) }))
        .sort((left, right) => left.event.localeCompare(right.event)),
      schemas: bySection("schema").map((row) => ({ version: Number(row.a) || 1, events: count(row.n1), firstSeen: iso(row.n2), lastSeen: iso(row.n3) })),
      daily: dateRange(request.start, request.end).map((date) => ({
        date,
        events: count(volumes.get(date)?.n1),
        visitors: count(volumes.get(date)?.n2),
        partial: date === request.today,
      })),
      canonicalAvailable: canonical != null,
    };
  }
  throw new Error("Unknown report");
}

function comparisonFields(current, previous) {
  const result = comparison(current, previous);
  return { previous: result?.previous ?? null, change: result?.change ?? null };
}

/* ----- Canonical inquiries --------------------------------------------- */

/**
 * Accepted inquiries from server records (quote_requests). Only counts and
 * campaign tags parsed from the stored source URL leave this function; no
 * names, emails or messages.
 */
/**
 * @param {Array<{ created_at?: string, source_url?: string | null }>} rows
 * @param {any} request
 * @returns {CanonicalInquiries}
 */
export function summarizeAcceptedInquiries(rows, request) {
  /** @type {Record<string, number>} */
  const days = {};
  let current = 0;
  let previous = 0;
  const campaigns = new Map();
  for (const row of rows) {
    const created = row?.created_at ? new Date(row.created_at) : null;
    if (!created || !Number.isFinite(created.getTime())) continue;
    const day = dateInZone(created);
    if (day >= request.start && day <= request.end) {
      current += 1;
      days[day] = (days[day] ?? 0) + 1;
      let key = "No campaign tags";
      try {
        const url = new URL(String(row.source_url ?? ""));
        const source = url.searchParams.get("utm_source") ?? "";
        const medium = url.searchParams.get("utm_medium") ?? "";
        const campaign = url.searchParams.get("utm_campaign") ?? "";
        if (source || medium || campaign) key = [source || "(no source)", medium || "(no medium)", campaign || "(no campaign)"].map((part) => part.slice(0, 60)).join(" / ");
      } catch {
        key = "No campaign tags";
      }
      campaigns.set(key, (campaigns.get(key) ?? 0) + 1);
    } else if (day >= request.previousStart && day <= request.previousEnd) {
      if (!request.includesToday || created.getTime() <= Date.now() - request.days * dayMs) previous += 1;
    }
  }
  return {
    current,
    previous,
    days,
    campaigns: Array.from(campaigns, ([key, inquiries]) => ({ key, inquiries })).sort((left, right) => right.inquiries - left.inquiries),
  };
}
