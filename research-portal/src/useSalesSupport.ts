import { useCallback,useEffect,useRef,useState } from "react";
import { supabaseQueryTimeoutMs,supportPollMs } from "./portalConstants";
import { errorMessage } from "./portalFormat";
import { initialSalesSupportData } from "./portalState";
import type { PortalAccess } from "./portalTypes";
import { type QuoteRequestRow,type SalesSupportData,type SupportMessageRow,type SupportThreadRow } from "./portalTypes";
import { supabase } from "./supabase";
import { withSupabaseTimeout } from "./supabaseTimeout";
import { scheduleVisiblePolling } from "./visiblePolling";



/** SalesSupport owns this workspace behavior; App supplies the current scope. */
type Context = {
  canUseSalesSupport: boolean;
  activeProjectId: string;
  portalAccess: PortalAccess;
  sessionReady: boolean;
};

export function useSalesSupport({ canUseSalesSupport, activeProjectId, portalAccess, sessionReady }: Context) {
  const salesSupportLoadId = useRef(0);

  const [salesSupportData, setSalesSupportData] = useState<SalesSupportData>(initialSalesSupportData);

  const [salesSupportLoading, setSalesSupportLoading] = useState(false);

  const [salesSupportError, setSalesSupportError] = useState<string | null>(null);

  const loadSalesSupport = useCallback(async (options: { silent?: boolean } = {}) => {
    const loadId = ++salesSupportLoadId.current;
    if (!canUseSalesSupport || !activeProjectId) {
      setSalesSupportData(initialSalesSupportData);
      return;
    }

    const silent = options.silent === true;
    if (!silent) {
      setSalesSupportLoading(true);
      setSalesSupportError(null);
    }

    try {
      const [quotesResponse, threadsResponse, messagesResponse] = await Promise.all([
        withSupabaseTimeout(
          supabase
            .from("quote_requests")
            .select("id, project_id, created_at, updated_at, name, email, phone, organization, application, timeline, message, source_url, referrer, notification_email, notification_status, notification_error, status, priority")
            .eq("project_id", activeProjectId)
            .order("created_at", { ascending: false })
            .limit(40),
          supabaseQueryTimeoutMs,
          "Quote requests",
        ),
        withSupabaseTimeout(
          supabase
            .from("support_threads")
            .select("id, project_id, created_at, updated_at, last_message_at, source, status, priority, request_type, subject, customer_name, customer_email, customer_phone, customer_organization, quote_request_id, last_message_preview, last_message_from_email, last_message_subject, metadata")
            .eq("project_id", activeProjectId)
            .order("last_message_at", { ascending: false })
            .limit(40),
          supabaseQueryTimeoutMs,
          "Support threads",
        ),
        withSupabaseTimeout(
          supabase
            .from("support_messages")
            .select("id, thread_id, project_id, created_at, direction, channel, from_email, from_name, to_emails, subject, body_text, body_html, metadata")
            .eq("project_id", activeProjectId)
            .order("created_at", { ascending: false })
            .limit(80),
          supabaseQueryTimeoutMs,
          "Support messages",
        ),
      ]);

      if (quotesResponse.error) throw quotesResponse.error;
      if (threadsResponse.error) throw threadsResponse.error;
      if (messagesResponse.error) throw messagesResponse.error;

      if (loadId !== salesSupportLoadId.current) return;
      setSalesSupportData({
        quotes: (quotesResponse.data ?? []) as QuoteRequestRow[],
        threads: (threadsResponse.data ?? []) as SupportThreadRow[],
        messages: (messagesResponse.data ?? []) as SupportMessageRow[],
      });
    } catch (err) {
      if (loadId !== salesSupportLoadId.current) return;
      if (!silent) setSalesSupportError(errorMessage(err));
    } finally {
      if (!silent && loadId === salesSupportLoadId.current) setSalesSupportLoading(false);
    }
  }, [activeProjectId, canUseSalesSupport]);

  const deleteQuoteRequest = useCallback(async (quoteId: string) => {
    if (!canUseSalesSupport || !activeProjectId) throw new Error("Sales & Support access is required to delete quotes.");
    const { error } = await withSupabaseTimeout(
      supabase.rpc("delete_quote_request", { p_project_id: activeProjectId, p_quote_id: quoteId }),
      supabaseQueryTimeoutMs,
      "Delete quote request",
    );
    if (error) throw error;
    // Discard earlier queue reads so they cannot restore a just-deleted item.
    salesSupportLoadId.current += 1;
    setSalesSupportData((current) => {
      const removedThreads = new Set(current.threads.filter((thread) => thread.quote_request_id === quoteId).map((thread) => thread.id));
      return {
        quotes: current.quotes.filter((quote) => quote.id !== quoteId),
        threads: current.threads.filter((thread) => !removedThreads.has(thread.id)),
        messages: current.messages.filter((message) => !removedThreads.has(message.thread_id)),
      };
    });
    void loadSalesSupport({ silent: true });
  }, [activeProjectId, canUseSalesSupport, loadSalesSupport]);

  useEffect(() => {
    // Discard in-flight responses and cached customer details across permission/project changes.
    salesSupportLoadId.current += 1;
    setSalesSupportData(initialSalesSupportData);
    setSalesSupportError(null);
    setSalesSupportLoading(false);
  }, [activeProjectId, canUseSalesSupport, portalAccess?.userId]);

  useEffect(() => {
    if (!sessionReady || !canUseSalesSupport) return;
    void loadSalesSupport();
  }, [canUseSalesSupport, loadSalesSupport, sessionReady]);

  useEffect(() => {
    if (!sessionReady || !canUseSalesSupport) return undefined;
    return scheduleVisiblePolling(() => loadSalesSupport({ silent: true }), supportPollMs);
  }, [canUseSalesSupport, loadSalesSupport, sessionReady]);

  useEffect(() => {
    if (!sessionReady || !canUseSalesSupport || !activeProjectId) return undefined;

    const channel = supabase
      .channel(`exacth2o-sales-support-live-${activeProjectId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "support_threads",
          filter: `project_id=eq.${activeProjectId}`,
        },
        () => {
          void loadSalesSupport({ silent: true });
        },
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "quote_requests",
          filter: `project_id=eq.${activeProjectId}`,
        },
        () => {
          void loadSalesSupport({ silent: true });
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [activeProjectId, canUseSalesSupport, loadSalesSupport, sessionReady]);

  return { salesSupportData, setSalesSupportData, salesSupportLoading, setSalesSupportLoading, salesSupportError, setSalesSupportError, deleteQuoteRequest };
}
