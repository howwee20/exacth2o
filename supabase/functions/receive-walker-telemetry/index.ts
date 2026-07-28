import { createClient } from "npm:@supabase/supabase-js@2";
import {
  constantTimeSecretMatch,
  parseWalkerTelemetryEnvelope,
  PayloadTooLargeError,
  readBoundedJson,
  walkerTelemetryRpc,
} from "./receiver-policy.mjs";

const maximumPayloadBytes = 2_000_000;

function response(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}

function bearerToken(request: Request) {
  return (request.headers.get("authorization") ?? "")
    .replace(/^Bearer\s+/i, "")
    .trim();
}

Deno.serve(async (request) => {
  if (request.method !== "POST") {
    return response({ error: "Method not allowed" }, 405);
  }
  if (request.headers.get("origin")) {
    return response({ error: "Browser-origin requests are not accepted" }, 403);
  }
  const expectedSecret = (Deno.env.get("WALKER_TELEMETRY_PUBLISH_SECRET") ?? "")
    .trim();
  if (
    !expectedSecret ||
    !constantTimeSecretMatch(bearerToken(request), expectedSecret)
  ) {
    return response({ error: "Unauthorized" }, 401);
  }
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > maximumPayloadBytes) {
    return response({ error: "Payload too large" }, 413);
  }

  try {
    const envelope = parseWalkerTelemetryEnvelope(
      await readBoundedJson(request, maximumPayloadBytes),
    );
    const rpc = walkerTelemetryRpc(envelope);
    const admin = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
    const { data, error } = await admin.rpc(rpc.name, rpc.args);
    if (error) {
      console.error("Walker telemetry receiver RPC rejected", {
        rpc: rpc.name,
        code: error.code,
        message: error.message,
      });
      return response({ error: "Telemetry append rejected" }, 409);
    }
    return response({ ok: true, result: data }, 200);
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      return response({ error: "Payload too large" }, 413);
    }
    const message = error instanceof Error ? error.message : "Invalid request";
    return response({ error: message }, 400);
  }
});
