import { describe, expect, it } from "vitest";
import {
  allowedEventNames,
  classifyError,
  cleanUrl,
  createRateLimiter,
  ctaPlacement,
  cumulativeLayoutShift,
  deviceClass,
  interactionToNextPaint,
  normalizePage,
  parseDemoMessage,
  quoteFailure,
  sanitizeEventProperties,
} from "./siteMetricsContract";

describe("event contract", () => {
  it("rejects events outside the vocabulary, including broad autocapture", () => {
    expect(sanitizeEventProperties("$autocapture", {})).toBeNull();
    expect(sanitizeEventProperties("$snapshot", {})).toBeNull();
    expect(allowedEventNames.has("$rageclick")).toBe(false);
  });

  it("drops anything resembling form contents or free text", () => {
    const cleaned = sanitizeEventProperties("quote_submitted", {
      submission_id: "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed",
      attempt: 2,
      duplicate: false,
      email: "person@example.edu",
      message: "We run 120 pots",
      name: "Jane",
    });
    expect(cleaned).toEqual({ submission_id: "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed", attempt: 2, duplicate: false });
  });

  it("refuses identifiers that could carry personal data", () => {
    expect(sanitizeEventProperties("quote_submit_attempted", { submission_id: "person@example.edu", attempt: 1 }))
      .toEqual({ attempt: 1 });
    expect(sanitizeEventProperties("quote_submit_attempted", { submission_id: "Jane Smith", attempt: 1 }))
      .toEqual({ attempt: 1 });
  });

  it("bounds numbers and restricts lists to known codes", () => {
    expect(sanitizeEventProperties("web_vitals", { lcp_ms: 9_999_999, cls: 0.12345, inp_ms: -5 }))
      .toEqual({ lcp_ms: 120_000, cls: 0.123, inp_ms: 0 });
    expect(sanitizeEventProperties("quote_validation_failed", {
      fields: ["email", "email", "password"],
      errors: ["invalid_format", "<script>"],
      issues: ["email:invalid_format", "email:typed-value"],
      issue_list: ["name:missing", "email:invalid_format", "email:jane@x.com"],
      field_count: 1,
    })).toEqual({
      fields: ["email"],
      errors: ["invalid_format"],
      issues: ["email:invalid_format"],
      issue_list: "email:invalid_format|name:missing",
      field_count: 1,
    });
  });

  it("keeps SDK context and common properties", () => {
    expect(sanitizeEventProperties("$pageview", { $current_url: "https://exacth2o.com/", page: "/", custom: "x" }))
      .toEqual({ $current_url: "https://exacth2o.com/", page: "/" });
  });
});

describe("page context", () => {
  it("normalises pages and classifies layouts by viewport", () => {
    expect(normalizePage("/applications.html")).toBe("/applications");
    expect(normalizePage("/index.html")).toBe("/");
    expect(normalizePage("/quote/")).toBe("/quote");
    expect(normalizePage("/portal")).toBe("/other");
    expect(deviceClass(390)).toBe("mobile");
    expect(deviceClass(820)).toBe("tablet");
    expect(deviceClass(1440)).toBe("desktop");
  });

  it("keeps campaign parameters and strips everything else from URLs", () => {
    expect(cleanUrl("https://exacth2o.com/quote?utm_source=newsletter&utm_campaign=fall&email=a%40b.com#form", "https://exacth2o.com"))
      .toBe("https://exacth2o.com/quote?utm_source=newsletter&utm_campaign=fall");
  });

  it("names CTA placement from the nearest landmark", () => {
    const element = (match: string) => ({ closest: (selector: string) => (selector === match ? {} : null) });
    expect(ctaPlacement(element("nav"))).toBe("nav");
    expect(ctaPlacement(element(".cta-strip"))).toBe("cta_strip");
    expect(ctaPlacement(element("none"))).toBe("body");
  });
});

describe("demo message bridge", () => {
  it("accepts only the fixed message shapes and ignores extra fields", () => {
    expect(parseDemoMessage({ type: "exacth2o-demo", version: 1, name: "demo_ready" })).toEqual({ name: "demo_ready" });
    expect(parseDemoMessage({ type: "exacth2o-demo", version: 1, name: "demo_interacted", action: "select_pot", vwc: 31.2, pot: "Pot 4" }))
      .toEqual({ name: "demo_interacted", action: "select_pot" });
    expect(parseDemoMessage({ type: "exacth2o-demo", version: 1, name: "demo_interacted", action: "change_graph_view", view: "overlay" }))
      .toEqual({ name: "demo_interacted", action: "change_graph_view", view: "overlay" });
  });

  it("rejects unknown versions, names, actions and non-objects", () => {
    expect(parseDemoMessage({ type: "exacth2o-demo", version: 2, name: "demo_ready" })).toBeNull();
    expect(parseDemoMessage({ type: "other", version: 1, name: "demo_ready" })).toBeNull();
    expect(parseDemoMessage({ type: "exacth2o-demo", version: 1, name: "$pageview" })).toBeNull();
    expect(parseDemoMessage({ type: "exacth2o-demo", version: 1, name: "demo_interacted", action: "manual_water" })).toBeNull();
    expect(parseDemoMessage("demo_ready")).toBeNull();
  });

  it("rate-limits repeated actions and caps a page's total", () => {
    const allow = createRateLimiter({ minSpacingMs: 3000, maxTotal: 3 });
    expect(allow("select_pot", 0)).toBe(true);
    expect(allow("select_pot", 1000)).toBe(false);
    expect(allow("select_pot", 3500)).toBe(true);
    expect(allow("filter_pots", 3600)).toBe(true);
    expect(allow("expand_chart", 9000)).toBe(false);
  });
});

describe("web vitals", () => {
  it("uses the largest session window for CLS and ignores input-driven shifts", () => {
    expect(cumulativeLayoutShift([
      { startTime: 100, value: 0.05 },
      { startTime: 400, value: 0.05 },
      { startTime: 3000, value: 0.02 },
      { startTime: 3100, value: 0.5, hadRecentInput: true },
    ])).toBeCloseTo(0.1);
  });

  it("reports the slowest interaction, or a high percentile with many", () => {
    expect(interactionToNextPaint([{ interactionId: 1, duration: 80 }, { interactionId: 1, duration: 120 }, { interactionId: 2, duration: 60 }])).toBe(120);
    const many = Array.from({ length: 100 }, (_, index) => ({ interactionId: index + 1, duration: index }));
    expect(interactionToNextPaint(many)).toBe(97);
    expect(interactionToNextPaint([{ duration: 300 }])).toBeNull();
  });
});

describe("errors and failures", () => {
  it("records only coarse error categories", () => {
    expect(classifyError({ kind: "resource", tagName: "IMG", url: "https://exacth2o.com/hero.webp", origin: "https://exacth2o.com" }))
      .toEqual({ kind: "resource", source: "first_party", resource_type: "img" });
    expect(classifyError({ kind: "script", url: "https://cdn.example.com/x.js", origin: "https://exacth2o.com" }))
      .toEqual({ kind: "script", source: "third_party", resource_type: undefined });
    expect(classifyError({ kind: "script", url: null, origin: "https://exacth2o.com" }).source).toBe("inline");
  });

  it("maps quote failures to categories, never server text", () => {
    expect(quoteFailure(null)).toEqual({ reason: "network", status_class: "none" });
    expect(quoteFailure(429)).toEqual({ reason: "rate_limited", status_class: "4xx" });
    expect(quoteFailure(400)).toEqual({ reason: "rejected", status_class: "4xx" });
    expect(quoteFailure(503)).toEqual({ reason: "server", status_class: "5xx" });
  });
});
