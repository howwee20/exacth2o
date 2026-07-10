import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { acceptedInviteRoles } from "./invite-role-policy.mjs";

type InvitePayload = {
  token?: string;
  email?: string;
  password?: string;
  termsAccepted?: boolean;
  termsVersion?: string;
  honey?: string;
};

type InviteRow = {
  id: string;
  project_id: string;
  email: string;
  role: string;
  expires_at: string;
  accepted_at: string | null;
};

const allowedOrigins = new Set([
  "https://exacth2o.com",
  "https://www.exacth2o.com",
  "http://exacth2o.com",
  "http://www.exacth2o.com",
  "https://howwee20.github.io",
  "http://127.0.0.1:5173",
  "http://localhost:5173",
  "http://127.0.0.1:8123",
  "http://localhost:8123",
]);
const currentTermsVersion = "2026-07-07";

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
  return value.trim().slice(0, maxLength);
}

function isEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function existingUserError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /already|registered|exists/i.test(message);
}

async function sha256Hex(value: string) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
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

  let payload: InvitePayload;
  try {
    payload = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid request body" }, 400, origin);
  }

  if (payload.honey) {
    return jsonResponse({ ok: true }, 200, origin);
  }

  const token = clean(payload.token, 256);
  const email = clean(payload.email, 200).toLowerCase();
  const password = typeof payload.password === "string" ? payload.password : "";
  const termsVersion = clean(payload.termsVersion, 64);

  if (token.length < 32 || token.length > 256) {
    return jsonResponse({ error: "Invalid invite link" }, 400, origin);
  }

  if (!isEmail(email)) {
    return jsonResponse({ error: "Enter the email address that was invited" }, 400, origin);
  }

  if (password.length < 8) {
    return jsonResponse({ error: "Use at least 8 characters" }, 400, origin);
  }

  if (payload.termsAccepted !== true || termsVersion !== currentTermsVersion) {
    return jsonResponse({ error: "Review and accept the current Software Access Terms" }, 400, origin);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");

  if (!supabaseUrl || !serviceRoleKey || !anonKey) {
    return jsonResponse({ error: "Server is missing Supabase configuration" }, 500, origin);
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });
  const authClient = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false },
  });

  const tokenHash = await sha256Hex(token);
  const { data: inviteData, error: inviteError } = await admin
    .from("project_invites")
    .select("id, project_id, email, role, expires_at, accepted_at")
    .eq("token_hash", tokenHash)
    .maybeSingle();
  const invite = inviteData as InviteRow | null;

  if (inviteError) {
    return jsonResponse({ error: "Could not validate invite" }, 500, origin);
  }

  if (!invite || invite.accepted_at || new Date(invite.expires_at).getTime() <= Date.now()) {
    return jsonResponse({ error: "Invite is invalid or expired" }, 400, origin);
  }

  if (invite.email !== email) {
    return jsonResponse({ error: "This invite is for a different email address" }, 403, origin);
  }

  const acceptedRoles = acceptedInviteRoles(invite.role);
  if (!acceptedRoles) {
    return jsonResponse({ error: "Invite has an unsupported access role" }, 500, origin);
  }

  let userId = "";
  let session: unknown = null;
  const created = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });

  if (created.error) {
    if (!existingUserError(created.error)) {
      return jsonResponse({ error: "Could not create account" }, 500, origin);
    }

    const signedIn = await authClient.auth.signInWithPassword({ email, password });
    if (signedIn.error || !signedIn.data.session || !signedIn.data.user) {
      return jsonResponse({
        error: "This email already has an account. Sign in with the existing password to accept the invite.",
      }, 401, origin);
    }

    userId = signedIn.data.user.id;
    session = signedIn.data.session;
  } else {
    if (!created.data.user) {
      return jsonResponse({ error: "Could not create account" }, 500, origin);
    }

    const signedIn = await authClient.auth.signInWithPassword({ email, password });
    if (signedIn.error || !signedIn.data.session) {
      return jsonResponse({ error: "Account was created, but sign-in failed" }, 500, origin);
    }

    userId = created.data.user.id;
    session = signedIn.data.session;
  }

  const profileName = email.split("@")[0] || "exactH2O user";
  const profileInsert = await admin
    .from("profiles")
    .insert({
      id: userId,
      email,
      full_name: profileName,
    });

  if (profileInsert.error && profileInsert.error.code !== "23505") {
    return jsonResponse({ error: "Could not create profile" }, 500, origin);
  }

  if (profileInsert.error?.code === "23505") {
    const profileUpdate = await admin
      .from("profiles")
      .update({ email })
      .eq("id", userId);
    if (profileUpdate.error) {
      return jsonResponse({ error: "Could not update profile" }, 500, origin);
    }
  }

  const acceptedAt = new Date().toISOString();
  const ipAddress =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim().slice(0, 120) ||
    request.headers.get("cf-connecting-ip")?.slice(0, 120) ||
    null;
  const userAgent = request.headers.get("user-agent")?.slice(0, 500) ?? null;

  const termsAcceptance = await admin
    .from("software_terms_acceptances")
    .insert({
      user_id: userId,
      project_id: invite.project_id,
      invite_id: invite.id,
      email,
      terms_version: termsVersion,
      accepted_at: acceptedAt,
      ip_address: ipAddress,
      user_agent: userAgent,
    });

  if (termsAcceptance.error && termsAcceptance.error.code !== "23505") {
    return jsonResponse({ error: "Could not record terms acceptance" }, 500, origin);
  }

  const membership = await admin
    .from("project_members")
    .upsert({
      project_id: invite.project_id,
      user_id: userId,
      role: acceptedRoles.projectMemberRole,
    }, {
      onConflict: "project_id,user_id",
    });

  if (membership.error) {
    return jsonResponse({ error: "Could not grant project access" }, 500, origin);
  }

  const accepted = await admin
    .from("project_invites")
    .update({
      accepted_at: acceptedAt,
      accepted_by: userId,
    })
    .eq("id", invite.id)
    .is("accepted_at", null)
    .select("id")
    .maybeSingle();

  if (accepted.error || !accepted.data) {
    return jsonResponse({ error: "Invite was already accepted" }, 409, origin);
  }

  return jsonResponse({
    ok: true,
    projectId: invite.project_id,
    session,
  }, 200, origin);
});
