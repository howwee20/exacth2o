// A project administrator invites someone to the portal by email.
//
// The one-time link goes only to the invited address. It is never returned to the browser, so an
// administrator's session cannot be used to collect account links. Every invitation grants
// researcher access; the message text is fixed.
import { createClient } from "npm:@supabase/supabase-js@2";
import { INVITE_DAYS, INVITE_ROLE, inviteEmail, inviteMessage, projectId } from "./invite-policy.mjs";

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

  const now = new Date();
  const secret = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const expires = new Date(now.getTime() + INVITE_DAYS * 86_400_000);
  const { data, error: reserveError } = await admin.rpc("reserve_project_member_invite", {
    requested_project: project, inviting_user: user.id, invited_email: email,
    new_token_hash: await sha256Hex(secret), valid_until: expires.toISOString(),
  }).single();
  const invite = data as { outcome: string; invitation_id: string; reserved_at: string } | null;
  if (reserveError || !invite) return reply({ error: "Could not create the invitation. Try again." }, 500);
  if (invite.outcome === "forbidden") return reply({ error: "Only a project administrator can invite people." }, 403);
  if (invite.outcome === "member") return reply({ error: `${email} already has access.` }, 409);
  if (invite.outcome === "limit") return reply({ error: "Too many invitations today. Try again tomorrow." }, 429);
  if (invite.outcome !== "reserved" || !invite.invitation_id) return reply({ error: "Could not reserve an invitation." }, 500);

  const { data: named } = await admin.from("projects").select("name").eq("id", project).maybeSingle();
  let sent = false;
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${mailKey}`,
        "content-type": "application/json",
        "Idempotency-Key": `exacth2o-invite/${invite.invitation_id}`,
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
    await admin.from("project_invites").update({ expires_at: new Date().toISOString() }).eq("id", invite.invitation_id);
    return reply({ error: "The invitation email could not be sent. Try again." }, 502);
  }
  // Keep earlier invitations usable if the replacement email cannot be delivered.
  const { error: retireError } = await admin.from("project_invites").update({ expires_at: now.toISOString() })
    .eq("project_id", project).eq("email", email).eq("access_scope", "project").eq("role", INVITE_ROLE)
    .is("accepted_at", null).lt("created_at", invite.reserved_at).gt("expires_at", now.toISOString());
  if (retireError) console.error("Could not retire an older project invitation after sending a replacement.");
  return reply({ ok: true, email, expires_at: expires.toISOString() });
});
