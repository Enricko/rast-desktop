#!/usr/bin/env node
// Phase 1 functional matrix + measurements for the official native Xpra client.
// See poc/README.md. Runs against the live RAST server with the t-* test
// accounts; never prints or stores credentials/tokens.
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  ApiError, RastApi, TestDisplay, ROOT, sleep, stamp, parseArgs,
  readCreds, execFileP, readProcStat, readProcIo, cgroupCpu, sudoRead,
  summary, writeResults,
} from './lib.mjs';

const args = parseArgs(process.argv.slice(2));
const BASE = args.base || process.env.RAST_BASE_URL || 'https://desktop.lufria.tech';
const USER = args.user || 't-alice';
const MODE = args.mode || 'relay-poc'; // relay-poc | broker
const LABEL = args.label || `${MODE}`;
const XPRA = args.xpra || process.env.XPRA_BIN || 'xpra';
const DISPLAY_NUM = args.display || ':91';
const KEEP = Boolean(args.keep);
const LATENCY_SAMPLES = Number(args.samples || 15);
const OUT = path.join(ROOT, 'poc', 'tmp', `${LABEL}-${stamp()}`);

fs.mkdirSync(OUT, { recursive: true });

const results = {
  label: LABEL, mode: MODE, baseUrl: BASE, user: USER,
  startedAt: new Date().toISOString(), finishedAt: null,
  checks: [], measurements: {}, environment: {},
};
const checks = results.checks;
function record(name, pass, detail) {
  checks.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function redactUrl(url) {
  // never persist a stream token: keep only the shape
  return String(url).replace(/\/linux-apps\/native\/[^/]+/, '/linux-apps/native/<token>');
}

async function waitFor(fn, timeout = 15000, every = 150) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(every);
  }
  return false;
}

let helpCache = null;
async function xpraHelp() {
  if (helpCache !== null) return helpCache;
  try {
    const { stdout, stderr } = await execFileP(XPRA, ['attach', '--help']).catch((e) => ({ stdout: e.stdout || '', stderr: e.stderr || '' }));
    helpCache = `${stdout}\n${stderr}`;
  } catch { helpCache = ''; }
  return helpCache;
}

async function buildAttachArgs(url) {
  const help = await xpraHelp();
  const has = (f) => help.includes(f);
  const a = ['attach', url, '--sharing=yes', '--no-daemon', '--clipboard=yes'];
  if (has('--clipboard-direction')) a.push('--clipboard-direction=both');
  a.push('--audio=yes', '--speaker=on', '--microphone=no');
  a.push(has('--mdns=no') ? '--mdns=no' : '--no-mdns');
  a.push(has('--printing=no') ? '--printing=no' : '--no-printing');
  a.push(has('--webcam=no') ? '--webcam=no' : '--no-webcam');
  if (has('--notifications=no')) a.push('--notifications=no');
  if (has('--av-sync=yes')) a.push('--av-sync=yes');
  if (has('--opengl=')) a.push('--opengl=auto');
  return a;
}

function attachEnv(api) {
  const env = {
    ...process.env,
    DISPLAY: DISPLAY_NUM,
    // RFC6455 masking: the official Xpra client defaults to UNMASKED frames,
    // which a standards-compliant relay must reject. See docs/PROTOCOL.md §5.
    XPRA_WEBSOCKET_MASK: '1',
  };
  if (MODE === 'relay-poc') {
    env.PYTHONPATH = [path.join(ROOT, 'poc', 'xpra_ws_headers'), env.PYTHONPATH].filter(Boolean).join(path.delimiter);
    env.XPRA_POC_ORIGIN = new URL(BASE).origin;
    env.XPRA_POC_COOKIE = api.cookie; // "rast_session=<value>", never printed
  }
  return env;
}

async function spawnAttach(api, url, tag = 'client') {
  const logPath = path.join(OUT, `xpra-${tag}.log`);
  const log = fs.openSync(logPath, 'a');
  const argv = await buildAttachArgs(url);
  results.environment.xpraAttachArgv = argv.map((a, i) => (i === 1 ? redactUrl(a) : a));
  const child = spawn(XPRA, argv, { env: attachEnv(api), stdio: ['ignore', log, log] });
  child.on('error', () => {});
  return { child, logPath, argv };
}

async function waitAttached(logPath, timeout = 45000) {
  let text = '';
  const ok = await waitFor(() => {
    try { text = fs.readFileSync(logPath, 'utf8'); } catch { text = ''; }
    if (/Attached to|running, \d+ window/.test(text)) return true;
    if (/Connection failed|not an xpra server|websocket upgrade failed|Failed to connect/.test(text)) return true;
    return false;
  }, timeout, 250);
  if (/Attached to|running, \d+ window/.test(text)) {
    const line = (text.match(/Attached to[^\n]*|running, \d+ window[^\n]*/) || [''])[0];
    return { attached: true, line };
  }
  const tail = text.split('\n').slice(-15).join('\n');
  return { attached: false, line: tail };
}

async function serverInfo(api, session) {
  const userLinux = 200000 + api.user.id;
  const unit = `rast-xpra-u${api.user.id}`;
  if (!session || session.display == null) return null;
  const socket = `/run/rast-linux/${userLinux}/sockets/lufria-server-${session.display}`;
  try {
    const { stdout } = await execFileP('sudo', ['-n', '-u', `rast-u${api.user.id}`, 'env', `XDG_RUNTIME_DIR=/run/rast-linux/${userLinux}`, 'xpra', 'info', `socket:${socket}`], { timeout: 25000 });
    const entries = {};
    for (const line of stdout.split('\n')) {
      const i = line.indexOf('=');
      if (i > 0) entries[line.slice(0, i)] = line.slice(i + 1);
    }
    const num = (key) => { const v = entries[key]; return v === undefined ? undefined : Number(v); };
    return {
      unit,
      version: entries['server.version'] || entries['build.version'],
      clients: Object.keys(entries).filter((k) => /^client\.\d+\.connection\.active$/.test(k)).length,
      encoder: entries['client.0.connection.encoder'],
      pingLatencyMs: num('client.0.connection.client.ping_latency.cur'),
      batchDelay: num('client.0.batch.delay.cur'),
      audioState: entries['client.0.audio.speaker.state'],
      audioCodec: entries['client.0.audio.speaker.codec'],
      clipboardEnabled: entries['client.0.clipboard.enabled'],
      windowCount: Object.keys(entries).filter((k) => /^window\.\d+\./.test(k)).length,
      encodings: entries['client.0.encoding.enable'] || entries['client.0.encodings'] || entries['encodings'],
      clientCore: entries['client.0.encoding.client-defaults.core'],
      raw: entries,
    };
  } catch (e) {
    return { error: String(e.message || e).slice(0, 200) };
  }
}

async function xclipSet(text) {
  const child = spawn('xclip', ['-selection', 'clipboard'], { env: { ...process.env, DISPLAY: DISPLAY_NUM } });
  child.stdin.end(text);
  await new Promise((r) => child.on('exit', r));
}
async function xclipGet() {
  try {
    const { stdout } = await execFileP('xclip', ['-o', '-selection', 'clipboard'], { env: { ...process.env, DISPLAY: DISPLAY_NUM } });
    return stdout;
  } catch { return null; }
}

async function remoteFile(file) { return sudoRead(file); }

async function main() {
  const creds = readCreds();
  if (!creds[USER]) throw new Error(`no credentials for ${USER}`);
  const api = new RastApi(BASE);
  await api.login(USER, creds[USER]);
  results.user = api.user.username;
  const boot = await api.bootstrap();
  results.environment = {
    node: process.version,
    host: (await execFileP('uname', ['-a'])).stdout.trim(),
    xpraVersion: (await execFileP(XPRA, ['--version']).catch(() => ({ stdout: '' }))).stdout.trim(),
    serverVersion: boot.version,
    serverUrl: BASE,
    timestampUtc: new Date().toISOString(),
  };

  // 1. session + known application inventory
  const disco = await api.discovered();
  let inv = await api.inventory();
  let session = inv.session;
  const findDisc = (name) => (disco.apps || []).find((a) => a.name === name && a.canLaunch);
  const xtermDisc = findDisc('XTerm');
  let launched = null;
  if (!session || !(session.apps || []).some((a) => a.name === 'XTerm' && a.status === 'running')) {
    if (!xtermDisc) throw new Error('XTerm discovered entry not available to this account');
    launched = await api.launchDiscovered(xtermDisc.id);
    session = launched.session;
  }
  record('session ready', Boolean(session && session.status === 'ready'),
    `display=${session.display} backend=${session.displayBackend} apps=${(session.apps || []).map((a) => a.name).join(',')}`);

  const display = new TestDisplay(DISPLAY_NUM);
  await display.start();

  // 2. attach
  let url;
  if (MODE === 'broker') {
    const token = await api.streamToken();
    url = token.url;
    results.measurements.streamToken = { ttlSeconds: token.ttlSeconds, transport: token.transport, expiresAt: token.expiresAt };
  } else {
    if (!session.url) throw new Error('no session websocket url');
    url = `${BASE}${session.url}`;
  }
  let attach = await spawnAttach(api, url, 'client');
  const attachStart = Date.now();
  const attached = await waitAttached(attach.logPath);
  const attachTimeMs = Date.now() - attachStart;
  record('attach', attached.attached, `${attachTimeMs} ms; ${attached.line.slice(0, 200)}`);
  if (!attached.attached) throw new Error('native client did not attach');

  // 3. window appears
  let win = null;
  const gotWindow = await waitFor(async () => {
    win = (await display.appWindows()).find((w) => /xterm/i.test(w.name));
    return Boolean(win);
  }, 25000, 300);
  record('native window', gotWindow, win ? `"${win.name}" ${win.width}x${win.height} at ${win.x},${win.y}` : 'no xterm window on the client display');
  if (!gotWindow) throw new Error('no native window');

  const clientPid = attach.child.pid;
  const state0 = { stat: readProcStat(clientPid), io: readProcIo(clientPid), cgroup: await cgroupCpu(`rast-xpra-u${api.user.id}`), at: Date.now() };
  const ping0 = await serverInfo(api, session);
  results.measurements.negotiation = {
    serverVersion: ping0 && ping0.version, encoder: ping0 && ping0.encoder,
    pingLatencyMs: ping0 && ping0.pingLatencyMs, batchDelay: ping0 && ping0.batchDelay,
    audioState: ping0 && ping0.audioState, audioCodec: ping0 && ping0.audioCodec,
    clipboardEnabled: ping0 && ping0.clipboardEnabled, encodings: ping0 && ping0.coreEncodings || (ping0 && ping0.clientCore),
  };
  record('audio negotiated', Boolean(ping0 && ping0.audioState === 'active'), `state=${ping0 && ping0.audioState} codec=${ping0 && ping0.audioCodec}`);
  record('clipboard negotiated', Boolean(ping0 && ping0.clipboardEnabled === 'True'), `enabled=${ping0 && ping0.clipboardEnabled}`);

  async function focus() {
    await display.xdo(['windowactivate', '--sync', String(win.id)]).catch(() => {});
    await display.xdo(['windowfocus', '--sync', String(win.id)]).catch(() => {});
    await sleep(120);
  }
  async function typeCommand(text) {
    await focus();
    await display.xdo(['type', '--delay', '25', text]);
    await sleep(80);
    await display.xdo(['key', 'Return']);
  }

  // 4. typing
  const typeFile = `/tmp/rast-desktop-poc-typing-${process.pid}`;
  await execFileP('sudo', ['-n', 'rm', '-f', typeFile]).catch(() => {});
  await typeCommand(`echo typed-ok > ${typeFile}`);
  const typed = await waitFor(async () => (await remoteFile(typeFile) || '').includes('typed-ok'), 8000, 100);
  record('typing (client -> remote app)', typed, typeFile);

  // 5. input latency samples
  const latencies = [];
  for (let i = 0; i < LATENCY_SAMPLES; i++) {
    const remote = `/tmp/rast-desktop-poc-lat-${process.pid}-${i}`;
    await display.xdo(['type', '--delay', '0', `date +%s%3N > ${remote}`]).catch(() => {});
    const t0 = Date.now();
    await display.xdo(['key', 'Return']);
    let content = null;
    const ok = await waitFor(async () => { content = await remoteFile(remote); return Boolean(content && /^\d+/.test(content)); }, 4000, 15);
    if (ok) {
      const serverTs = Number((content || '').trim());
      if (Number.isFinite(serverTs)) latencies.push(serverTs - t0);
    }
    await sleep(60);
  }
  results.measurements.inputLatencyMs = summary(latencies);
  record('input latency sampled', latencies.length >= Math.ceil(LATENCY_SAMPLES * 0.6), JSON.stringify(results.measurements.inputLatencyMs));

  // 6. clipboard client -> remote
  await xclipSet(`CLIP-FROM-CLIENT-${process.pid}`);
  const clipOutFile = `/tmp/rast-desktop-poc-clip-out-${process.pid}`;
  await execFileP('sudo', ['-n', 'rm', '-f', clipOutFile]).catch(() => {});
  await typeCommand(`xclip -o -selection clipboard > ${clipOutFile}`);
  const clipOutOk = await waitFor(async () => ((await remoteFile(clipOutFile)) || '').includes(`CLIP-FROM-CLIENT-${process.pid}`), 8000, 100);
  record('clipboard (macOS/client -> remote app)', clipOutOk, clipOutFile);

  // 7. clipboard remote -> client
  await typeCommand(`printf CLIP-FROM-REMOTE-${process.pid} | xclip -selection clipboard`);
  const clipInOk = await waitFor(async () => ((await xclipGet()) || '').includes(`CLIP-FROM-REMOTE-${process.pid}`), 8000, 120);
  record('clipboard (remote app -> macOS/client)', clipInOk, 'client clipboard updated');

  // 8. resize reaches the remote application
  const sizeFile = `/tmp/rast-desktop-poc-size-${process.pid}`;
  await execFileP('sudo', ['-n', 'rm', '-f', sizeFile]).catch(() => {});
  await display.xdo(['windowsize', String(win.id), '980', '610']);
  await sleep(600);
  await typeCommand(`stty size > ${sizeFile}`);
  const sizeOk = await waitFor(async () => Boolean((await remoteFile(sizeFile)) || ''), 8000, 100);
  const sizeText = ((await remoteFile(sizeFile)) || '').trim();
  record('window resize -> remote geometry', sizeOk && sizeText.split(' ').length === 2, `stty size = ${sizeText}`);

  // 9. multiple windows: launch a second application
  const uxDisc = findDisc('UXTerm') || findDisc('QTerminal') || findDisc('Alacritty');
  let secondLaunched = null;
  if (uxDisc) {
    secondLaunched = await api.launchDiscovered(uxDisc.id).catch(() => null);
  }
  const secondOk = secondLaunched ? await waitFor(async () => {
    const wins = await display.appWindows();
    return wins.some((w) => w.id !== win.id && new RegExp(uxDisc.name.replace(/[^a-z0-9]/gi, '.'), 'i').test(w.name));
  }, 20000, 300) : false;
  const secondWin = secondOk ? (await display.appWindows()).find((w) => w.id !== win.id) : null;
  record('multiple independent windows', secondOk, secondOk ? `second window "${secondWin && secondWin.name}" (${uxDisc && uxDisc.name})` : 'second window did not appear');

  // 10. modal/transient dialog
  const dialogFile = `/tmp/rast-desktop-poc-dialog-${process.pid}`;
  await typeCommand(`(zenity --info --title=RASTPOCDIALOG --text=RAST-DESKTOP-POC --timeout=8 >/dev/null 2>&1 &) ; echo started > ${dialogFile}`);
  const dialogOk = await waitFor(async () => (await display.windows()).some((w) => /RASTPOCDIALOG/.test(w.name)), 12000, 250);
  record('transient dialog window', dialogOk, dialogOk ? 'dialog window created by the remote app' : 'no dialog window appeared');

  // 11. minimize / restore
  await display.xdo(['windowminimize', String(win.id)]);
  const minimized = await waitFor(async () => {
    try {
      const { stdout } = await execFileP('xdotool', ['search', '--onlyvisible', '--name', 'xterm'], { env: display.env });
      return !stdout.split('\n').map((s) => s.trim()).filter(Boolean).map(Number).includes(win.id);
    } catch { return true; }
  }, 5000, 150);
  await display.xdo(['windowmap', String(win.id)]).catch(() => {});
  await display.xdo(['windowactivate', '--sync', String(win.id)]).catch(() => {});
  await sleep(400);
  const restoreFile = `/tmp/rast-desktop-poc-restore-${process.pid}`;
  await typeCommand(`echo restored > ${restoreFile}`);
  const restored = await waitFor(async () => ((await remoteFile(restoreFile)) || '').includes('restored'), 8000, 100);
  record('minimize / restore', minimized && restored, `minimized=${minimized} restored+typed=${restored}`);

  // 12. close one window -> only that remote app ends
  const xtermRun = ((session.apps || []).find((a) => a.name === 'XTerm') || {}).runId;
  await display.xdo(['windowclose', String(win.id)]);
  const closed = await waitFor(async () => {
    const s = (await api.session()).session;
    const run = (s.apps || []).find((a) => a.runId === xtermRun);
    return !run || run.status !== 'running';
  }, 15000, 400);
  const afterClose = (await api.session()).session;
  const stillReady = Boolean(afterClose && afterClose.status === 'ready');
  record('close window ends only that application', closed && stillReady,
    `xterm run ${closed ? 'ended' : 'still running'}; session still ${stillReady ? 'ready' : 'gone'}`);

  // 13. idle overhead (5 s, no input)
  const idle0 = { io: readProcIo(clientPid), cgroup: await cgroupCpu(`rast-xpra-u${api.user.id}`), at: Date.now() };
  await sleep(5000);
  const idle1 = { io: readProcIo(clientPid), cgroup: await cgroupCpu(`rast-xpra-u${api.user.id}`), at: Date.now() };
  const idleSecs = (idle1.at - idle0.at) / 1000;
  results.measurements.idle = {
    seconds: idleSecs,
    clientBytes: idle1.io && idle0.io ? idle1.io.rchar + idle1.io.wchar - idle0.io.rchar - idle0.io.wchar : null,
    clientBytesPerSecond: idle1.io && idle0.io ? Math.round((idle1.io.rchar + idle1.io.wchar - idle0.io.rchar - idle0.io.wchar) / idleSecs) : null,
    serverCpuUsec: idle1.cgroup && idle0.cgroup ? idle1.cgroup.usage_usec - idle0.cgroup.usage_usec : null,
  };

  // 14. detach + reconnect restores windows, remote apps survive
  const uxRun = ((secondLaunched && secondLaunched.run) || {}).runId;
  attach.child.kill('SIGTERM');
  await sleep(1500);
  let detachedSession = (await api.session()).session;
  const survived = Boolean(detachedSession && (detachedSession.apps || []).some((a) => a.name !== 'XTerm' && a.status === 'running'));
  record('detach keeps remote applications running', survived,
    `running after detach: ${(detachedSession && detachedSession.apps || []).map((a) => `${a.name}:${a.status}`).join(', ')}`);

  const reconnectStart = Date.now();
  const url2 = MODE === 'broker' ? (await api.streamToken()).url : `${BASE}${(detachedSession && detachedSession.url) || session.url}`;
  attach = await spawnAttach(api, url2, 'client-reconnect');
  const reattached = await waitAttached(attach.logPath);
  const reconnectMs = Date.now() - reconnectStart;
  const restoredWindow = reattached.attached ? await waitFor(async () => {
    return (await display.appWindows()).length >= 1;
  }, 25000, 300) : false;
  results.measurements.reconnect = { reconnectTimeMs: reconnectMs, attached: reattached.attached, windowsRestored: restoredWindow };
  record('reconnect restores windows', reattached.attached && restoredWindow, `${reconnectMs} ms; ${reattached.line.slice(0, 160)}`);

  // 15. measurement totals
  const state1 = { stat: readProcStat(clientPid), io: readProcIo(clientPid), cgroup: await cgroupCpu(`rast-xpra-u${api.user.id}`), at: Date.now() };
  const secs = (state1.at - state0.at) / 1000;
  const hz = 100;
  const cpuTicks = state1.stat && state0.stat ? state1.stat.utime + state1.stat.stime - state0.stat.utime - state0.stat.stime : null;
  results.measurements.clientResources = {
    seconds: secs,
    cpuPercentOfOneCore: cpuTicks === null ? null : Math.round((cpuTicks / hz / secs) * 1000) / 10,
    bytes: state1.io && state0.io ? state1.io.rchar + state1.io.wchar - state0.io.rchar - state0.io.wchar : null,
    bytesPerSecond: state1.io && state0.io ? Math.round((state1.io.rchar + state1.io.wchar - state0.io.rchar - state0.io.wchar) / secs) : null,
  };
  const serverCpu = state1.cgroup && state0.cgroup ? (state1.cgroup.usage_usec - state0.cgroup.usage_usec) / 1e6 : null;
  results.measurements.serverResources = {
    cgroup: `rast-xpra-u${api.user.id}`,
    cpuSecondsDuringPhase: serverCpu,
    cpuPercentOfOneCore: serverCpu === null ? null : Math.round((serverCpu / secs) * 1000) / 10,
  };
  results.measurements.windows = (await display.appWindows()).map((w) => ({ name: w.name, width: w.width, height: w.height }));

  // 16. cleanup: end only the runs this harness launched/closed; keep session alive
  try { if (uxRun) await api.closeRun(uxRun); } catch {}
  if (KEEP) {
    console.log(`keeping native client alive (pid ${attach.child.pid}) on display ${DISPLAY_NUM}; log: ${attach.logPath}`);
  } else {
    try { attach.child.kill('SIGTERM'); } catch {}
  }
  results.finishedAt = new Date().toISOString();
  writeResults(OUT, results);
  console.log(`\nresults: ${path.join(OUT, 'results.md')}`);
  const failed = checks.filter((c) => !c.pass).length;
  console.log(`${checks.length - failed}/${checks.length} checks passed`);
  await api.logout();
  if (!KEEP) await display.stop();
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch(async (error) => {
  console.error('fatal:', error && error.message ? error.message : error);
  results.error = String((error && error.stack) || error).slice(0, 2000);
  results.finishedAt = new Date().toISOString();
  try { writeResults(OUT, results); } catch {}
  process.exitCode = 2;
});
