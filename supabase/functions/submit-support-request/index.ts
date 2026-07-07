import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

type SupportPayload = {
  name?: string;
  email?: string;
  phone?: string;
  organization?: string;
  requestType?: string;
  subject?: string;
  message?: string;
  sourceUrl?: string;
  honey?: string;
};

const mattProjectId = "22222222-2222-4222-8222-222222222222";

const allowedOrigins = new Set([
  "https://exacth2o.com",
  "https://www.exacth2o.com",
  "http://exacth2o.com",
  "http://www.exacth2o.com",
  "https://howwee20.github.io",
  "http://127.0.0.1:8123",
  "http://localhost:8123",
]);

const requestTypes = new Set([
  "support",
  "demo",
  "docs",
  "training",
  "billing",
  "install",
  "other",
]);

function corsHeaders(origin: string | null) {
  const allowedOrigin = origin && allowedOrigins.has(origin) ? origin : "https://exacth2o.com";
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function jsonResponse(body: unknown, status: number, origin: string | null) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(origin),
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function clean(value: unknown, maxLength: number) {
  if (typeof value !== "string") return "";
  return value.trim().replace(/\s+/g, " ").slice(0, maxLength);
}

function cleanMessage(value: unknown) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, 4000);
}

function isEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function field(label: string, value: string) {
  return `<tr><td style="padding:8px 12px;color:#5f6b62;border-bottom:1px solid #e7ebe5;">${escapeHtml(label)}</td><td style="padding:8px 12px;border-bottom:1px solid #e7ebe5;">${escapeHtml(value || "Not provided")}</td></tr>`;
}

function buildEmailHtml(submission: Required<Omit<SupportPayload, "honey">>, requestType: string) {
  return `
    <div style="font-family:Arial,sans-serif;color:#0e1a14;line-height:1.5;">
      <h1 style="margin:0 0 12px;font-size:22px;">New exactH2O ${escapeHtml(requestType)} request</h1>
      <p style="margin:0 0 18px;color:#5f6b62;">A visitor submitted a support request on exacth2o.com.</p>
      <table style="border-collapse:collapse;width:100%;max-width:680px;border:1px solid #e7ebe5;">
        ${field("Name", submission.name)}
        ${field("Email", submission.email)}
        ${field("Phone", submission.phone)}
        ${field("Organization", submission.organization)}
        ${field("Request type", requestType)}
        ${field("Subject", submission.subject)}
        ${field("Source page", submission.sourceUrl)}
      </table>
      <h2 style="margin:22px 0 8px;font-size:16px;">Message</h2>
      <div style="white-space:pre-wrap;padding:14px 16px;background:#f4f1eb;border:1px solid #e7ebe5;">${escapeHtml(submission.message)}</div>
    </div>
  `;
}

function buildEmailText(submission: Required<Omit<SupportPayload, "honey">>, requestType: string) {
  return [
    `New exactH2O ${requestType} request`,
    "",
    `Name: ${submission.name}`,
    `Email: ${submission.email}`,
    `Phone: ${submission.phone || "Not provided"}`,
    `Organization: ${submission.organization || "Not provided"}`,
    `Request type: ${requestType}`,
    `Subject: ${submission.subject}`,
    `Source page: ${submission.sourceUrl || "Not provided"}`,
    "",
    "Message:",
    submission.message,
  ].join("\n");
}

serve(async (request) => {
  const origin = request.headers.get("Origin");

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }

  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405, origin);
  }

  if (origin && !allowedOrigins.has(origin)) {
    return jsonResponse({ error: "Origin not allowed" }, 403, origin);
  }

  let payload: SupportPayload;
  try {
    payload = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid request body" }, 400, origin);
  }

  if (payload.honey) {
    return jsonResponse({ ok: true }, 200, origin);
  }

  const requestType = clean(payload.requestType, 40).toLowerCase();
  const normalizedRequestType = requestTypes.has(requestType) ? requestType : "support";
  const submission = {
    name: clean(payload.name, 120),
    email: clean(payload.email, 240).toLowerCase(),
    phone: clean(payload.phone, 40),
    organization: clean(payload.organization, 160),
    requestType: normalizedRequestType,
    subject: clean(payload.subject, 240) || "Support request",
    message: cleanMessage(payload.message),
    sourceUrl: clean(payload.sourceUrl, 500),
  };

  if (!submission.name || !isEmail(submission.email) || !submission.subject || !submission.message) {
    return jsonResponse({ error: "Missing required fields" }, 400, origin);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const resendApiKey = Deno.env.get("RESEND_API_KEY");
  const emailTo = Deno.env.get("SUPPORT_NOTIFY_EMAIL") ?? Deno.env.get("QUOTE_EMAIL_TO") ?? "support@exacth2o.com";
  const emailFrom = Deno.env.get("SUPPORT_EMAIL_FROM") ?? Deno.env.get("QUOTE_EMAIL_FROM") ?? "exactH2O Support <onboarding@resend.dev>";

  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse({ error: "Server is missing Supabase configuration" }, 500, origin);
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  const { data: thread, error: threadError } = await supabase
    .from("support_threads")
    .insert({
      project_id: mattProjectId,
      source: "form",
      status: "new",
      priority: "normal",
      request_type: submission.requestType,
      subject: submission.subject,
      customer_name: submission.name,
      customer_email: submission.email,
      customer_phone: submission.phone || null,
      customer_organization: submission.organization || null,
      metadata: {
        source_url: submission.sourceUrl || null,
        referrer: clean(request.headers.get("Referer"), 500) || null,
        origin,
        user_agent: clean(request.headers.get("User-Agent"), 500) || null,
      },
    })
    .select("id")
    .single();

  if (threadError || !thread) {
    return jsonResponse({ error: "Could not save support request" }, 500, origin);
  }

  const { error: messageError } = await supabase
    .from("support_messages")
    .insert({
      thread_id: thread.id,
      project_id: mattProjectId,
      direction: "inbound",
      channel: "form",
      from_email: submission.email,
      from_name: submission.name,
      to_emails: ["support@exacth2o.com"],
      subject: submission.subject,
      body_text: submission.message,
      metadata: {
        request_type: submission.requestType,
        source_url: submission.sourceUrl || null,
      },
    });

  if (messageError) {
    await supabase
      .from("support_threads")
      .update({
        metadata: {
          message_insert_error: messageError.message,
        },
      })
      .eq("id", thread.id);
  }

  if (resendApiKey) {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: emailFrom,
        to: [emailTo],
        reply_to: submission.email,
        subject: `New exactH2O ${submission.requestType} request: ${submission.subject}`,
        text: buildEmailText(submission, submission.requestType),
        html: buildEmailHtml(submission, submission.requestType),
      }),
    }).catch(() => null);
  }

  return jsonResponse({ ok: true, requestId: thread.id }, 200, origin);
});
