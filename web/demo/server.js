import { createReadStream } from "node:fs";
import { createServer } from "node:http";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../../", import.meta.url));

export function startDemoServer({ dataDir, port = 0, delayMs = 0 } = {}) {
  if (!dataDir) throw new Error("dataDir is required");
  const dist = path.join(repo, "dist");
  const data = path.resolve(dataDir);
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    const base = url.pathname.startsWith("/data/") ? data : dist;
    const relative = url.pathname.startsWith("/data/") ? url.pathname.slice(6) : url.pathname.slice(1);
    const requested = path.resolve(base, relative || "index.html");
    if (requested !== base && !requested.startsWith(base + path.sep)) {
      response.writeHead(403).end();
      return;
    }
    let info;
    try { info = await stat(requested); } catch { response.writeHead(404).end(); return; }
    if (!info.isFile()) { response.writeHead(404).end(); return; }
    const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range || "");
    const start = match ? Number(match[1]) : 0;
    const end = match ? Number(match[2]) : info.size - 1;
    if (start > end || end >= info.size) { response.writeHead(416).end(); return; }
    const mime = requested.endsWith(".html") ? "text/html" : requested.endsWith(".js") ? "text/javascript" : requested.endsWith(".json") ? "application/json" : "application/octet-stream";
    const headers = { "Content-Type": mime, "Content-Length": end - start + 1, "Accept-Ranges": "bytes", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };
    if (match) headers["Content-Range"] = `bytes ${start}-${end}/${info.size}`;
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    response.writeHead(match ? 206 : 200, headers);
    createReadStream(requested, { start, end }).pipe(response);
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
  const server = await startDemoServer({ dataDir: option("--data-dir"), port: Number(option("--port", "8000")), delayMs: Number(option("--delay-ms", "0")) });
  console.log(`Demo: http://127.0.0.1:${server.address().port}/`);
}
