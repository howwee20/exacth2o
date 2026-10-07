import assert from "node:assert/strict";
import test from "node:test";
import {
  buildReportQueries,
  comparison,
  maxReportRows,
  dateInZone,
  dateRange,
  dayCount,
  parseReportRequest,
  parseRows,
  reportCacheKey,
  reportNames,
  reportTtlMs,
  shapeReport,
  summarizeAcceptedInquiries,
} from "./report-policy.mjs";

const now = new Date("2026-10-07T16:00:00Z");
const valid = (body, at = now) => {
  const result = parseReportRequest(body, at);
  assert.equal(result.ok, true, result.error);
  return result.request;
};

test("an empty body is the original seven-day tile summary", () => {
  const request = valid({});
  assert.equal(request.report, "tile");
  assert.equal(request.start, "2026-10-01");
  assert.equal(request.end, "2026-10-07");
  assert.equal(request.days, 7);
  assert.equal(request.includesToday, true);
});

test("presets and bounded custom ranges are the only accepted ranges", () => {
  assert.equal(valid({ report: "overview", range: { preset: "90d" } }).days, 90);
  assert.equal(valid({ report: "overview", range: { start: "2026-10-01", end: "2026-10-03" } }).includesToday, false);
  for (const range of [
    { preset: "365d" },
    { start: "2026-10-03", end: "2026-10-01" },
    { start: "2026-10-01", end: "2026-10-08" },
    { start: "2026-02-30", end: "2026-03-01" },
    { start: "2026-08-01", end: "2026-08-02" },
    { start: "2026-10-01'; DROP", end: "2026-10-02" },
    { start: "2026-09-01", end: "2027-03-30" },
  ]) {
    assert.equal(parseReportRequest({ report: "overview", range }, now).ok, false, JSON.stringify(range));
  }
  assert.equal(parseReportRequest({ report: "SELECT 1" }, now).ok, false);
  assert.equal(parseReportRequest({ report: "overview", device: "Desktop' OR 1=1" }, now).ok, false);
});

test("query construction never accepts unvalidated values", () => {
  const request = valid({ report: "overview", range: { preset: "30d" } });
  assert.throws(() => buildReportQueries({ ...request, start: "2026-10-01') OR (1=1" }));
  assert.throws(() => buildReportQueries({ ...request, device: "Mobile' OR 1=1" }));
  assert.throws(() => buildReportQueries({ ...request, report: "custom" }));
});

test("every report query returns the uniform seven-column row shape", () => {
  for (const report of reportNames) {
    const request = valid({ report, range: { preset: "30d" }, device: "mobile" });
    const queries = buildReportQueries(request);
    for (const query of [queries.main, queries.secondary].filter(Boolean)) {
      const parts = query.split("UNION ALL");
      for (const part of parts) {
        for (const column of ["AS section", "AS a", "AS b", "AS n1", "AS n2", "AS n3", "AS n4"]) {
          assert.ok(part.includes(column), `${report} part missing ${column}`);
        }
      }
      assert.match(query, /properties\.site = 'exacth2o-public' AND properties\.internal = false/);
      if (report === "quality" || report === "tile") assert.doesNotMatch(query, /\$device_type = 'Mobile'/);
      else assert.match(query, /properties\.\$device_type = 'Mobile'/);
    }
  }
});

test("local days follow America/Detroit across daylight-saving changes", () => {
  // DST ends 2026-11-01 02:00 EDT; 03:59Z is still Oct 31 locally, 04:30Z is Nov 1.
  assert.equal(dateInZone(new Date("2026-11-01T03:59:00Z")), "2026-10-31");
  assert.equal(dateInZone(new Date("2026-11-01T04:30:00Z")), "2026-11-01");
  assert.equal(dateInZone(new Date("2026-11-02T04:30:00Z")), "2026-11-01");
  // DST starts 2026-03-08; calendar arithmetic is unaffected.
  assert.deepEqual(dateRange("2026-03-07", "2026-03-09"), ["2026-03-07", "2026-03-08", "2026-03-09"]);
  assert.equal(dayCount("2026-10-25", "2026-11-07"), 14);
  const request = valid({ report: "overview", range: { start: "2026-10-25", end: "2026-11-07" } }, new Date("2026-11-10T15:00:00Z"));
  assert.equal(request.previousStart, "2026-10-11");
  assert.equal(request.previousEnd, "2026-10-24");
});

test("cache keys separate reports, ranges, filters and days", () => {
  const scope = { region: "us", project: "638703" };
  const base = valid({ report: "overview", range: { preset: "30d" } });
  const keys = new Set([
    reportCacheKey(base, scope),
    reportCacheKey(valid({ report: "acquisition", range: { preset: "30d" } }), scope),
    reportCacheKey(valid({ report: "overview", range: { preset: "7d" } }), scope),
    reportCacheKey(valid({ report: "overview", range: { preset: "30d" }, device: "mobile" }), scope),
    reportCacheKey(valid({ report: "overview", range: { preset: "30d" } }, new Date("2026-10-08T16:00:00Z")), scope),
  ]);
  assert.equal(keys.size, 5);
  assert.match(reportCacheKey(base, scope), /^website-v2:us:638703:overview:2026-09-08:2026-10-07:all:America\/Detroit:2026-10-07$/);
  const closed = valid({ report: "overview", range: { start: "2026-10-01", end: "2026-10-03" } });
  assert.match(reportCacheKey(closed, scope), /:closed$/);
  assert.ok(reportTtlMs(closed) > reportTtlMs(base));
});

test("zero baselines produce no comparison instead of infinite growth", () => {
  assert.deepEqual(comparison(4, 0), { previous: 0, change: null });
  assert.deepEqual(comparison(6, 4), { previous: 4, change: 0.5 });
});

test("overview shaping keeps counts, flags the partial day and prefers server inquiries", () => {
  const request = valid({ report: "tile" });
  const rows = parseRows([
    ["period", "current", "", "16", "19", "40", "1"],
    ["engaged", "current", "", "19", "7", "3", "2"],
    ["actions", "current", "", "0", "1", "2", "1"],
    ["day", "2026-10-07", "", "3", "3", "8", "0"],
  ]);
  const tile = shapeReport(request, rows, { canonical: { current: 2, previous: 0, days: { "2026-10-07": 1 } } });
  assert.equal(tile.visitors, 16);
  assert.equal(tile.inquiries, 2);
  assert.equal(tile.inquirySource, "server");
  assert.equal(tile.days.length, 7);
  const overview = shapeReport({ ...request, report: "overview" }, rows, { canonical: null });
  assert.equal(overview.days.at(-1).partial, true);
  assert.equal(overview.days[0].visitors, 0);
  assert.equal(overview.visitors.change, null);
  assert.equal(overview.acceptedInquiries, null);
  assert.equal(overview.engagedSessions.value, 7);
});

test("acquisition rows keep direct/unknown honest and fold the long tail", () => {
  const request = valid({ report: "acquisition" });
  const rows = parseRows([
    ["referrer", "$direct", "", "5", "2", "1", "0"],
    ...Array.from({ length: 14 }, (_, index) => ["referrer", `site${index}.example`, "", String(14 - index), "1", "0", "0"]),
    ["campaign", " |  | ", "", "9", "3", "1", "1"],
    ["campaign", "newsletter | email | fall", "", "2", "2", "1", "1"],
  ]);
  const report = shapeReport(request, rows, {});
  assert.equal(report.referrers.find((row) => row.key === "Direct or unknown").sessions, 5);
  assert.equal(report.referrers.at(-1).key, "Other");
  assert.ok(report.campaigns.some((row) => row.key === "No campaign tags"));
  assert.ok(report.campaigns.some((row) => row.key === "newsletter / email / fall"));
});

test("accepted inquiries are counted by local day without any personal fields", () => {
  const request = valid({ report: "overview", range: { start: "2026-10-01", end: "2026-10-06" } });
  const summary = summarizeAcceptedInquiries([
    { created_at: "2026-10-02T03:30:00Z", source_url: "https://exacth2o.com/quote?utm_source=newsletter&utm_campaign=fall", name: "Jane", email: "j@example.edu" },
    { created_at: "2026-10-06T23:00:00Z", source_url: "https://exacth2o.com/quote" },
    { created_at: "2026-09-28T12:00:00Z", source_url: "" },
    { created_at: "not a date" },
  ], request);
  assert.equal(summary.current, 2);
  assert.equal(summary.previous, 1);
  assert.deepEqual(summary.days, { "2026-10-01": 1, "2026-10-06": 1 });
  assert.deepEqual(summary.campaigns.map((row) => row.key).sort(), ["newsletter / (no medium) / fall", "No campaign tags"].sort());
  assert.ok(!JSON.stringify(summary).includes("example.edu"));
});

test("malformed provider results are rejected rather than shown as zero", () => {
  assert.throws(() => parseRows(null));
  assert.throws(() => parseRows([["period", "current"]]));
});

// Functions confirmed in PostHog's HogQL function registry (posthog/hogql/functions/*.py on master,
// checked 2026-10-07). HogQL rejects any other function name, so a new one must be checked there and
// added here. Notably ClickHouse's toFloat64 is NOT exposed; HogQL's toFloat is a nullable Float64 cast.
const verifiedHogqlFunctions = new Set([
  "toString", "toFloat", "toDate", "toDateTime", "toTimeZone", "toIntervalDay", "toUnixTimestamp", "now",
  "if", "coalesce", "concat", "lower", "endsWith", "substring", "length", "splitByChar", "extractURLParameter",
  "tuple", "arrayJoin", "arrayElement", "arraySort", "arrayMap", "indexOf",
  "count", "countIf", "uniqExact", "uniqExactIf", "min", "max", "minIf", "argMin", "argMinIf", "argMaxIf",
  "groupArrayIf", "quantile",
]);

test("every report query uses only HogQL-supported functions", () => {
  for (const report of reportNames) {
    for (const device of ["all", "mobile"]) {
      const queries = buildReportQueries(valid({ report, range: { preset: "90d" }, device }));
      for (const query of [queries.main, queries.secondary].filter(Boolean)) {
        const used = new Set(Array.from(query.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\(/g), (match) => match[1]));
        for (const name of used) assert.ok(verifiedHogqlFunctions.has(name), `${report}: ${name}() is not a verified HogQL function`);
        assert.doesNotMatch(query, /toFloat64\(/);
      }
    }
  }
});

test("every report query carries an explicit row limit and truncated results are rejected", () => {
  for (const report of reportNames) {
    const queries = buildReportQueries(valid({ report, range: { preset: "90d" } }));
    for (const query of [queries.main, queries.secondary].filter(Boolean)) {
      // PostHog returns 100 rows for a query without LIMIT; a trailing LIMIT on a UNION would bind
      // to its last SELECT only, so the whole union is wrapped.
      assert.match(query, /^SELECT \* FROM \(\n[\s\S]*\n\) LIMIT 10000$/);
    }
  }
  const row = ["day", "2026-10-01", "", "1", "1", "1", "0"];
  assert.throws(() => parseRows([row], true), /truncated/);
  assert.throws(() => parseRows(Array.from({ length: maxReportRows }, () => row)), /truncated/);
  assert.equal(parseRows([row]).length, 1);
});

test("server inquiry records are left out of device-filtered reports, and a failed part is not zero", () => {
  const canonical = { current: 10, previous: 4, days: { "2026-10-07": 3 } };
  const rows = parseRows([["step", "submitted", "", "2", "2", "0", "0"]]);
  const mobile = shapeReport(valid({ report: "quote", device: "mobile" }), rows, { canonical });
  assert.equal(mobile.acceptedInquiries, null);
  const all = shapeReport(valid({ report: "quote" }), rows, { canonical });
  assert.equal(all.acceptedInquiries.current, 10);

  const journeys = valid({ report: "journeys" });
  assert.equal(shapeReport(journeys, [], { secondary: null }).beforeQuote, null);
  assert.deepEqual(shapeReport(journeys, [], { secondary: [] }).beforeQuote, []);
});
