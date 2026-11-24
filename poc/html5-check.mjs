#!/usr/bin/env node
// Same-methodology comparison point for Phase 1: the EXISTING HTML5 browser
// client, on the same host/account/network as the native harness.
//
// Measures: attach time (page navigation -> first painted remote window),
// input latency using the identical remote `date +%s%3N` marker method as
// poc/check.mjs, WebSocket bytes (Playwright websocket events) and server
// cgroup CPU (same `rast-xpra-u<id>` unit as the native run).
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  RastApi, ROOT, sleep, stamp, parseArgs, readCreds, execFileP, cgroupCpu, sudoRead, summary, writeResults,
} from './lib.mjs';

const args = parseArgs(process.argv.slice(2));
const BASE = args.base || process.env.RAST_BASE_URL || 'https://desktop.lufria.tech';
const USER = args.user || 't-alice';
const LABEL = args.label || 'linux-html5';
const LATENCY_SAMPLES = Number(args.samples || 15);
const OUT = path.join(ROOT, 'poc', 'tmp', `${LABEL}-${stamp()}`);
fs.mkdirSync(OUT, { recursive: true });

const results = { label: LABEL, mode: 'html5', baseUrl: BASE, user: USER, startedAt: new Date().toISOString(), finishedAt: null, checks: [], measurements: {}, environment: {} };
function record(name, pass, detail) {
  results.checks.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}
async function waitFor(fn, timeout = 15000, every = 150) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await fn()) return true; await sleep(every); }
  return false;
}

// Resolve playwright: env override, the RAST repo's e2e install, or a local install.
function loadPlaywright() {
  const require = createRequire(import.meta.url);
  const candidates = [args.playwright, process.env.POC_PLAYWRIGHT, '/home/lufria/RAST/tests/e2e/node_modules/playwright', 'playwright'].filter(Boolean);
  for (const c of candidates) {
    try { return require(c); } catch {}
  }
  throw new Error('playwright not found; set POC_PLAYWRIGHT or --playwright=<module path>');
}

function chromePath() {
  if (args.chrome || process.env.POC_CHROME) return args.chrome || process.env.POC_CHROME;
  const root = '/home/lufria/.cache/ms-playwright';
  for (const dir of fs.existsSync(root) ? fs.readdirSync(root) : []) {
    for (const sub of ['chrome-linux64/chrome', 'chrome-linux/chrome']) {
      const p = path.join(root, dir, sub);
      if (fs.existsSync(p)) return p;
    }
  }
  return undefined;
}

async function chromiumCpu(marker) {
  // sum utime+stime over every process whose cmdline contains the unique marker
  let ticks = 0; let seen = 0;
  const pids = fs.readdirSync('/proc').filter((p) => /^\d+$/.test(p));
  for (const pid of pids) {
    try {
      const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
      if (!cmd.includes(marker)) continue;
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const close = stat.lastIndexOf(')');
      const fields = stat.slice(close + 2).split(' ');
      ticks += Number(fields[11]) + Number(fields[12]);
      seen += 1;
    } catch {}
  }
  return { ticks, processes: seen };
}

async function main() {
  const { chromium } = loadPlaywright();
  const creds = readCreds();
  const api = new RastApi(BASE);
  await api.login(USER, creds[USER]);
  const boot = await api.bootstrap();
  results.user = api.user.username;
  results.environment = { node: process.version, serverVersion: boot.version, serverUrl: BASE, timestampUtc: new Date().toISOString(), chrome: chromePath(), userAgent: 'chromium+playwright' };

  const disco = await api.discovered();
  let inv = await api.inventory();
  let session = inv.session;
  const findDisc = (name) => (disco.apps || []).find((a) => a.name === name && a.canLaunch);
  const xterm = findDisc('XTerm');
  if (!session || !(session.apps || []).some((a) => a.name === 'XTerm' && a.status === 'running')) {
    if (!xterm) throw new Error('XTerm not available');
    session = (await api.launchDiscovered(xterm.id)).session;
  }
  record('session ready', Boolean(session && session.status === 'ready'), `display=${session.display}`);
  const serverUnit = `rast-xpra-u${api.user.id}`;

  const marker = `poc-html5-${process.pid}`;
  const browser = await chromium.launch({ headless: true, executablePath: chromePath(), args: [`--user-data-dir=/tmp/${marker}`] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addCookies([{ name: 'rast_session', value: api.cookie.replace('rast_session=', ''), domain: new URL(BASE).hostname, path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }]);
  const page = await context.newPage();
  const wsBytes = { received: 0, sent: 0 };
  const wsUrls = [];
  let wsCount = 0;
  page.on('websocket', (ws) => {
    wsCount += 1; wsUrls.push(ws.url());
    try {
      ws.on('framereceived', (f) => { wsBytes.received += (f.payload?.length ?? 0); });
      ws.on('framesent', (f) => { wsBytes.sent += (f.payload?.length ?? 0); });
    } catch {}
  });

  const cg0 = await cgroupCpu(serverUnit);
  const cpu0 = await chromiumCpu(marker);
  const t0 = Date.now();
  await page.goto(`${BASE}${session.url}`, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  const attached = await waitFor(async () => page.evaluate(() => {
    const wins = [...document.querySelectorAll('.window')];
    return wins.some((w) => w.querySelector('canvas') && w.getBoundingClientRect().width > 150);
  }).catch(() => false), 40000, 200);
  const attachTimeMs = Date.now() - t0;
  record('HTML5 attach', attached, `${attachTimeMs} ms, websockets=${wsCount}`);
  await page.screenshot({ path: path.join(OUT, 'html5-window.png') }).catch(() => {});

  // Focus the remote xterm window so keyboard events reach the application.
  const box = await page.evaluate(() => {
    const win = [...document.querySelectorAll('.window')].find((w) => w.querySelector('canvas') && w.getBoundingClientRect().width > 150);
    if (!win) return null;
    const r = win.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + Math.min(80, r.height / 2) };
  });
  if (box) await page.mouse.click(box.x, box.y).catch(() => {});

  const latencies = [];
  for (let i = 0; i < LATENCY_SAMPLES; i++) {
    const remote = `/tmp/${marker}-lat-${i}`;
    await page.keyboard.type(`date +%s%3N > ${remote}`, { delay: 15 }).catch(() => {});
    await sleep(80);
    const t = Date.now();
    await page.keyboard.press('Enter').catch(() => {});
    let content = null;
    const ok = await waitFor(async () => { content = await sudoRead(remote); return Boolean(content && /^\d+/.test(content)); }, 4000, 15);
    if (ok) { const ts = Number((content || '').trim()); if (Number.isFinite(ts)) latencies.push(ts - t); }
    await sleep(60);
  }
  results.measurements.inputLatencyMs = summary(latencies);
  record('HTML5 input latency sampled', latencies.length >= Math.ceil(LATENCY_SAMPLES * 0.6), JSON.stringify(results.measurements.inputLatencyMs));

  await sleep(2000);
  const cpu1 = await chromiumCpu(marker);
  const cg1 = await cgroupCpu(serverUnit);
  const secs = Math.max(1, (Date.now() - t0) / 1000);
  results.measurements.clientResources = {
    seconds: Math.round(secs), processes: cpu1.processes,
    cpuPercentOfOneCore: Math.round(((cpu1.ticks - cpu0.ticks) / 100 / secs) * 1000) / 10,
  };
  results.measurements.serverResources = {
    cgroup: serverUnit,
    cpuSecondsDuringPhase: cg0 && cg1 ? (cg1.usage_usec - cg0.usage_usec) / 1e6 : null,
    cpuPercentOfOneCore: cg0 && cg1 ? Math.round((((cg1.usage_usec - cg0.usage_usec) / 1e6) / secs) * 1000) / 10 : null,
  };
  results.measurements.webSocketBytes = { received: wsBytes.received, sent: wsBytes.sent, perSecondReceived: Math.round(wsBytes.received / secs) };
  results.measurements.windows = await page.evaluate(() => [...document.querySelectorAll('.window')].map((w) => w.textContent.slice(0, 60)).slice(0, 5)).catch(() => []);

  await browser.close();
  results.finishedAt = new Date().toISOString();
  writeResults(OUT, results);
  console.log(`results: ${path.join(OUT, 'results.md')}`);
  const failed = results.checks.filter((c) => !c.pass).length;
  console.log(`${results.checks.length - failed}/${results.checks.length} checks passed`);
  await api.logout();
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error('fatal:', (error && error.message) || error);
  results.error = String((error && error.stack) || error).slice(0, 2000);
  results.finishedAt = new Date().toISOString();
  try { writeResults(OUT, results); } catch {}
  process.exitCode = 2;
});
