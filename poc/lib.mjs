// Shared helpers for the Phase 1 native Xpra proof-of-concept harnesses.
// No dependencies beyond Node 20+ (global fetch, child_process).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const execFileP = promisify(execFile);
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    const m = arg.match(/^--([a-z0-9-]+)(?:=(.*))?$/i);
    if (!m) continue;
    out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
}

export function readCreds(file = '/home/lufria/.config/rast-test/creds') {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const creds = {};
  for (const line of lines) {
    const i = line.indexOf('=');
    if (i > 0) creds[line.slice(0, i)] = line.slice(i + 1);
  }
  return creds;
}

export function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export function summary(values) {
  if (!values.length) return { n: 0 };
  return {
    n: values.length,
    min: Math.min(...values),
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    max: Math.max(...values),
  };
}

export class ApiError extends Error {
  constructor(status, body) {
    super(`HTTP ${status}: ${String(body).slice(0, 300)}`);
    this.status = status;
    this.body = body;
  }
}

/** Authenticated RAST API client (cookie session + CSRF, exactly as docs/PROTOCOL.md §1). */
export class RastApi {
  constructor(baseUrl) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.cookie = null; // "rast_session=<token>"
    this.csrf = null;
    this.user = null;
    this.sessionExpiresAt = null;
  }

  async request(method, urlPath, { body, headers = {} } = {}) {
    const h = { Accept: 'application/json', 'User-Agent': 'RAST-Desktop-PoC/0.1', ...headers };
    if (body !== undefined) h['Content-Type'] = 'application/json';
    if (this.cookie) h.Cookie = this.cookie;
    if (method !== 'GET' && method !== 'HEAD' && this.csrf) h['X-CSRF-Token'] = this.csrf;
    const res = await fetch(`${this.baseUrl}${urlPath}`, {
      method,
      headers: h,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
    });
    const text = await res.text();
    if (res.status === 401) throw new ApiError(401, text);
    if (!res.ok) throw new ApiError(res.status, text);
    try { return JSON.parse(text); } catch { return text; }
  }

  async login(username, password) {
    const res = await fetch(`${this.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const text = await res.text();
    if (!res.ok) throw new ApiError(res.status, text);
    const setCookies = typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : [res.headers.get('set-cookie')].filter(Boolean);
    for (const c of setCookies) {
      const m = c.match(/rast_session=([^;]+)/);
      if (m) this.cookie = `rast_session=${m[1]}`;
    }
    if (!this.cookie) throw new Error('login succeeded but no rast_session cookie was set');
    const data = JSON.parse(text);
    this.csrf = data.csrfToken;
    this.user = data.user;
    this.sessionExpiresAt = data.expiresAt;
    return data;
  }

  me() { return this.request('GET', '/api/auth/me'); }
  bootstrap() { return this.request('GET', '/api/bootstrap'); }
  inventory() { return this.request('GET', '/api/linux-apps'); }
  discovered() { return this.request('GET', '/api/linux-apps/discovered'); }
  session() { return this.request('GET', '/api/linux-apps/session'); }
  launchDiscovered(id) { return this.request('POST', `/api/linux-apps/discovered/${id}/launch`, { body: {} }); }
  launchManaged(id) { return this.request('POST', `/api/linux-apps/${id}/launch`, { body: {} }); }
  closeRun(runId) { return this.request('POST', `/api/linux-apps/session/runs/${runId}/close`, { body: {} }); }
  closeSession() { return this.request('POST', '/api/linux-apps/session/close', { body: {} }); }
  streamToken() { return this.request('POST', '/api/linux-apps/session/stream-token', { body: {} }); }
  revokeStreamTokens() { return this.request('DELETE', '/api/linux-apps/session/stream-tokens'); }
  logout() { return this.request('POST', '/api/auth/logout', { body: {} }).catch(() => {}); }
}

/** X11 test display (Xvfb + openbox) where the native client renders its windows. */
export class TestDisplay {
  constructor(display) {
    this.display = display;
    this.children = [];
  }
  get env() { return { ...process.env, DISPLAY: this.display }; }

  async start() {
    const lock = `/tmp/.X11-unix/X${this.display.replace(':', '')}`;
    try { await execFileP('pkill', ['-f', `Xvfb ${this.display} `]); } catch {}
    await sleep(300);
    try { fs.rmSync(lock, { force: true }); } catch {}
    const xvfb = execFile('Xvfb', [this.display, '-screen', '0', '2560x1440x24', '-nolisten', 'tcp'], { env: this.env });
    xvfb.on('error', () => {});
    this.children.push(xvfb);
    await this.waitFor(() => fs.existsSync(lock), 5000, 100);
    const openbox = execFile('openbox', [], { env: this.env });
    openbox.on('error', () => {});
    this.children.push(openbox);
    await sleep(800);
  }

  async stop() {
    for (const c of this.children) { try { c.kill('SIGTERM'); } catch {} }
    try { await execFileP('pkill', ['-f', `Xvfb ${this.display} `]); } catch {}
  }

  async waitFor(fn, timeout = 10000, every = 100) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await fn()) return true;
      await sleep(every);
    }
    throw new Error('waitFor timeout');
  }

  async xdo(args) {
    const { stdout } = await execFileP('xdotool', args, { env: this.env });
    return stdout.trim();
  }

  async windowIds() {
    try {
      const { stdout } = await execFileP('xdotool', ['search', '--name', '.*'], { env: this.env });
      return stdout.split('\n').map((s) => s.trim()).filter(Boolean).map(Number);
    } catch { return []; }
  }

  async windows() {
    const ids = await this.windowIds();
    const out = [];
    for (const id of ids) {
      try {
        const name = (await execFileP('xdotool', ['getwindowname', String(id)], { env: this.env })).stdout.trim();
        const cls = (await execFileP('xdotool', ['getwindowclassname', String(id)], { env: this.env }).catch(() => ({ stdout: '' }))).stdout.trim();
        const geometry = (await execFileP('xdotool', ['getwindowgeometry', '--shell', String(id)], { env: this.env }).catch(() => ({ stdout: '' }))).stdout.trim();
        const m = Object.fromEntries(geometry.split('\n').map((l) => l.split('=')).filter((p) => p.length === 2));
        out.push({ id, name, class: cls, x: +m.X, y: +m.Y, width: +m.WIDTH, height: +m.HEIGHT });
      } catch {}
    }
    return out;
  }

  /** Real application windows rendered by the native client (xpra helpers excluded). */
  async appWindows() {
    const ignore = /^(|xpra|Xpra.*|Openbox)$/;
    return (await this.windows()).filter((w) => !ignore.test(w.name) && w.width > 40 && w.height > 40);
  }
}

export function readProcStat(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    const fields = stat.slice(close + 2).split(' ');
    // fields[11] = utime, fields[12] = stime (after comm and state, 1-based in proc(5) => indexes 11,12 here)
    return { utime: +fields[11], stime: +fields[12], state: fields[0] };
  } catch { return null; }
}

export function readProcIo(pid) {
  try {
    const text = fs.readFileSync(`/proc/${pid}/io`, 'utf8');
    const m = Object.fromEntries(text.trim().split('\n').map((l) => {
      const i = l.indexOf(':');
      return [l.slice(0, i), Number(l.slice(i + 1).trim())];
    }));
    return { rchar: m.rchar, wchar: m.wchar, readBytes: m.read_bytes, writeBytes: m.write_bytes };
  } catch { return null; }
}

export async function cgroupCpu(unit) {
  try {
    const text = fs.readFileSync(`/sys/fs/cgroup/system.slice/${unit}.service/cpu.stat`, 'utf8');
    const m = Object.fromEntries(text.trim().split('\n').map((l) => l.split(' ')).map(([k, v]) => [k, Number(v)]));
    return m;
  } catch {
    try {
      const { stdout } = await execFileP('sudo', ['-n', 'cat', `/sys/fs/cgroup/system.slice/${unit}.service/cpu.stat`]);
      return Object.fromEntries(stdout.trim().split('\n').map((l) => l.split(' ')).map(([k, v]) => [k, Number(v)]));
    } catch { return null; }
  }
}

export async function sudoRead(file) {
  try {
    const { stdout } = await execFileP('sudo', ['-n', 'cat', file]);
    return stdout;
  } catch { return null; }
}

export function writeResults(outDir, results) {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(results, null, 2));
  const lines = [`# ${results.label}`, '', `- mode: \`${results.mode}\``, `- base URL: ${results.baseUrl}`, `- user: ${results.user}`, `- started: ${results.startedAt}`, `- finished: ${results.finishedAt}`, '', '## Checks', '', '| Check | Result | Detail |', '| --- | --- | --- |'];
  for (const c of results.checks) {
    lines.push(`| ${c.name} | ${c.pass ? 'PASS' : 'FAIL'} | ${String(c.detail ?? '').replace(/\|/g, '\\|').slice(0, 240)} |`);
  }
  lines.push('', '## Measurements', '');
  for (const [key, value] of Object.entries(results.measurements)) {
    lines.push(`### ${key}`, '', '```json', JSON.stringify(value, null, 2), '```', '');
  }
  lines.push('## Environment', '', '```json', JSON.stringify(results.environment, null, 2), '```', '');
  fs.writeFileSync(path.join(outDir, 'results.md'), lines.join('\n'));
}
