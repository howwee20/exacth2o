#!/usr/bin/env node
// Local-only HTTP proxy that meters chamber-agent traffic for the harness.
// Every request forwarded to a LOCAL Supabase stack is recorded as one JSON
// line: start/end time, function, action, status, bytes and any command ids
// delivered in the response. It refuses non-loopback upstreams so it can
// never point a client at production.
//
//   node metering-proxy.mjs --listen 57400 --upstream http://127.0.0.1:57321 --log run.jsonl [--bind 127.0.0.1]
import http from "node:http";
import { appendFileSync } from "node:fs";

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => {
  if (value.startsWith("--")) pairs.push([value.slice(2), all[index + 1]]);
  return pairs;
}, []));
const listenPort = Number(args.listen ?? 57400);
const upstream = new URL(args.upstream ?? "http://127.0.0.1:57321");
const logPath = args.log;
const bindAddress = args.bind ?? "127.0.0.1";
if (!["127.0.0.1", "localhost", "host.docker.internal"].includes(upstream.hostname)) {
  console.error("metering-proxy only forwards to a local stack");
  process.exit(2);
}
if (!logPath) {
  console.error("--log is required");
  process.exit(2);
}

function deliveredCommandIds(text) {
  try {
    const body = JSON.parse(text);
    const ids = [];
    for (const command of Array.isArray(body?.commands) ? body.commands : []) {
      if (typeof command?.id === "string") ids.push(command.id);
    }
    if (typeof body?.command?.id === "string") ids.push(body.command.id);
    return ids;
  } catch {
    return [];
  }
}

const server = http.createServer((request, response) => {
  const startedAt = Date.now();
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    const body = Buffer.concat(chunks);
    let action = null;
    try {
      action = JSON.parse(body.toString("utf8"))?.action ?? null;
    } catch {
      // Non-JSON bodies are still forwarded and counted.
    }
    const forward = http.request({
      hostname: upstream.hostname,
      port: upstream.port,
      path: request.url,
      method: request.method,
      headers: { ...request.headers, host: `${upstream.hostname}:${upstream.port}` },
    }, (upstreamResponse) => {
      const responseChunks = [];
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.on("data", (chunk) => {
        responseChunks.push(chunk);
        response.write(chunk);
      });
      upstreamResponse.on("end", () => {
        response.end();
        const text = Buffer.concat(responseChunks).toString("utf8");
        appendFileSync(logPath, JSON.stringify({
          started_at: startedAt,
          ended_at: Date.now(),
          path: request.url?.split("?")[0],
          function: request.url?.split("?")[0].split("/").pop(),
          action,
          status: upstreamResponse.statusCode,
          request_bytes: body.length,
          response_bytes: Buffer.byteLength(text),
          user_agent: request.headers["user-agent"] ?? null,
          delivered: deliveredCommandIds(text),
        }) + "\n");
      });
    });
    forward.on("error", (error) => {
      appendFileSync(logPath, JSON.stringify({
        started_at: startedAt, ended_at: Date.now(), path: request.url, action, status: 599, error: String(error),
      }) + "\n");
      response.writeHead(502, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "upstream unavailable" }));
    });
    forward.end(body);
  });
});
server.keepAliveTimeout = 65_000;
server.headersTimeout = 70_000;
server.requestTimeout = 0;
server.listen(listenPort, bindAddress, () => console.log(`metering ${bindAddress}:${listenPort} -> ${upstream.href}`));
