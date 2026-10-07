// Response shapes produced by supabase/functions/website-analytics/report-policy.mjs.

export type Metric = { value: number; previous: number | null; change: number | null };

export type DayRow = {
  date: string;
  visitors: number;
  sessions: number;
  pageviews: number;
  inquiries: number;
  acceptedInquiries: number | null;
  partial: boolean;
};

export type OverviewData = {
  visitors: Metric;
  sessions: Metric;
  pageviews: Metric;
  engagedSessions: Metric;
  quotePageSessions: Metric;
  demoClicks: Metric;
  quoteClicks: Metric;
  demoInteractionSessions: Metric;
  formStartSessions: Metric;
  analyticsInquiries: Metric;
  acceptedInquiries: Metric | null;
  days: DayRow[];
};

export type OutcomeRow = { key: string; sessions: number; engaged: number; quoteSessions: number; inquirySessions: number };

export type AcquisitionData = {
  referrers: OutcomeRow[];
  campaigns: OutcomeRow[];
  landingPages: OutcomeRow[];
  devices: OutcomeRow[];
  canonicalCampaigns: Array<{ key: string; inquiries: number }> | null;
};

export type FunnelStep = { key: string; label: string; sessions: number };

export type JourneysData = {
  demoFunnel: FunnelStep[];
  quoteFunnel: FunnelStep[];
  routes: Record<"direct" | "withoutApplications" | "afterApplications", { sessions: number; inquirySessions: number }>;
  entryPages: OutcomeRow[];
  exitPages: Array<{ key: string; sessions: number; singlePage: number }>;
  /** null when the secondary query failed; never shown as zero. */
  beforeQuote: Array<{ key: string; sessions: number }> | null;
};

type Stage = { sessions: number; events: number };

export type DemoData = {
  stages: { applications: Stage; viewed: Stage; ready: Stage; interacted: Stage; loadFailed: Stage };
  actions: Array<{ action: string; view: string | null; events: number; sessions: number }>;
  demoLinks: Array<{ placement: string; events: number; sessions: number }>;
  readyWait: { samples: number; medianMs: number | null; p90Ms: number | null };
  afterInteraction: { sessions: number; reachedQuote: number; submitted: number };
};

type Step = { count: number; events: number };

export type QuoteData = {
  steps: {
    quotePage: Step;
    formViewed: Step;
    formStarted: Step;
    validationFailed: Step;
    submitAttempted: Step;
    submitted: Step;
    submitFailed: Step;
  };
  acceptedInquiries: { current: number; previous: number } | null;
  issues: Array<{ issue: string; events: number }>;
  failures: Array<{ reason: string; statusClass: string; events: number }>;
  quoteLinks: Array<{ placement: string; events: number; sessions: number }>;
};

type Vital = { samples: number; p75: number | null; p50: number | null };

export type ExperienceData = {
  vitals: Array<{ page: string; device: string; lcp?: Vital; inp?: Vital; cls?: Vital }>;
  vitalPageViews: Array<{ page: string; device: string; pageViews: number }>;
  errors: Array<{ page: string; category: string; events: number; sessions: number }>;
  failures: Array<{ event: string; events: number; sessions: number }>;
  scroll: Array<{ page: string; samples: number; medianMaxScroll: number | null; reached75: number }>;
};

export type QualityData = {
  collectionStartDate: string;
  events: Array<{ event: string; inRange: number; firstSeen: string | null; lastSeen: string | null }>;
  schemas: Array<{ version: number; events: number; firstSeen: string | null; lastSeen: string | null }>;
  daily: Array<{ date: string; events: number; visitors: number; partial: boolean }>;
  canonicalAvailable: boolean;
};
