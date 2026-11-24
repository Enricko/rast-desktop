#!/usr/bin/env node
/**
 * Headless-Chromium screenshot harness for the *built* launcher bundle.
 *
 *   npm run build && npm run screenshots
 *
 * It serves desktop/ui/dist on a loopback port, loads the mock bridge states with
 * `?capture=1` (animations frozen) and writes PNGs to docs/screenshots/:
 *
 *   launcher-first-run-1440x900.png / -1024x700.png
 *   launcher-login-*.png
 *   launcher-grid-*.png
 *   launcher-running-*.png
 *   launcher-settings-*.png
 *
 * Chromium is discovered from CHROME_PATH, the local Playwright cache under
 * ~/.cache/ms-playwright (chromium-<version>/chrome-linux64/chrome) or PATH.
 * No npm dependency is required, so the UI stays dependency-light on Linux.
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readdir, readFile, mkdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const UI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(UI_ROOT, "dist");
const OUT_DIR = path.resolve(UI_ROOT, "../../docs/screenshots");

const SHOTS = [
  { file: "first-run", state: "first-run" },
  { file: "login", state: "login" },
  { file: "grid", state: "launcher" },
  { file: "running", state: "running" },
  { file: "settings", state: "settings" },
];

const SIZES = [
  [1440, 900],
  [1024, 700],
];

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
};

async function findChromium() {
  if (process.env.CHROME_PATH) {
    if (existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
    throw new Error(`CHROME_PATH does not exist: ${process.env.CHROME_PATH}`);
  }

  const cacheRoot = path.join(os.homedir(), ".cache", "ms-playwright");
  if (existsSync(cacheRoot)) {
    const entries = await readdir(cacheRoot, { withFileTypes: true });
    const candidates = entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("chromium-"))
      .map((entry) => entry.name)
      .sort()
      .reverse();
    for (const dir of candidates) {
      for (const sub of ["chrome-linux64", "chrome-linux"]) {
        const candidate = path.join(cacheRoot, dir, sub, "chrome");
        if (existsSync(candidate)) return candidate;
      }
    }
  }

  const pathCandidates = [
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ];
  for (const candidate of pathCandidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    "No Chromium/Chrome binary found. Set CHROME_PATH, or install playwright's chromium cache.",
  );
}

function startStaticServer() {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
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
      });
      response.end(body);
    } catch {
      response.writeHead(404).end("Not found");
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ server, port: typeof address === "object" && address ? address.port : 0 });
    });
  });
}

function run(binary, args, timeoutMs = 90_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Chromium timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(undefined);
      else reject(new Error(`Chromium exited with code ${code}\n${stderr.trim().split("\n").slice(-6).join("\n")}`));
    });
  });
}

async function main() {
  if (!existsSync(path.join(DIST, "index.html"))) {
    console.error("desktop/ui/dist is missing — run `npm run build` first.");
    process.exit(1);
  }
  const chromium = await findChromium();
  console.log(`Chromium: ${chromium}`);
  await mkdir(OUT_DIR, { recursive: true });
  const { server, port } = await startStaticServer();
  const userDataDir = path.join(os.tmpdir(), `rast-desktop-shots-${process.pid}`);
  console.log(`Serving ${path.relative(process.cwd(), DIST) || "dist"} on http://127.0.0.1:${port}/`);

  const failures = [];
  try {
    for (const shot of SHOTS) {
      for (const [width, height] of SIZES) {
        const outFile = path.join(OUT_DIR, `launcher-${shot.file}-${width}x${height}.png`);
        const url = `http://127.0.0.1:${port}/?state=${encodeURIComponent(shot.state)}&capture=1`;
        const args = [
          "--headless=new",
          "--no-sandbox",
          "--disable-gpu",
          "--disable-dev-shm-usage",
          "--hide-scrollbars",
          "--force-device-scale-factor=1",
          "--window-size=" + width + "," + height,
          "--virtual-time-budget=6000",
          "--run-all-compositor-stages-before-draw",
          "--no-first-run",
          "--no-default-browser-check",
          "--disable-extensions",
          "--user-data-dir=" + userDataDir,
          "--screenshot=" + outFile,
          url,
        ];
        try {
          await run(chromium, args);
          const info = await stat(outFile);
          if (info.size < 4096) throw new Error(`screenshot is suspiciously small (${info.size} bytes)`);
          console.log(`  ok ${path.relative(process.cwd(), outFile)} (${Math.round(info.size / 1024)} KiB) ${width}x${height}`);
        } catch (error) {
          failures.push({ outFile, error: error instanceof Error ? error.message : String(error) });
          console.error(`  FAIL ${outFile}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  } finally {
    server.close();
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} screenshot(s) failed.`);
    process.exit(1);
  }
  console.log(`\nWrote ${SHOTS.length * SIZES.length} screenshots to docs/screenshots/launcher-*.png`);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
