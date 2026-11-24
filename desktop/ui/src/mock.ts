/**
 * Browser mock bridge — fixture data and simulated behaviour for developing and
 * screenshot-testing the launcher on Linux without a Mac, a Rust core or a
 * server.
 *
 * This module is only loaded when Tauri internals are absent (plain Chromium /
 * `npm run mock`), so the production macOS bundle uses `TauriBridge` only.
 * Everything here is labelled as demo data in the UI footer; the mock never
 * contacts a network and never stores credentials.
 *
 * Scenarios (`?state=…` in the URL, default `launcher`):
 *   first-run     no server configured (server setup screen)
 *   login         server configured, signed out
 *   launcher      signed in, mixed managed/discovered apps (default)
 *   list          same as launcher but the app list starts in list view
 *   running       signed in with two attached running applications
 *   settings      same as launcher with the settings dialog open
 *   about         same as launcher with the About dialog open
 *   reconnect     running state plus a repeating Xpra reconnect loop
 *   offline       signed in, server unreachable, last inventory shown
 *   error         list_apps fails (error state with retry)
 *   loading       list_apps never resolves (skeleton state)
 *   empty         signed in, no applications on the server
 *   unsupported   server without RAST Desktop capability ("needs newer RAST")
 *   xpra-missing  signed in but Xpra.app not installed (launch fails honestly)
 */

import { BridgeError } from "./errors";
import { fallbackAppIcon } from "./ui/icons";
import type {
  AppEntry,
  AppsView,
  Bridge,
  ClientState,
  ConnectionState,
  InventoryChangedEvent,
  LaunchResult,
  LaunchStateEvent,
  LoginResult,
  NativeSession,
  PrewarmResult,
  RestoreResult,
  Run,
  ServerInfo,
  Settings,
  StreamStatus,
  Unlisten,
  User,
  Versions,
  XpraInfo,
  XpraPathCheck,
  AuthExpiredEvent,
} from "./types";

export type MockScenario =
  | "first-run"
  | "login"
  | "launcher"
  | "running"
  | "list"
  | "settings"
  | "about"
  | "offline"
  | "error"
  | "loading"
  | "empty"
  | "unsupported"
  | "xpra-missing"
  | "reconnect";

const SCENARIOS: readonly MockScenario[] = [
  "first-run",
  "login",
  "launcher",
  "running",
  "list",
  "settings",
  "about",
  "offline",
  "error",
  "loading",
  "empty",
  "unsupported",
  "xpra-missing",
  "reconnect",
];

const CLIENT_VERSION = "0.1.0";
const PROTOCOL_VERSION = 1;
const SERVER_URL = "https://desktop.lufria.tech";
const LEGACY_SERVER_URL = "https://legacy.example.com";

const SERVER: ServerInfo = {
  url: SERVER_URL,
  product: "RAST",
  version: "0.18.3",
  desktop: { protocol: PROTOCOL_VERSION, streamTokens: true, minClientVersion: "0.1.0" },
  supported: true,
  message: null,
};

const UNSUPPORTED_SERVER: ServerInfo = {
  url: LEGACY_SERVER_URL,
  product: "RAST",
  version: "0.17.2",
  desktop: null,
  supported: false,
  message:
    "This RAST server (0.17.2) does not support RAST Desktop yet — it needs the desktop stream-token broker (RAST 0.18.0 or newer).",
};

const XPRA_FOUND: XpraInfo = {
  detected: true,
  path: "/Applications/Xpra.app",
  version: "6.2.1",
  state: "found",
  message: null,
  supportedFlags: [
    "--sharing",
    "--clipboard",
    "--clipboard-direction",
    "--audio",
    "--speaker",
    "--encodings",
    "--quality",
    "--min-quality",
    "--speed",
    "--video-scaling",
    "--av-sync",
    "--opengl",
  ],
};

const XPRA_MISSING: XpraInfo = {
  detected: false,
  path: null,
  version: null,
  state: "missing",
  message:
    "The official Xpra macOS client (Xpra.app) was not found in /Applications. Install it from xpra.org, then restart RAST Desktop.",
  supportedFlags: [],
};

/** Read the scenario from `?state=…`; unknown values fall back to launcher. */
export function readMockScenario(): MockScenario {
  const raw = new URLSearchParams(window.location.search).get("state") ?? "launcher";
  return (SCENARIOS as readonly string[]).includes(raw) ? (raw as MockScenario) : "launcher";
}

// ---------------------------------------------------------------------------
// Icon fixtures (self-authored SVG, encoded as data: URLs like the real core)
// ---------------------------------------------------------------------------

type IconSpec =
  | { kind: "chrome" }
  | { kind: "firefox" }
  | { kind: "cone" }
  | { kind: "letter"; bg: string; fg: string; letter: string }
  | { kind: "code"; bg: string; fg: string }
  | { kind: "terminal"; bg: string; fg: string }
  | { kind: "document"; bg: string; fg: string; accent: string }
  | { kind: "grid"; bg: string; fg: string };

function iconDataUrl(spec: IconSpec): string {
  const wrap = (bg: string, inner: string): string => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" width="96" height="96"><rect width="96" height="96" rx="21" fill="${bg}"/>${inner}</svg>`;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  };

  switch (spec.kind) {
    case "chrome":
      return wrap(
        "#ffffff",
        `<circle cx="48" cy="48" r="27" fill="#4285f4"/>
         <path d="M48 21a27 27 0 0 1 23.4 13.5H48a13.5 13.5 0 0 0-11.7 6.7z" fill="#ea4335"/>
         <path d="M71.4 34.5a27 27 0 0 1 0 27L59.7 42z" fill="#fbbc05"/>
         <path d="M48 75a27 27 0 0 1-23.4-13.5H48a13.5 13.5 0 0 0 23.4-13.5z" fill="#34a853"/>
         <circle cx="48" cy="48" r="12" fill="#ffffff"/>
         <circle cx="48" cy="48" r="9" fill="#4285f4"/>`,
      );
    case "firefox":
      return wrap(
        "#1b2432",
        `<defs><radialGradient id="ff" cx="30%" cy="20%" r="95%"><stop offset="0" stop-color="#ffd24d"/><stop offset="0.55" stop-color="#ff7a1a"/><stop offset="1" stop-color="#b93a12"/></radialGradient></defs>
         <circle cx="48" cy="48" r="27" fill="url(#ff)"/>
         <circle cx="48" cy="54" r="14" fill="#5b21b6" opacity="0.85"/>
         <circle cx="48" cy="54" r="8" fill="#7c3aed" opacity="0.9"/>`,
      );
    case "cone":
      return wrap(
        "#ffffff",
        `<path d="M34 24h28l-6 14H40z" fill="#f97316"/>
         <path d="M40 38h16l9 32H31z" fill="#f97316"/>
         <path d="M31 70h34l-4 10H35z" fill="#c2410c"/>`,
      );
    case "letter":
      return wrap(
        spec.bg,
        `<text x="48" y="62" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="44" font-weight="700" fill="${spec.fg}">${spec.letter}</text>`,
      );
    case "code":
      return wrap(
        spec.bg,
        `<path d="M37 33 24 48l13 15M59 33l13 15-13 15" stroke="${spec.fg}" stroke-width="5.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
         <path d="M52 30 44 66" stroke="${spec.fg}" stroke-width="4.5" stroke-linecap="round"/>`,
      );
    case "terminal":
      return wrap(
        spec.bg,
        `<path d="M30 35l15 13-15 13" stroke="${spec.fg}" stroke-width="5.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
         <path d="M51 61h16" stroke="${spec.fg}" stroke-width="5.5" stroke-linecap="round"/>`,
      );
    case "document":
      return wrap(
        spec.bg,
        `<path d="M33 22h20l11 11v41H33z" fill="${spec.fg}"/>
         <path d="M53 22v11h11" fill="${spec.accent}" opacity="0.5"/>
         <rect x="40" y="42" width="17" height="3.5" rx="1.75" fill="${spec.accent}"/>
         <rect x="40" y="50" width="17" height="3.5" rx="1.75" fill="${spec.accent}"/>
         <rect x="40" y="58" width="11" height="3.5" rx="1.75" fill="${spec.accent}"/>`,
      );
    case "grid":
      return wrap(
        spec.bg,
        `<rect x="25" y="25" width="18" height="18" rx="4" fill="${spec.fg}"/>
         <rect x="53" y="25" width="18" height="18" rx="4" fill="${spec.fg}" opacity="0.55"/>
         <rect x="25" y="53" width="18" height="18" rx="4" fill="${spec.fg}" opacity="0.55"/>
         <rect x="53" y="53" width="18" height="18" rx="4" fill="${spec.fg}"/>`,
      );
  }
}

// ---------------------------------------------------------------------------
// Fixture inventory
// ---------------------------------------------------------------------------

interface FixtureApp {
  serverId: string;
  kind: "managed" | "discovered";
  name: string;
  description: string;
  version: string | null;
  category: string;
  favorite: boolean;
  lastUsedMinutes: number | null;
  backend: "native" | "docker" | null;
  launchable: boolean;
  warnings: string[];
  icon: IconSpec;
}

const FIXTURE_APPS: readonly FixtureApp[] = [
  {
    serverId: "14",
    kind: "managed",
    name: "Chrome",
    description: "Fast, secure web browser.",
    version: "129.0",
    category: "Internet",
    favorite: true,
    lastUsedMinutes: 24,
    backend: "native",
    launchable: true,
    warnings: [],
    icon: { kind: "chrome" },
  },
  {
    serverId: "15",
    kind: "managed",
    name: "Firefox",
    description: "Privacy-focused web browser.",
    version: "130.0",
    category: "Internet",
    favorite: true,
    lastUsedMinutes: 140,
    backend: "native",
    launchable: true,
    warnings: [],
    icon: { kind: "firefox" },
  },
  {
    serverId: "16",
    kind: "managed",
    name: "Thunderbird",
    description: "Email, calendar and contacts.",
    version: "128.0",
    category: "Internet",
    favorite: false,
    lastUsedMinutes: 1500,
    backend: "native",
    launchable: true,
    warnings: [],
    icon: { kind: "letter", bg: "#1d4ed8", fg: "#ffffff", letter: "T" },
  },
  {
    serverId: "21",
    kind: "managed",
    name: "VS Code",
    description: "Code editor and debugger.",
    version: "1.95",
    category: "Development",
    favorite: true,
    lastUsedMinutes: 30,
    backend: "native",
    launchable: true,
    warnings: [],
    icon: { kind: "code", bg: "#1f6feb", fg: "#ffffff" },
  },
  {
    serverId: "3",
    kind: "discovered",
    name: "Terminal",
    description: "Terminal for your session.",
    version: null,
    category: "Development",
    favorite: false,
    lastUsedMinutes: 320,
    backend: null,
    launchable: true,
    warnings: [],
    icon: { kind: "terminal", bg: "#0e1116", fg: "#5eead4" },
  },
  {
    serverId: "22",
    kind: "managed",
    name: "LibreOffice",
    description: "Writer, Calc and Impress.",
    version: "24.8",
    category: "Office",
    favorite: false,
    lastUsedMinutes: 1500,
    backend: "native",
    launchable: true,
    warnings: [],
    icon: { kind: "document", bg: "#15803d", fg: "#ffffff", accent: "#bbf7d0" },
  },
  {
    serverId: "4",
    kind: "discovered",
    name: "WordCraft",
    description: "Focused word processor.",
    version: null,
    category: "Office",
    favorite: false,
    lastUsedMinutes: 4300,
    backend: null,
    launchable: true,
    warnings: [],
    icon: { kind: "letter", bg: "#2563eb", fg: "#ffffff", letter: "W" },
  },
  {
    serverId: "23",
    kind: "managed",
    name: "GIMP",
    description: "Image editor for photos.",
    version: "2.10",
    category: "Graphics",
    favorite: false,
    lastUsedMinutes: null,
    backend: "native",
    launchable: true,
    warnings: [],
    icon: { kind: "letter", bg: "#4b5563", fg: "#e5e7eb", letter: "G" },
  },
  {
    serverId: "24",
    kind: "managed",
    name: "Blender",
    description: "3D modelling and rendering.",
    version: "4.2",
    category: "Graphics",
    favorite: false,
    lastUsedMinutes: 10000,
    backend: "native",
    launchable: true,
    warnings: [],
    icon: { kind: "letter", bg: "#265787", fg: "#f59e0b", letter: "B" },
  },
  {
    serverId: "25",
    kind: "managed",
    name: "VLC",
    description: "Plays every video format.",
    version: "3.0",
    category: "Media",
    favorite: true,
    lastUsedMinutes: 20,
    backend: "native",
    launchable: true,
    warnings: [],
    icon: { kind: "cone" },
  },
  {
    serverId: "5",
    kind: "discovered",
    name: "ArtCraft Launcher",
    description: "Games and tools launcher.",
    version: null,
    category: "Games",
    favorite: false,
    lastUsedMinutes: 2800,
    backend: null,
    launchable: true,
    warnings: [],
    icon: { kind: "letter", bg: "#7c3aed", fg: "#ffffff", letter: "A" },
  },
  {
    serverId: "6",
    kind: "discovered",
    name: "Calculator",
    description: "Quick calculations.",
    version: null,
    category: "Utilities",
    favorite: false,
    lastUsedMinutes: 5900,
    backend: null,
    launchable: true,
    warnings: [],
    icon: { kind: "grid", bg: "#3b4350", fg: "#e2e8f0" },
  },
];

const T_ALICE: User = {
  id: 2,
  username: "t-alice",
  displayName: "Test Alice",
  role: "user",
  mustChangePassword: false,
};

function appEntry(fixture: FixtureApp, now: number): AppEntry {
  const id = `${fixture.kind}:${fixture.serverId}`;
  return {
    id,
    serverId: fixture.serverId,
    kind: fixture.kind,
    name: fixture.name,
    description: fixture.description,
    version: fixture.version,
    category: fixture.category,
    favorite: fixture.favorite,
    lastUsedAt:
      fixture.lastUsedMinutes === null ? null : now - fixture.lastUsedMinutes * 60_000,
    iconUrl: `/api/linux-apps/${fixture.serverId}/icon`,
    hasIcon: true,
    launchable: fixture.launchable,
    running: false,
    run: null,
    status: "ready",
    backend: fixture.backend,
    warnings: [...fixture.warnings],
  };
}

const ICONS: Record<string, string> = Object.fromEntries(
  FIXTURE_APPS.map((fixture) => [`${fixture.kind}:${fixture.serverId}`, iconDataUrl(fixture.icon)]),
);

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

interface MockListeners {
  launch: Set<(event: LaunchStateEvent) => void>;
  stream: Set<(status: StreamStatus) => void>;
  connection: Set<(connection: ConnectionState) => void>;
  session: Set<(session: NativeSession | null) => void>;
  inventory: Set<(event: InventoryChangedEvent) => void>;
  auth: Set<(event: AuthExpiredEvent) => void>;
}

interface MockState {
  scenario: MockScenario;
  serverUrl: string | null;
  server: ServerInfo | null;
  signedIn: boolean;
  user: User | null;
  settings: Settings;
  xpra: XpraInfo;
  startAtLogin: { supported: boolean; enabled: boolean };
  apps: AppEntry[];
  session: NativeSession | null;
  stream: StreamStatus;
  connection: ConnectionState;
  stale: boolean;
  warnings: string[];
}

function cloneSession(session: NativeSession): NativeSession {
  return { ...session, apps: session.apps.map((run) => ({ ...run })) };
}

function makeSession(now: number): NativeSession {
  return {
    id: "native",
    status: "ready",
    appName: "RAST native session",
    startedAt: now - 6 * 60_000,
    displayBackend: "xvfb",
    profile: "balanced",
    separateWindows: true,
    apps: [],
  };
}

function makeRun(app: AppEntry, now: number, seq: number): Run {
  return {
    runId: `run-${app.serverId}-${seq}`,
    appId: app.serverId,
    appName: app.name,
    status: "running",
    startedAt: now - 5 * 60_000,
  };
}

function baseStream(): StreamStatus {
  return {
    state: "idle",
    attempt: 0,
    maxAttempts: 5,
    message: null,
    xpraVersion: null,
    attachedAt: null,
    lastExit: null,
    brokerSupported: true,
  };
}

function excellent(now: number): ConnectionState {
  return {
    state: "excellent",
    latencyMs: 23,
    label: "Server reachability",
    basis: "https-reachability",
    checkedAt: now,
  };
}

function offline(now: number): ConnectionState {
  return {
    state: "offline",
    latencyMs: null,
    label: "Server unreachable",
    basis: "https-reachability",
    checkedAt: now,
  };
}

function createMockState(scenario: MockScenario): MockState {
  const now = Date.now();
  const signedInScenario: MockScenario[] = [
    "launcher",
    "running",
    "list",
    "settings",
    "about",
    "offline",
    "error",
    "loading",
    "empty",
    "xpra-missing",
    "reconnect",
  ];
  const isSignedIn = signedInScenario.includes(scenario);
  const serverUrl = scenario === "first-run" ? null : scenario === "unsupported" ? LEGACY_SERVER_URL : SERVER_URL;

  const settings: Settings = {
    serverUrl,
    quality: "balanced",
    clipboard: true,
    audio: true,
    xpraPath: "",
    detachOnQuit: true,
    startAtLogin: false,
    view: scenario === "list" ? "list" : "grid",
  };

  const xpra = scenario === "xpra-missing" ? { ...XPRA_MISSING } : { ...XPRA_FOUND };
  const apps = scenario === "empty" ? [] : FIXTURE_APPS.map((fixture) => appEntry(fixture, now));
  const session = scenario === "running" || scenario === "reconnect" ? makeSession(now) : null;

  let stream = baseStream();
  if (session) {
    const byId = new Map(apps.map((app) => [app.id, app]));
    const chrome = byId.get("managed:14");
    const vscode = byId.get("managed:21");
    if (chrome) session.apps.push(makeRun(chrome, now, 1));
    if (vscode) session.apps.push(makeRun(vscode, now, 2));
    stream = {
      ...baseStream(),
      state: "attached",
      attempt: 1,
      xpraVersion: "6.2.1",
      attachedAt: now - 5 * 60_000,
    };
  }
  if (scenario === "xpra-missing") {
    stream = {
      ...baseStream(),
      state: "failed",
      attempt: 1,
      message: XPRA_MISSING.message,
      brokerSupported: true,
    };
  }

  return {
    scenario,
    serverUrl,
    server:
      scenario === "unsupported"
        ? { ...UNSUPPORTED_SERVER }
        : signedInScenario.includes(scenario) || scenario === "login"
          ? { ...SERVER, url: SERVER_URL }
          : null,
    signedIn: isSignedIn,
    user: isSignedIn ? { ...T_ALICE } : null,
    settings,
    xpra,
    startAtLogin: { supported: false, enabled: false },
    apps,
    session,
    stream,
    connection: scenario === "offline" || scenario === "error" ? offline(now) : excellent(now),
    stale: scenario === "offline",
    warnings:
      scenario === "offline"
        ? ["Showing the last known application list — the server is unreachable."]
        : [],
  };
}

// ---------------------------------------------------------------------------
// Mock bridge
// ---------------------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export class MockBridge implements Bridge {
  readonly mode = "mock" as const;

  private readonly state: MockState;
  private readonly listeners: MockListeners = {
    launch: new Set(),
    stream: new Set(),
    connection: new Set(),
    session: new Set(),
    inventory: new Set(),
    auth: new Set(),
  };
  private timers: number[] = [];
  private seq = 0;

  constructor() {
    this.state = createMockState(readMockScenario());
    if (this.state.scenario === "reconnect") {
      this.schedule(() => this.reconnectCycle(), 5000);
    }
  }

  // -- Client / auth --------------------------------------------------------

  async getClientState(): Promise<ClientState> {
    await delay(30);
    return {
      clientVersion: CLIENT_VERSION,
      platform: "macos",
      serverUrl: this.state.serverUrl,
      signedIn: this.state.signedIn,
      user: this.state.user ? { ...this.state.user } : null,
      server: this.state.server ? { ...this.state.server } : null,
      settings: { ...this.state.settings },
      xpra: { ...this.state.xpra, supportedFlags: [...this.state.xpra.supportedFlags] },
      startAtLogin: { ...this.state.startAtLogin },
      credentialStore: "keychain",
    };
  }

  async configureServer(url: string): Promise<ServerInfo> {
    await delay(420);
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new BridgeError("invalid_url", "That doesn't look like a valid URL.");
    }
    const devLoopback =
      parsed.protocol === "http:" && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1");
    if (parsed.protocol !== "https:" && !devLoopback) {
      throw new BridgeError("invalid_url", "HTTPS is required. Use an https:// URL.");
    }
    const normalised = `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
    if (normalised.includes("legacy.example.com")) {
      throw new BridgeError(
        "unsupported_server",
        UNSUPPORTED_SERVER.message ?? "This RAST server does not support RAST Desktop yet.",
      );
    }
    const server: ServerInfo = { ...SERVER, url: normalised };
    this.state.serverUrl = normalised;
    this.state.server = server;
    this.state.signedIn = false;
    this.state.user = null;
    this.state.settings = { ...this.state.settings, serverUrl: normalised };
    return { ...server };
  }

  async login(username: string, password: string, remember: boolean): Promise<LoginResult> {
    await delay(460);
    void remember;
    if (!this.state.server) {
      throw new BridgeError("invalid_input", "Configure a server before signing in.");
    }
    if (!this.state.server.supported) {
      throw new BridgeError(
        "unsupported_server",
        this.state.server.message ?? "This RAST server does not support RAST Desktop yet.",
      );
    }
    if (!username.trim()) throw new BridgeError("invalid_input", "Enter your username.");
    if (!password) throw new BridgeError("invalid_input", "Enter your password.");
    if (username.trim() === "rate-limited") {
      throw new BridgeError("rate_limited", "Too many sign-in attempts. Wait a minute and try again.");
    }
    if (password === "change-me") {
      throw new BridgeError(
        "password_change_required",
        "This account must change its password in the RAST web interface before signing in here.",
      );
    }
    if (password === "offline" || username.trim() === "offline") {
      throw new BridgeError("network", "Couldn't reach the server. Check your connection.");
    }
    if (password.length < 4 || username.trim() === "unknown") {
      throw new BridgeError("unauthorized", "Incorrect username or password.");
    }
    const clean = username.trim();
    const user: User = {
      id: clean === "t-alice" ? 2 : 7,
      username: clean,
      displayName: clean === "t-alice" ? "Test Alice" : clean,
      role: clean.startsWith("t-admin") ? "admin" : "user",
      mustChangePassword: false,
    };
    this.state.signedIn = true;
    this.state.user = user;
    this.state.connection = excellent(Date.now());
    return { user: { ...user }, server: { ...this.state.server } };
  }

  async restoreSession(): Promise<RestoreResult> {
    await delay(140);
    if (this.state.signedIn && this.state.user) {
      return {
        signedIn: true,
        user: { ...this.state.user },
        server: this.state.server ? { ...this.state.server } : null,
        reason: null,
      };
    }
    return {
      signedIn: false,
      user: null,
      server: this.state.server ? { ...this.state.server } : null,
      reason: null,
    };
  }

  async logout(): Promise<void> {
    await delay(120);
    this.state.signedIn = false;
    this.state.user = null;
    this.state.session = null;
    this.state.stream = { ...this.state.stream, state: "idle", attachedAt: null };
  }

  async getVersions(): Promise<Versions> {
    await delay(40);
    return {
      client: CLIENT_VERSION,
      server: this.state.server?.version ?? null,
      protocol: PROTOCOL_VERSION,
      xpra: { ...this.state.xpra, supportedFlags: [...this.state.xpra.supportedFlags] },
    };
  }

  async checkXpraPath(path: string): Promise<XpraPathCheck> {
    await delay(320);
    const trimmed = path.trim();
    if (!trimmed) {
      return {
        valid: false,
        path: trimmed,
        version: null,
        message: "Leave this empty to auto-detect Xpra.app in /Applications.",
      };
    }
    if (/xpra/i.test(trimmed) && /\.app\/?$/.test(trimmed)) {
      return { valid: true, path: trimmed, version: "6.2.1", message: null };
    }
    return {
      valid: false,
      path: trimmed,
      version: null,
      message: "No Xpra client found at that path. Point it at the Xpra.app bundle.",
    };
  }

  async setStartAtLogin(enabled: boolean): Promise<{ supported: boolean; enabled: boolean }> {
    await delay(60);
    void enabled;
    return { supported: false, enabled: false };
  }

  // -- Applications ---------------------------------------------------------

  async listApps(refresh?: boolean): Promise<AppsView> {
    if (this.state.scenario === "loading") {
      // Never resolves: exercises the loading skeleton indefinitely.
      return new Promise<AppsView>(() => {});
    }
    await delay(refresh ? 60 : 120);
    if (this.state.scenario === "error") {
      throw new BridgeError("network", "Couldn't reach desktop.lufria.tech. Check your connection.");
    }
    const now = Date.now();
    const session = this.state.session ? cloneSession(this.state.session) : null;
    const runsByApp = new Map<string, Run>();
    for (const run of session?.apps ?? []) runsByApp.set(run.appId, run);
    const apps: AppEntry[] = this.state.apps.map((app) => {
      const run = runsByApp.get(app.serverId) ?? null;
      return { ...app, run, running: run !== null, warnings: [...app.warnings] };
    });
    return {
      apps,
      session,
      fetchedAt: now,
      stale: this.state.stale,
      warnings: [...this.state.warnings],
    };
  }

  async appIcons(appIds: string[]): Promise<Record<string, string | null>> {
    await delay(40);
    const result: Record<string, string | null> = {};
    for (const id of appIds) {
      result[id] = ICONS[id] ?? fallbackAppIcon(id.split(":").pop() ?? id);
    }
    return result;
  }

  async launchApp(appId: string): Promise<LaunchResult> {
    await delay(160);
    const app = this.state.apps.find((candidate) => candidate.id === appId);
    if (!app) throw new BridgeError("not_found", "That application is no longer in the inventory.");
    if (!app.launchable) {
      throw new BridgeError(
        "unsupported",
        app.warnings[0] ?? "This application cannot be launched from RAST Desktop.",
      );
    }

    if (!this.state.session) {
      this.state.session = makeSession(Date.now());
      this.emitSession(this.state.session);
    }
    const session = this.state.session;
    const existing = session.apps.find((run) => run.appId === app.serverId);

    if (existing && this.state.stream.state !== "detached" && this.state.stream.state !== "failed") {
      return { session: cloneSession(session), run: { ...existing }, warnings: [] };
    }

    let run = existing ?? null;
    if (!run) {
      this.seq += 1;
      run = makeRun(app, Date.now(), this.seq);
      session.apps.push(run);
      this.emitInventory("launch");
      this.emitSession(session);
    }

    const warnings: string[] = [];
    this.emitLaunch({
      appId,
      sessionId: session.id,
      runId: run.runId,
      state: "launching",
      message: null,
      attempt: 0,
    });
    this.setStream({
      ...this.state.stream,
      state: "connecting",
      attempt: 1,
      message: "Starting native Xpra client…",
      brokerSupported: true,
    });

    this.schedule(() => {
      if (this.state.xpra.state !== "found") {
        const message =
          this.state.xpra.message ??
          "Xpra.app was not found. Install the official client from xpra.org, then retry.";
        this.setStream({
          ...this.state.stream,
          state: "failed",
          message,
          xpraVersion: null,
        });
        this.emitLaunch({
          appId,
          sessionId: session.id,
          runId: run?.runId ?? null,
          state: "failed",
          message,
          attempt: 0,
        });
        return;
      }
      this.setStream({
        ...this.state.stream,
        state: "attached",
        xpraVersion: "6.2.1",
        attachedAt: Date.now(),
        message: null,
      });
      this.emitLaunch({
        appId,
        sessionId: session.id,
        runId: run?.runId ?? null,
        state: "attached",
        message: null,
        attempt: 1,
      });
    }, 1500);

    if (this.state.xpra.state !== "found" && this.state.xpra.message) {
      warnings.push(this.state.xpra.message);
    }
    return {
      session: cloneSession(session),
      run: run ? { ...run } : null,
      warnings,
    };
  }

  async endApp(appId: string): Promise<{ session: NativeSession | null }> {
    await delay(220);
    const app = this.state.apps.find((candidate) => candidate.id === appId);
    if (!app) throw new BridgeError("not_found", "That application is no longer in the inventory.");
    const session = this.state.session;
    const run = session?.apps.find((candidate) => candidate.appId === app.serverId);
    if (!session || !run) throw new BridgeError("no_run", `${app.name} is not running.`);
    session.apps = session.apps.filter((candidate) => candidate.runId !== run.runId);
    if (session.apps.length === 0) {
      this.state.stream = { ...this.state.stream, state: "detached", attachedAt: null };
      this.emitStream(this.state.stream);
    }
    this.emitInventory("end-app");
    this.emitSession(session);
    return { session: cloneSession(session) };
  }

  async endSession(): Promise<void> {
    await delay(260);
    this.state.session = null;
    this.state.stream = {
      ...this.state.stream,
      state: "detached",
      attachedAt: null,
      message: null,
    };
    this.emitInventory("end-session");
    this.emitSession(null);
    this.emitStream(this.state.stream);
  }

  async detach(): Promise<void> {
    await delay(180);
    this.state.stream = {
      ...this.state.stream,
      state: "detached",
      attachedAt: null,
      message: "Native windows were closed locally; remote applications keep running.",
    };
    this.emitStream(this.state.stream);
  }

  async prewarmSession(): Promise<PrewarmResult> {
    await delay(240);
    if (!this.state.session) {
      this.state.session = makeSession(Date.now());
      this.emitSession(this.state.session);
    }
    return { prewarmed: true, session: cloneSession(this.state.session), reason: null };
  }

  async setFavorite(appId: string, favorite: boolean): Promise<{ favorite: boolean }> {
    await delay(80);
    const app = this.state.apps.find((candidate) => candidate.id === appId);
    if (!app) throw new BridgeError("not_found", "That application is no longer in the inventory.");
    app.favorite = favorite;
    this.emitInventory("favorite");
    return { favorite };
  }

  // -- Settings / diagnostics ----------------------------------------------

  async getSettings(): Promise<Settings> {
    await delay(50);
    return { ...this.state.settings };
  }

  async saveSettings(settings: Settings): Promise<Settings> {
    await delay(220);
    const allowedQuality: Settings["quality"][] = ["balanced", "responsive", "high"];
    if (!allowedQuality.includes(settings.quality)) {
      throw new BridgeError("invalid_input", "Unknown quality profile.");
    }
    this.state.settings = { ...settings };
    return { ...this.state.settings };
  }

  async streamStatus(): Promise<StreamStatus> {
    await delay(40);
    return { ...this.state.stream, lastExit: this.state.stream.lastExit ? { ...this.state.stream.lastExit } : null };
  }

  async streamLog(limit?: number): Promise<{ lines: string[]; dropped: number }> {
    await delay(40);
    const lines = [
      "xpra attach wss://«redacted» --sharing=yes --clipboard=yes --audio=yes",
      "xpra: using encodings h264, vp9, rgb",
      "xpra: connected to «redacted»",
      "xpra: seamless mode enabled",
      "xpra: client attached (mock fixture, no process was spawned)",
    ];
    return { lines: limit ? lines.slice(-limit) : lines, dropped: 0 };
  }

  async probeConnection(): Promise<ConnectionState> {
    await delay(120);
    this.state.connection = { ...this.state.connection, checkedAt: Date.now() };
    return { ...this.state.connection };
  }

  // -- Events ---------------------------------------------------------------

  onLaunchState(cb: (event: LaunchStateEvent) => void): Unlisten {
    this.listeners.launch.add(cb);
    return () => this.listeners.launch.delete(cb);
  }

  onStreamStatus(cb: (status: StreamStatus) => void): Unlisten {
    this.listeners.stream.add(cb);
    return () => this.listeners.stream.delete(cb);
  }

  onConnectionState(cb: (connection: ConnectionState) => void): Unlisten {
    this.listeners.connection.add(cb);
    return () => this.listeners.connection.delete(cb);
  }

  onSessionChanged(cb: (session: NativeSession | null) => void): Unlisten {
    this.listeners.session.add(cb);
    return () => this.listeners.session.delete(cb);
  }

  onInventoryChanged(cb: (event: InventoryChangedEvent) => void): Unlisten {
    this.listeners.inventory.add(cb);
    return () => this.listeners.inventory.delete(cb);
  }

  onAuthExpired(cb: (event: AuthExpiredEvent) => void): Unlisten {
    this.listeners.auth.add(cb);
    return () => this.listeners.auth.delete(cb);
  }

  // -- Internals ------------------------------------------------------------

  private emitLaunch(event: LaunchStateEvent): void {
    for (const cb of this.listeners.launch) cb(event);
  }

  private emitStream(status: StreamStatus): void {
    for (const cb of this.listeners.stream) cb({ ...status });
  }

  private emitSession(session: NativeSession | null): void {
    for (const cb of this.listeners.session) cb(session ? cloneSession(session) : null);
  }

  private emitInventory(reason: InventoryChangedEvent["reason"]): void {
    for (const cb of this.listeners.inventory) cb({ reason });
  }

  private setStream(status: StreamStatus): void {
    this.state.stream = status;
    this.emitStream(status);
  }

  private schedule(fn: () => void, ms: number): void {
    this.timers.push(window.setTimeout(fn, ms));
  }

  /** Repeating reconnect loop for the `reconnect` scenario. */
  private reconnectCycle(): void {
    const app = this.state.apps.find((candidate) => this.state.session?.apps.some((run) => run.appId === candidate.serverId));
    if (!app) return;
    const run = this.state.session?.apps.find((candidate) => candidate.appId === app.serverId);
    const message = "Xpra client exited unexpectedly; reconnecting with a fresh single-use token.";
    this.setStream({
      ...this.state.stream,
      state: "reconnecting",
      attempt: 2,
      message,
      attachedAt: null,
      lastExit: { code: 1, signal: null, message: "mock xpra exit" },
    });
    this.emitLaunch({
      appId: app.id,
      sessionId: this.state.session?.id ?? null,
      runId: run?.runId ?? null,
      state: "reconnecting",
      message,
      attempt: 2,
    });
    this.schedule(() => {
      this.setStream({ ...this.state.stream, state: "connecting", attempt: 3, message: "Obtaining a fresh stream token…" });
      this.schedule(() => {
        this.setStream({
          ...this.state.stream,
          state: "attached",
          attempt: 3,
          message: null,
          attachedAt: Date.now(),
          lastExit: null,
        });
        this.emitLaunch({
          appId: app.id,
          sessionId: this.state.session?.id ?? null,
          runId: run?.runId ?? null,
          state: "attached",
          message: null,
          attempt: 3,
        });
        this.schedule(() => this.reconnectCycle(), 6000);
      }, 1600);
    }, 1800);
  }
}
