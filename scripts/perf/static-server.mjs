// Local static server that mirrors the GitHub Pages behaviour the public site relies on:
// clean URLs (/applications -> applications.html), gzip for text assets, and a
// ten-minute max-age with ETag revalidation. Used only for local measurement.
import { createServer } from "node:http";
import { createReadStream, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { extname, join, normalize, resolve } from "node:path";
import { gzipSync } from "node:zlib";

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".vtt": "text/vtt; charset=utf-8",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};
const compressible = new Set([".html", ".js", ".mjs", ".css", ".json", ".svg", ".txt"]);

export function startStaticServer({ root, port = 0, host = "127.0.0.1" }) {
  const base = resolve(root);
  const gzipCache = new Map();

  function resolvePath(urlPath) {
    let path = decodeURIComponent(urlPath.split("?")[0]);
    if (path.endsWith("/")) path += "index.html";
    let file = normalize(join(base, path));
    if (!file.startsWith(base)) return null;
    try {
      if (statSync(file).isFile()) return file;
    } catch { /* try clean URL */ }
    try {
      if (statSync(`${file}.html`).isFile()) return `${file}.html`;
    } catch { /* not found */ }
    return null;
  }

  const server = createServer((request, response) => {
    const file = resolvePath(request.url ?? "/");
    if (!file) {
      response.writeHead(404, { "Content-Type": "text/plain" });
      response.end("Not found");
      return;
    }
    const stat = statSync(file);
    const extension = extname(file).toLowerCase();
    const etag = `"${stat.size.toString(16)}-${Math.trunc(stat.mtimeMs).toString(16)}"`;
    const headers = {
      "Content-Type": types[extension] ?? "application/octet-stream",
      "Cache-Control": "max-age=600",
      ETag: etag,
      Vary: "Accept-Encoding",
    };
    if (request.headers["if-none-match"] === etag) {
      response.writeHead(304, headers);
      response.end();
      return;
    }
    const acceptsGzip = /\bgzip\b/.test(String(request.headers["accept-encoding"] ?? ""));
    if (compressible.has(extension) && acceptsGzip) {
      let body = gzipCache.get(file);
      if (!body || body.etag !== etag) {
        body = { etag, data: gzipSync(readFileSync(file), { level: 9 }) };
        gzipCache.set(file, body);
      }
      response.writeHead(200, { ...headers, "Content-Encoding": "gzip", "Content-Length": body.data.length });
      response.end(request.method === "HEAD" ? undefined : body.data);
      return;
    }
    if ([".mp4", ".webm"].includes(extension) && request.headers.range) {
      const match = /bytes=(\d*)-(\d*)/.exec(request.headers.range);
      const start = match?.[1] ? Number(match[1]) : 0;
      const end = match?.[2] ? Number(match[2]) : stat.size - 1;
      response.writeHead(206, {
        ...headers,
        "Accept-Ranges": "bytes",
        "Content-Range": `bytes ${start}-${end}/${stat.size}`,
        "Content-Length": end - start + 1,
      });
      createReadStream(file, { start, end }).pipe(response);
      return;
    }
    response.writeHead(200, { ...headers, "Accept-Ranges": "bytes", "Content-Length": stat.size });
    if (request.method === "HEAD") response.end();
    else createReadStream(file).pipe(response);
  });

  return new Promise((resolveServer) => {
    server.listen(port, host, () => {
      const address = server.address();
      resolveServer({
        port: typeof address === "object" && address ? address.port : port,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

export function contentHash(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 12);
}
