#!/usr/bin/env node
/**
 * Static server for the built launcher UI (mock mode).
 *
 *   npm run mock            # builds, then serves dist/ on http://127.0.0.1:4173
 *   PORT=8080 npm run mock
 *
 * Add `?state=<scenario>` to preview launcher states; see src/mock.ts.
 * This server is for local preview only — the real app loads dist/ inside Tauri.
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const UI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(UI_ROOT, "dist");
const PORT = Number(process.env.PORT ?? 4173);
const HOST = process.env.HOST ?? "127.0.0.1";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

if (!existsSync(path.join(DIST, "index.html"))) {
  console.error("desktop/ui/dist is missing — run `npm run build` first.");
  process.exit(1);
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? HOST}`);
    const pathname = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
    const filePath = path.normalize(path.join(DIST, pathname));
    if (!filePath.startsWith(DIST + path.sep) && filePath !== DIST) {
      response.writeHead(403).end("Forbidden");
      return;
    }
    const body = await readFile(filePath);
    response.writeHead(200, {
      "content-type": MIME[path.extname(filePath).toLowerCase()] ?? "application/octet-stream",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    response.end(body);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not found");
  }
});

server.listen(PORT, HOST, () => {
  console.log(`RAST Desktop mock UI: http://${HOST}:${PORT}/`);
  console.log("");
  console.log("States: ?state=first-run | login | launcher | list | running | settings | about");
  console.log("        ?state=offline | error | loading | empty | unsupported | xpra-missing | reconnect");
  console.log("");
  console.log("Screenshots (built bundle, headless Chromium): npm run screenshots");
});
