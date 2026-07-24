import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { Webhook } from "https://esm.sh/svix@1.64.1";
import { publicIntakeProjectId } from "../_shared/installation-config.mjs";

type ResendEmailReceivedEvent = {
  type?: string;
  created_at?: string;
  data?: {
    email_id?: string;
    created_at?: string;
    from?: string;
    to?: string[];
    cc?: string[];
    bcc?: string[];
    received_for?: string[];
    message_id?: string;
    subject?: string;
    attachments?: unknown[];
  };
};

type ReceivedEmailDetail = {
  id?: string;
  from?: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  reply_to?: string[];
  subject?: string;
  html?: string | null;
  text?: string | null;
  headers?: Record<string, string>;
  received_for?: string[];
  message_id?: string;
  attachments?: unknown[];
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function clean(value: unknown, maxLength: number) {
  if (typeof value !== "string") return "";
  return value.trim().replace(/\s+/g, " ").slice(0, maxLength);
}

function cleanBody(value: unknown) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, 20000);
}

function emailAddress(value: string) {
  const match = value.match(/<([^<>@\s]+@[^<>@\s]+\.[^<>@\s]+)>/);
  if (match?.[1]) return match[1].toLowerCase();
  const plain = value.match(/([^<>\s]+@[^<>\s]+\.[^<>\s]+)/);
  return plain?.[1]?.toLowerCase() ?? value.toLowerCase();
}

function emailName(value: string) {
  const beforeAddress = value.replace(/<[^>]+>/, "").trim().replace(/^"|"$/g, "");
  if (beforeAddress && beforeAddress !== emailAddress(value)) return beforeAddress.slice(0, 120);
  return null;
}

async function verifiedEvent(request: Request, rawBody: string): Promise<ResendEmailReceivedEvent> {
  const webhookSecret = Deno.env.get("RESEND_WEBHOOK_SECRET");
  if (!webhookSecret) {
    throw new Error("Missing RESEND_WEBHOOK_SECRET");
  }

  const webhook = new Webhook(webhookSecret);
  return webhook.verify(rawBody, {
    "svix-id": request.headers.get("svix-id") ?? "",
    "svix-timestamp": request.headers.get("svix-timestamp") ?? "",
    "svix-signature": request.headers.get("svix-signature") ?? "",
  }) as ResendEmailReceivedEvent;
}

async function retrieveReceivedEmail(emailId: string): Promise<ReceivedEmailDetail | null> {
  const resendApiKey = Deno.env.get("RESEND_API_KEY");
  if (!resendApiKey) return null;

  const response = await fetch(`https://api.resend.com/emails/receiving/${encodeURIComponent(emailId)}`, {
    headers: {
      "Authorization": `Bearer ${resendApiKey}`,
      "User-Agent": "exacth2o-support-ingest/1.0",
    },
  });

  if (!response.ok) return null;
  return await response.json() as ReceivedEmailDetail;
}

serve(async (request) => {
  const intakeProjectId = publicIntakeProjectId(Deno.env.toObject());
  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }
  if (!intakeProjectId) {
    return jsonResponse({ error: "Public intake is not configured" }, 503);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse({ error: "Server is missing Supabase configuration" }, 500);
  }

  const rawBody = await request.text();

  let event: ResendEmailReceivedEvent;
  try {
    event = await verifiedEvent(request, rawBody);
  } catch {
    return jsonResponse({ error: "Invalid webhook signature" }, 400);
  }

  if (event.type !== "email.received" || !event.data?.email_id) {
    return jsonResponse({ ok: true, ignored: true });
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  const emailId = event.data.email_id;
  const messageId = clean(event.data.message_id, 500) || emailId;

  const existingByMessage = await supabase
    .from("support_messages")
    .select("id")
    .eq("external_message_id", messageId)
    .limit(1);

  if (existingByMessage.data?.length) {
    return jsonResponse({ ok: true, duplicate: true });
  }

  const existingByEmail = await supabase
    .from("support_messages")
    .select("id")
    .eq("external_email_id", emailId)
    .limit(1);

  if (existingByEmail.data?.length) {
    return jsonResponse({ ok: true, duplicate: true });
  }

  const detail = await retrieveReceivedEmail(emailId);
  const rawFrom = clean(detail?.from ?? event.data.from, 500);
  const from = emailAddress(rawFrom);
  const fromName = emailName(rawFrom);
  const toEmails = detail?.to ?? event.data.to ?? [];
  const ccEmails = detail?.cc ?? event.data.cc ?? [];
  const subject = clean(detail?.subject ?? event.data.subject ?? "Support email", 240);
  const receivedFor = detail?.received_for ?? event.data.received_for ?? [];
  const bodyText = cleanBody(detail?.text);
  const bodyHtml = cleanBody(detail?.html);

  const { data: thread, error: threadError } = await supabase
    .from("support_threads")
    .insert({
      project_id: intakeProjectId,
      source: "email",
      status: "new",
      priority: "normal",
      request_type: "support",
      subject,
      customer_name: fromName,
      customer_email: from,
      external_thread_key: messageId,
      metadata: {
        resend_email_id: emailId,
        received_for: receivedFor,
        event_created_at: event.created_at ?? null,
        attachments: detail?.attachments ?? event.data.attachments ?? [],
      },
    })
    .select("id")
    .single();

  if (threadError || !thread) {
    return jsonResponse({ error: "Could not save support email" }, 500);
  }

  const { error: messageError } = await supabase
    .from("support_messages")
    .insert({
      thread_id: thread.id,
      project_id: intakeProjectId,
      direction: "inbound",
      channel: "email",
      from_email: from,
      from_name: fromName,
      to_emails: toEmails,
      cc_emails: ccEmails,
      subject,
      body_text: bodyText || null,
      body_html: bodyHtml || null,
      external_message_id: messageId,
      external_email_id: emailId,
      metadata: {
        resend_email_id: emailId,
        received_for: receivedFor,
        headers: detail?.headers ?? {},
        attachments: detail?.attachments ?? event.data.attachments ?? [],
      },
    });

  if (messageError) {
    return jsonResponse({ error: "Could not save support message" }, 500);
  }

  return jsonResponse({ ok: true, threadId: thread.id });
});
