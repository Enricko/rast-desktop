#!/usr/bin/env node
/*
 * html5-compare.cjs — same-runner, same-account, same-network HTML5 streaming
 * measurement used as the Phase 1 baseline for the native Xpra client numbers.
 *
 * It does NOT touch the RAST desktop's own UI implementation: it logs in over
 * the public HTTPS API, makes sure the test user's native session has one
 * running app, and then opens the *existing* HTML5 client page
 * `/linux-apps/session/<key>/` in Chromium (the same browser streaming path a
 * user gets from the RAST web desktop). That page load is the HTML5 path whose
 * first-frame latency is comparable with the native attach latency.
 *
 * Measured:
 *   loginMs             POST /api/auth/login round trip
 *   launchMs            POST /api/linux-apps/{id}/launch round trip
 *   navigateToCanvasMs  page.goto(session page) -> first non-empty <canvas>
 *   firstPaintMs        browser paint timing (if available)
 *   canvasCount, screenshot, console/page errors
 *
 * The app the script launches is closed again in a finally block (only the run
 * this script created); the user's pre-existing session is never ended.
 *
 * Usage:
 *   node html5-compare.cjs --url https://desktop.lufria.tech \
 *        --user t-alice --password ... --out evidence/html5 [--app Alacritty]
 * (Normally called by .github/workflows/native-poc.yml with env RAST_URL,
 *  RAST_USER, RAST_PASSWORD; passwords are never written to the output.)
 */
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
      out[k] = v;
    }
  }
  return out;
}

const args = parseArgs(process.argv);
const URL = (args.url || process.env.RAST_URL || "https://desktop.lufria.tech").replace(/\/+$/, "");
const USER = args.user || process.env.RAST_USER || "";
const PASSWORD = args.password || process.env.RAST_PASSWORD || "";
const OUT = path.resolve(args.out || "evidence/html5");
const APP_PREF = args.app || process.env.PHASE1_APP || "";
const TIMEOUT = Number(args.timeout || 180000);
fs.mkdirSync(OUT, { recursive: true });

const result = {
  status: "failed",
  serverUrl: URL,
  app: null,
  sessionKey: null,
  loginMs: null,
  launchMs: null,
  navigateToCanvasMs: null,
  firstPaintMs: null,
  canvasCount: 0,
  viewport: null,
  screenshots: [],
  consoleErrors: [],
  pageErrors: [],
  requestFailures: [],
  notes: [
    "HTML5 path = opening the existing browser streaming client page " +
      "/linux-apps/session/<key>/ in Chromium on the same runner, same account " +
      "and same network path as the native client test.",
    "The native attach number is measured from process start to the client log's " +
      "attach acknowledgement; the HTML5 number is page navigation to first non-empty canvas. " +
      "They both contain TLS+WebSocket setup and first frame, but the HTML5 path also " +
      "downloads and boots the Xpra HTML5 JavaScript client.",
  ],
  errors: [],
};
const t = () => Date.now();
const write = () => fs.writeFileSync(path.join(OUT, "html5.json"), JSON.stringify(result, null, 2));
process.on("exit", () => {
  try { write(); } catch (_) {}
});

async function main() {
  if (!USER || !PASSWORD) throw new Error("missing --user/--password (or RAST_USER/RAST_PASSWORD)");
  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-gpu-sandbox", "--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist"],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    ignoreHTTPSErrors: false,
  });
  const api = context.request;
  let launchedRunId = null;
  let createdRun = false;
  const page = await context.newPage();
  page.on("console", (m) => { if (m.type() === "error") result.consoleErrors.push(m.text().slice(0, 500)); });
  page.on("pageerror", (e) => result.pageErrors.push(String(e).slice(0, 500)));
  page.on("requestfailed", (r) => result.requestFailures.push(`${r.method()} ${r.url().slice(0, 300)} :: ${r.failure()?.errorText}`));

  try {
    // 1) login over the same HTTPS API the desktop client uses
    let t0 = t();
    const loginResp = await api.post(`${URL}/api/auth/login`, {
      data: { username: USER, password: PASSWORD },
      headers: { "X-RAST-Desktop": "1" },
      timeout: 60000,
    });
    result.loginMs = t() - t0;
    result.loginHttp = loginResp.status();
    if (loginResp.status() !== 200) throw new Error(`login HTTP ${loginResp.status()}`);
    const loginJson = await loginResp.json();
    const csrf = loginJson.csrfToken || "";
    result.user = loginJson.user ? { id: loginJson.user.id, username: loginJson.user.username, role: loginJson.user.role } : null;
    const H = { "X-CSRF-Token": csrf, "X-RAST-Desktop": "1" };

    // 2) find the user's native session (prewarm if none)
    const sess = async () => (await api.get(`${URL}/api/linux-apps/session`, { headers: H, timeout: 60000 })).json();
    let session = await sess();
    if (!session.session) {
      await api.post(`${URL}/api/linux-apps/session/prewarm`, { data: {}, headers: H, timeout: 60000 });
      for (let i = 0; i < 30 && !session.session; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        session = await sess();
      }
    }
    if (!session.session) throw new Error("no native session after prewarm");
    const sessionUrlPath = session.session.url;
    result.sessionKey = sessionUrlPath ? String(sessionUrlPath).replace(/^\/linux-apps\/session\/([^/]+)\/.*$/, "$1") : null;
    if (!sessionUrlPath) throw new Error("native session has no url");

    // 3) launch one lightweight app if the one we want is not already running
    const apps = await (await api.get(`${URL}/api/linux-apps/discovered`, { headers: H, timeout: 60000 })).json();
    const running = new Set((session.session.apps || []).map((a) => a.appId));
    const pickPref = (list) => {
      if (APP_PREF) {
        const exact = list.find((a) => (a.name || "").toLowerCase() === APP_PREF.toLowerCase());
        if (exact) return exact;
      }
      const terminal = list.find((a) => /alacritty|xterm|terminal|kitty|foot/i.test(a.name || ""));
      return terminal || list[0] || null;
    };
    const candidates = (apps.apps || []).filter((a) => a.canLaunch === true && a.status === "ready");
    const chosen = pickPref(candidates.filter((a) => !running.has(a.id))) || pickPref(candidates);
    if (!chosen) throw new Error("no launchable app found in /api/linux-apps/discovered");
    result.app = { id: chosen.id, name: chosen.name, alreadyRunning: running.has(chosen.id) };
    if (!running.has(chosen.id)) {
      t0 = t();
      const launchResp = await api.post(`${URL}/api/linux-apps/${encodeURIComponent(chosen.id)}/launch`, {
        data: {}, headers: H, timeout: 120000,
      });
      result.launchMs = t() - t0;
      result.launchHttp = launchResp.status();
      if (launchResp.ok()) {
        const launchJson = await launchResp.json();
        launchedRunId = launchJson?.run?.runId || null;
        createdRun = !!launchedRunId;
      }
    }

    // 4) open the existing HTML5 streaming page and wait for the first painted canvas
    result.viewport = { width: 1440, height: 900 };
    t0 = t();
    await page.goto(`${URL}${sessionUrlPath}`, { waitUntil: "domcontentloaded", timeout: TIMEOUT });
    result.navigateDomContentLoadedMs = t() - t0;
    try {
      await page.waitForFunction(() => {
        const cs = Array.from(document.querySelectorAll("canvas"));
        return cs.some((c) => c.width > 0 && c.height > 0);
      }, null, { timeout: TIMEOUT, polling: 100 });
      result.navigateToCanvasMs = t() - t0;
    } catch (e) {
      result.errors.push("no non-empty <canvas> appeared: " + String(e).slice(0, 300));
    }
    try {
      result.canvasCount = await page.evaluate(() => Array.from(document.querySelectorAll("canvas")).filter((c) => c.width > 0 && c.height > 0).length);
      result.firstPaintMs = await page.evaluate(() => {
        const p = performance.getEntriesByType("paint").find((e) => e.name === "first-contentful-paint");
        return p ? Math.round(p.startTime) : null;
      });
      result.pageTitle = await page.title();
      result.canvasSizes = await page.evaluate(() => Array.from(document.querySelectorAll("canvas")).map((c) => ({ w: c.width, h: c.height })).slice(0, 8));
    } catch (_) {}
    // let the HTML5 client settle a moment, then screenshot for the record
    await page.waitForTimeout(3000);
    const shot = path.join(OUT, "html5-session.png");
    try { await page.screenshot({ path: shot, fullPage: false }); result.screenshots.push("html5-session.png"); } catch (e) {
      result.errors.push("screenshot failed: " + String(e).slice(0, 200));
    }
    result.status = result.navigateToCanvasMs ? "measured" : "partial";
  } catch (e) {
    result.errors.push(String(e && e.stack ? e.stack : e).slice(0, 1500));
  } finally {
    // close only the run this script started; never end the user's session
    try {
      if (createdRun && launchedRunId) {
        const loginResp = await api.post(`${URL}/api/auth/login`, {
          data: { username: USER, password: PASSWORD }, headers: { "X-RAST-Desktop": "1" }, timeout: 60000,
        });
        const j = loginResp.ok() ? await loginResp.json() : {};
        const csrf = j.csrfToken || "";
        const closeResp = await api.post(
          `${URL}/api/linux-apps/session/runs/${encodeURIComponent(launchedRunId)}/close`,
          { data: {}, headers: { "X-CSRF-Token": csrf, "X-RAST-Desktop": "1" }, timeout: 60000 });
        result.cleanup = { closedRunId: launchedRunId, http: closeResp.status() };
      } else {
        result.cleanup = { closedRunId: null, note: "app was already running; nothing to close" };
      }
      const j2 = await (await api.get(`${URL}/api/auth/me`, { headers: { "X-RAST-Desktop": "1" } })).json().catch(() => ({}));
      const csrf2 = j2.csrfToken || "";
      await api.post(`${URL}/api/auth/logout`, { data: {}, headers: { "X-CSRF-Token": csrf2, "X-RAST-Desktop": "1" }, timeout: 30000 }).catch(() => {});
    } catch (e) {
      result.cleanup = { error: String(e).slice(0, 300) };
    }
    try { await context.close(); } catch (_) {}
    try { await browser.close(); } catch (_) {}
    write();
  }
}

main().then(() => {
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.status === "measured" ? 0 : 1);
}).catch((e) => {
  result.errors.push(String(e).slice(0, 1500));
  write();
  console.error("html5-compare failed:", e);
  process.exit(1);
});
