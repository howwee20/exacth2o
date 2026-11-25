// A project administrator invites someone to the portal by email.
//
// The one-time link goes only to the invited address. It is never returned to the browser, so an
// administrator's session cannot be used to collect account links. Every invitation grants
// researcher access; the message text is fixed.
import { createClient } from "npm:@supabase/supabase-js@2";
import { DAILY_LIMIT, INVITE_DAYS, INVITE_ROLE, inviteEmail, inviteMessage, projectId } from "./invite-policy.mjs";

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization,apikey,content-type,x-client-info",
  "access-control-allow-methods": "POST,OPTIONS",
};
const reply = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { ...cors, "cache-control": "no-store" } });

async function sha256Hex(value: string) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "POST") return reply({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const from = (Deno.env.get("NOTIFICATION_FROM_EMAIL") || Deno.env.get("QUOTE_EMAIL_FROM") || "").trim();
  const mailKey = (Deno.env.get("NOTIFICATION_RESEND_API_KEY") || Deno.env.get("RESEND_API_KEY") || "").trim();
  if (!supabaseUrl || !serviceKey || !from || !mailKey) return reply({ error: "Invitations are not set up yet." }, 503);
  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: { user }, error: authError } = await admin.auth.getUser(token);
  if (authError || !user) return reply({ error: "Sign in again to send an invitation." }, 401);

  const body = await request.json().catch(() => null);
  const project = projectId(body?.projectId);
  const email = inviteEmail(body?.email);
  if (!project) return reply({ error: "Choose a project first." }, 400);
  if (!email) return reply({ error: "Enter one email address." }, 400);

  const { data: access, error: accessError } = await admin.from("portal_access").select("role")
    .eq("project_id", project).eq("user_id", user.id).eq("access_scope", "project").maybeSingle();
  if (accessError) return reply({ error: "Could not check your access. Try again." }, 500);
  if (access?.role !== "admin") return reply({ error: "Only a project administrator can invite people." }, 403);

  const { data: member, error: memberError } = await admin.from("portal_access").select("user_id")
    .eq("project_id", project).eq("email", email).limit(1);
  if (memberError) return reply({ error: "Could not check the team. Try again." }, 500);
  if (member?.length) return reply({ error: `${email} already has access.` }, 409);

  const now = new Date();
  const { count, error: countError } = await admin.from("project_invites").select("id", { count: "exact", head: true })
    .eq("project_id", project).gte("created_at", new Date(now.getTime() - 86_400_000).toISOString());
  if (countError) return reply({ error: "Could not check recent invitations. Try again." }, 500);
  if ((count ?? 0) >= DAILY_LIMIT) return reply({ error: "Too many invitations today. Try again tomorrow." }, 429);

  const secret = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const expires = new Date(now.getTime() + INVITE_DAYS * 86_400_000);
  const { data: invite, error: insertError } = await admin.from("project_invites").insert({
    token_hash: await sha256Hex(secret), project_id: project, email, role: INVITE_ROLE, access_scope: "project",
    expires_at: expires.toISOString(), created_by: user.id,
  }).select("id,created_at").single();
  if (insertError || !invite) return reply({ error: "Could not create the invitation. Try again." }, 500);

  const { data: named } = await admin.from("projects").select("name").eq("id", project).maybeSingle();
  let sent = false;
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${mailKey}`,
        "content-type": "application/json",
        "Idempotency-Key": `exacth2o-invite/${invite.id}`,
      },
      signal: AbortSignal.timeout(8_000),
      body: JSON.stringify(inviteMessage({ to: email, from, token: secret, project: named?.name ?? "", expires })),
    });
    sent = response.ok;
  } catch {
    sent = false;
  }
  if (!sent) {
    // An invitation nobody received is withdrawn rather than left open.
    await admin.from("project_invites").update({ expires_at: new Date().toISOString() }).eq("id", invite.id);
    return reply({ error: "The invitation email could not be sent. Try again." }, 502);
  }
  // Keep earlier invitations usable if the replacement email cannot be delivered.
  const { error: retireError } = await admin.from("project_invites").update({ expires_at: now.toISOString() })
    .eq("project_id", project).eq("email", email).eq("access_scope", "project").eq("role", INVITE_ROLE)
    .is("accepted_at", null).lt("created_at", invite.created_at).gt("expires_at", now.toISOString());
  if (retireError) console.error("Could not retire an older project invitation after sending a replacement.");
  return reply({ ok: true, email, expires_at: expires.toISOString() });
});
