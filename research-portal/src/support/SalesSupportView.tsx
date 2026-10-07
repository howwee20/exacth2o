import { AlertTriangle, ArrowLeft, Loader2, Mail, MessageSquare, Search, Trash2 } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { HealthMiniFact } from "../health/HealthPanels";
import { errorMessage, formatSettingsTimestamp, mailtoUrl, supportDetailValue, supportExcerpt, supportRequestTypeLabel, supportStatusLabel, supportStatusTone } from "../portalFormat";
import { type QuoteRequestRow, type SalesSupportData, type SupportMessageRow, type SupportThreadRow } from "../portalTypes";

export function SupportStatusPill({ status }: { status?: string | null }) {
  return (
    <span className={`portal-status-pill is-${supportStatusTone(status)}`}>
      {supportStatusLabel(status)}
    </span>
  );
}

export type SupportSelectedDetail = {
  title: string;
  subtitle: string;
  messageLabel: string;
  message: string;
  replyHref: string;
  rows: Array<{ label: string; value: string }>;
};

export function SalesSupportDetailDrawer({
  detail,
  onClose,
}: {
  detail: SupportSelectedDetail | null;
  onClose: () => void;
}) {
  if (!detail) return null;

  return (
    <>
      <button
        type="button"
        className="health-detail-scrim"
        aria-label="Close selected sales support detail"
        onClick={onClose}
      />
      <aside className="health-selected-detail support-selected-detail" aria-label="Sales support detail">
        <header>
          <div>
            <p>{detail.subtitle}</p>
            <h2>{detail.title}</h2>
          </div>
          <button type="button" onClick={onClose}>Close</button>
        </header>
        <div className="health-selected-detail-rows">
          {detail.rows.map((row, index) => (
            <div className="health-selected-detail-row" key={`${row.label}-${index}`}>
              <span>{row.label}</span>
              <strong>{row.value}</strong>
            </div>
          ))}
        </div>
        <section className="support-detail-message">
          <h3>{detail.messageLabel}</h3>
          <p>{detail.message}</p>
        </section>
        <a className="settings-primary-button support-detail-reply" href={detail.replyHref}>
          <Mail size={15} />
          Reply
        </a>
      </aside>
    </>
  );
}

export function SalesSupportView({
  data,
  loading,
  error,
  onBackHome,
  onDeleteQuote,
}: {
  data: SalesSupportData;
  loading: boolean;
  error: string | null;
  onBackHome: () => void;
  onDeleteQuote: (quoteId: string) => Promise<void>;
}) {
  const [selectedDetail, setSelectedDetail] = useState<SupportSelectedDetail | null>(null);
  const [deletingQuoteId, setDeletingQuoteId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const deletingRef = useRef(false);

  async function deleteQuote(quote: QuoteRequestRow) {
    if (deletingRef.current || !window.confirm(`Permanently delete the quote request from ${quote.name}? Its linked quote conversation will also be removed. This cannot be undone.`)) return;
    deletingRef.current = true;
    setDeletingQuoteId(quote.id);
    setDeleteError(null);
    try {
      await onDeleteQuote(quote.id);
      setSelectedDetail(null);
    } catch (err) {
      setDeleteError(errorMessage(err));
    } finally {
      deletingRef.current = false;
      setDeletingQuoteId(null);
    }
  }

  const supportThreads = data.threads.filter((item) => item.request_type !== "quote" && item.source !== "quote");
  const messagesByThread = useMemo(() => {
    const messages = new Map<string, SupportMessageRow>();
    data.messages
      .slice()
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .forEach((message) => {
        if (!messages.has(message.thread_id)) messages.set(message.thread_id, message);
      });
    return messages;
  }, [data.messages]);
  const openQuotes = data.quotes.filter((item) => item.status !== "closed" && item.status !== "won" && item.status !== "lost");
  const openThreads = supportThreads.filter((item) => item.status !== "closed" && item.status !== "won" && item.status !== "lost");
  const newItems = [
    ...data.quotes.filter((item) => (item.status ?? "new") === "new"),
    ...supportThreads.filter((item) => item.status === "new"),
  ];
  const latestUpdated = [
    ...data.quotes.map((item) => item.updated_at ?? item.created_at),
    ...supportThreads.map((item) => item.last_message_at ?? item.updated_at ?? item.created_at),
  ]
    .filter(Boolean)
    .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0] ?? null;

  function selectQuote(quote: QuoteRequestRow) {
    setSelectedDetail({
      title: quote.application,
      subtitle: "Quote Request",
      messageLabel: "Project Details",
      message: supportDetailValue(quote.message),
      replyHref: mailtoUrl(quote.email, `exactH2O quote: ${quote.application}`),
      rows: [
        { label: "Customer", value: supportDetailValue(quote.name) },
        { label: "Email", value: supportDetailValue(quote.email) },
        { label: "Phone", value: supportDetailValue(quote.phone) },
        { label: "Organization", value: supportDetailValue(quote.organization) },
        { label: "Application", value: supportDetailValue(quote.application) },
        { label: "Timeline", value: supportDetailValue(quote.timeline) },
        { label: "Submitted", value: formatSettingsTimestamp(quote.created_at) },
        { label: "Updated", value: formatSettingsTimestamp(quote.updated_at) },
        { label: "Status", value: supportStatusLabel(quote.status ?? "new") },
        { label: "Priority", value: supportStatusLabel(quote.priority ?? "normal") },
      ],
    });
  }

  function selectThread(thread: SupportThreadRow) {
    const message = messagesByThread.get(thread.id);
    setSelectedDetail({
      title: thread.subject,
      subtitle: "Support Request",
      messageLabel: "Message",
      message: supportDetailValue(message?.body_text ?? thread.last_message_preview),
      replyHref: mailtoUrl(thread.customer_email, thread.subject),
      rows: [
        { label: "Customer", value: supportDetailValue(thread.customer_name) },
        { label: "Email", value: supportDetailValue(thread.customer_email) },
        { label: "Phone", value: supportDetailValue(thread.customer_phone) },
        { label: "Organization", value: supportDetailValue(thread.customer_organization) },
        { label: "Type", value: supportRequestTypeLabel(thread.request_type) },
        { label: "Source", value: supportStatusLabel(thread.source) },
        { label: "Status", value: supportStatusLabel(thread.status) },
        { label: "Priority", value: supportStatusLabel(thread.priority) },
        { label: "Created", value: formatSettingsTimestamp(thread.created_at) },
        { label: "Last message", value: formatSettingsTimestamp(thread.last_message_at) },
        { label: "Last from", value: supportDetailValue(thread.last_message_from_email ?? message?.from_email) },
        { label: "Message subject", value: supportDetailValue(message?.subject ?? thread.last_message_subject) },
        { label: "Thread ID", value: thread.id },
      ],
    });
  }

  return (
    <section className="sales-support-main" aria-label="Sales and support">
      <SalesSupportDetailDrawer detail={selectedDetail} onClose={() => setSelectedDetail(null)} />
      <button type="button" className="support-back-button" onClick={onBackHome}>
        <ArrowLeft size={15} />
        Home
      </button>
      <header className="support-hero">
        <div>
          <p>Sales &amp; Support</p>
          <h1>{newItems.length} new</h1>
        </div>
        {loading ? (
          <Loader2 className="chart-loading-spinner" size={22} aria-label="Loading support queue" />
        ) : null}
      </header>

      {deleteError || error ? (
        <div className="banner error">
          <AlertTriangle size={18} />
          {deleteError || error}
        </div>
      ) : null}

      <div className="support-summary-grid">
        <HealthMiniFact label="Open quotes" value={String(openQuotes.length)} />
        <HealthMiniFact label="Open support" value={String(openThreads.length)} />
        <HealthMiniFact label="New items" value={String(newItems.length)} />
        <HealthMiniFact label="Last update" value={formatSettingsTimestamp(latestUpdated)} />
      </div>

      <div className="support-queue-grid">
        <section className="support-panel">
          <header>
            <div>
              <p>Sales</p>
              <h2>Quote Requests</h2>
            </div>
            <span>{data.quotes.length}</span>
          </header>
          <div className="support-list">
            {data.quotes.length ? data.quotes.map((quote) => (
              <article className="support-item" key={quote.id}>
                <div
                  className="support-item-main support-item-clickable"
                  role="button"
                  tabIndex={0}
                  onClick={() => selectQuote(quote)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      selectQuote(quote);
                    }
                  }}
                >
                  <div className="support-item-title">
                    <strong>{quote.application}</strong>
                    <SupportStatusPill status={quote.status ?? "new"} />
                  </div>
                  <p>{supportExcerpt(quote.message)}</p>
                  <dl>
                    <div>
                      <dt>Customer</dt>
                      <dd>{quote.name} · {quote.email}</dd>
                    </div>
                    <div>
                      <dt>Organization</dt>
                      <dd>{quote.organization || "Not provided"}</dd>
                    </div>
                    <div>
                      <dt>Submitted</dt>
                      <dd>{formatSettingsTimestamp(quote.created_at)}</dd>
                    </div>
                  </dl>
                </div>
                <div className="support-item-actions">
                  <button type="button" className="settings-secondary-button" onClick={() => selectQuote(quote)}>
                    <Search size={14} />
                    Details
                  </button>
                  <a className="settings-secondary-button" href={mailtoUrl(quote.email, `exactH2O quote: ${quote.application}`)}>
                    <Mail size={14} />
                    Reply
                  </a>
                  <button
                    type="button"
                    className="settings-secondary-button support-delete-button"
                    disabled={deletingQuoteId !== null}
                    onClick={() => void deleteQuote(quote)}
                    aria-label={`Delete quote request from ${quote.name}`}
                  >
                    {deletingQuoteId === quote.id ? <Loader2 size={14} className="chart-loading-spinner" /> : <Trash2 size={14} />}
                    {deletingQuoteId === quote.id ? "Deleting…" : "Delete"}
                  </button>
                </div>
              </article>
            )) : (
              <div className="support-empty">No quote requests yet.</div>
            )}
          </div>
        </section>

        <section className="support-panel">
          <header>
            <div>
              <p>Inbox</p>
              <h2>Support Emails</h2>
            </div>
            <span>{supportThreads.length}</span>
          </header>
          <div className="support-list">
            {supportThreads.length ? supportThreads.map((thread) => (
              <article className="support-item" key={thread.id}>
                <div
                  className="support-item-main support-item-clickable"
                  role="button"
                  tabIndex={0}
                  onClick={() => selectThread(thread)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      selectThread(thread);
                    }
                  }}
                >
                  <div className="support-item-title">
                    <strong>{thread.subject}</strong>
                    <SupportStatusPill status={thread.status} />
                  </div>
                  <p>
                    {thread.last_message_preview
                      ? supportExcerpt(thread.last_message_preview)
                      : `${supportRequestTypeLabel(thread.request_type)} · ${thread.source === "email" ? "Email" : "Website"}`}
                  </p>
                  <dl>
                    <div>
                      <dt>Customer</dt>
                      <dd>{thread.customer_name ? `${thread.customer_name} · ` : ""}{thread.customer_email}</dd>
                    </div>
                    <div>
                      <dt>Organization</dt>
                      <dd>{thread.customer_organization || "Not provided"}</dd>
                    </div>
                    <div>
                      <dt>Last message</dt>
                      <dd>{formatSettingsTimestamp(thread.last_message_at)}</dd>
                    </div>
                  </dl>
                </div>
                <div className="support-item-actions">
                  <button type="button" className="settings-secondary-button" onClick={() => selectThread(thread)}>
                    <Search size={14} />
                    Details
                  </button>
                  <a className="settings-secondary-button" href={mailtoUrl(thread.customer_email, thread.subject)}>
                    <MessageSquare size={14} />
                    Reply
                  </a>
                </div>
              </article>
            )) : (
              <div className="support-empty">No support emails captured yet.</div>
            )}
          </div>
        </section>
      </div>
    </section>
  );
}
