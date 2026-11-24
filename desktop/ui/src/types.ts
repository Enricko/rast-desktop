/**
 * Shared types for the RAST Desktop launcher UI and its bridge to the Rust core.
 *
 * These mirror `desktop/UI-CONTRACT.md` (owned by the Rust core). The bridge is
 * the only place where the UI talks to the Tauri core; in a plain browser an
 * equivalent mock bridge is used so the exact same built bundle can be
 * exercised in headless Chromium.
 *
 * Rules that the UI must respect (see the contract):
 * - command names/argument keys are snake_case; payload fields camelCase;
 * - a successful command resolves with the payload, failures reject with
 *   `{ code, message, action? }`;
 * - everything network/Keychain/Xpra related happens in the core — the UI never
 *   performs HTTP, never sees cookies/tokens/stream URLs;
 * - nothing in this contract is persisted by the UI (settings/favourites live
 *   in the core).
 */

// ---------------------------------------------------------------------------
// Auth / server
// ---------------------------------------------------------------------------

export type Role = "admin" | "user";

export interface User {
  id: number;
  username: string;
  displayName: string | null;
  role: Role;
  mustChangePassword: boolean;
}

export interface DesktopCapability {
  /** Protocol version, currently 1. */
  protocol: number;
  /** RAST Desktop requires true. */
  streamTokens: boolean;
  minClientVersion: string | null;
}

export interface ServerInfo {
  /** Normalised base URL, HTTPS only, no trailing slash. */
  url: string;
  /** "RAST" */
  product: string;
  /** RAST server version, e.g. "0.18.3". */
  version: string;
  /** null on a server that does not advertise RAST Desktop. */
  desktop: DesktopCapability | null;
  /** desktop.streamTokens === true && client version is new enough. */
  supported: boolean;
  /** Why the server is not supported, user-facing. */
  message: string | null;
}

export type LoginResult = {
  user: User;
  server: ServerInfo;
};

export type RestoreResult = {
  signedIn: boolean;
  user: User | null;
  server: ServerInfo | null;
  reason: string | null;
};

// ---------------------------------------------------------------------------
// Xpra / streaming / connection
// ---------------------------------------------------------------------------

export interface XpraInfo {
  detected: boolean;
  path: string | null;
  version: string | null;
  state: "found" | "missing" | "invalid" | "unknown";
  /** e.g. an install hint or probe failure; safe to display. */
  message: string | null;
  /** `attach` flags the installed Xpra accepts. */
  supportedFlags: string[];
}

export type StreamState =
  | "idle"
  | "connecting"
  | "attached"
  | "reconnecting"
  | "detached"
  | "failed";

export interface StreamStatus {
  state: StreamState;
  attempt: number;
  maxAttempts: number;
  message: string | null;
  xpraVersion: string | null;
  attachedAt: number | null;
  lastExit: { code: number | null; signal: number | null; message: string } | null;
  brokerSupported: boolean;
}

export type ConnectionLevel = "excellent" | "good" | "fair" | "poor" | "offline";

/** Display fallbacks when the core does not supply its honest label. */
export const CONNECTION_LEVEL_LABELS: Record<ConnectionLevel, string> = {
  excellent: "Excellent",
  good: "Good",
  fair: "Fair",
  poor: "Poor",
  offline: "Offline",
};

/**
 * Server-reachability snapshot from the core. This is NOT a video-quality
 * measure — the honest `label`/`basis` fields say so and must be surfaced.
 */
export interface ConnectionState {
  state: ConnectionLevel;
  latencyMs: number | null;
  label: string;
  basis: "https-reachability";
  checkedAt: number;
}

export type LaunchState =
  | "launching"
  | "connecting"
  | "attached"
  | "reconnecting"
  | "detached"
  | "failed";

export const LAUNCH_STATE_LABELS: Record<LaunchState, string> = {
  launching: "Launching…",
  connecting: "Connecting…",
  attached: "Attached",
  reconnecting: "Reconnecting…",
  detached: "Detached",
  failed: "Failed",
};

export type LaunchStateEvent = {
  /** Client key of the app, or null for a session-level transition. */
  appId: string | null;
  sessionId: string | null;
  runId: string | null;
  state: LaunchState;
  message: string | null;
  attempt: number;
};

// ---------------------------------------------------------------------------
// Apps / sessions
// ---------------------------------------------------------------------------

export interface Run {
  runId: string;
  /** Raw RAST server app id (not the client key). */
  appId: string;
  appName: string;
  /** Server run status, e.g. "running". */
  status: string;
  startedAt: number | null;
}

export interface NativeSession {
  /** Always "native" in v1; never a session URL/key. */
  id: string;
  status: "starting" | "ready" | "ended";
  appName: string | null;
  startedAt: number | null;
  displayBackend: string | null;
  profile: string | null;
  /** Always true (seamless Xpra). */
  separateWindows: boolean;
  apps: Run[];
}

export type AppKind = "managed" | "discovered";

export interface AppEntry {
  /** Client key: "managed:<serverId>" or "discovered:<serverId>". Opaque. */
  id: string;
  serverId: string;
  kind: AppKind;
  name: string;
  description: string | null;
  version: string | null;
  /** Group heading; never null. */
  category: string;
  favorite: boolean;
  /** Local recents; epoch milliseconds. */
  lastUsedAt: number | null;
  /** Relative server path — diagnostics only. Render icons from `appIcons()`. */
  iconUrl: string | null;
  hasIcon: boolean;
  launchable: boolean;
  running: boolean;
  run: Run | null;
  /** Server status: "ready", "pending_approval", … */
  status: string | null;
  /** Managed apps only. */
  backend: "native" | "docker" | null;
  /** Non-fatal notes for this app; safe to display. */
  warnings: string[];
}

export interface AppsView {
  apps: AppEntry[];
  session: NativeSession | null;
  fetchedAt: number;
  /** True when served from the last good snapshot (e.g. offline). */
  stale: boolean;
  /** Non-fatal, display in a banner. */
  warnings: string[];
}

export type LaunchResult = {
  /** Non-null: the remote app/session was started. */
  session: NativeSession;
  /** The run for this app, when the server returned it. */
  run: Run | null;
  /** e.g. stream broker unavailable (app still started). */
  warnings: string[];
};

export type PrewarmResult = {
  prewarmed: boolean;
  session: NativeSession | null;
  reason: string | null;
};

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export type QualityProfile = "balanced" | "responsive" | "high";
export type ViewMode = "grid" | "list";

export interface Settings {
  serverUrl: string | null;
  quality: QualityProfile;
  clipboard: boolean;
  audio: boolean;
  /** "" = auto-detect the official macOS Xpra client. */
  xpraPath: string;
  /** Accepted; v1 always detaches the local client on quit. */
  detachOnQuit: boolean;
  /** Accepted; v1 reports startAtLogin.supported = false. */
  startAtLogin: boolean;
  view: ViewMode;
}

export interface XpraPathCheck {
  valid: boolean;
  path: string;
  version: string | null;
  message: string | null;
}

export interface ClientState {
  /** Crate version, e.g. "0.1.0". */
  clientVersion: string;
  platform: "macos" | "linux" | "windows" | "other";
  serverUrl: string | null;
  signedIn: boolean;
  user: User | null;
  server: ServerInfo | null;
  settings: Settings;
  xpra: XpraInfo;
  startAtLogin: { supported: boolean; enabled: boolean };
  credentialStore: "keychain" | "dev-file";
}

export interface Versions {
  client: string;
  server: string | null;
  protocol: number | null;
  xpra: XpraInfo;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type InventoryChangeReason = "launch" | "end-app" | "end-session" | "favorite" | "session";

export interface InventoryChangedEvent {
  reason: InventoryChangeReason;
}

export interface AuthExpiredEvent {
  message: string;
}

export type Unlisten = () => void;

// ---------------------------------------------------------------------------
// Bridge
// ---------------------------------------------------------------------------

/**
 * Everything the launcher UI needs from the Rust core. Implemented by
 * `TauriBridge` (real app) and `MockBridge` (browser preview). The shapes are
 * the contract's raw shapes; no `{ok:true}` wrappers are invented here.
 */
export interface Bridge {
  readonly mode: "tauri" | "mock";

  // Client / auth
  getClientState(): Promise<ClientState>;
  configureServer(url: string): Promise<ServerInfo>;
  login(username: string, password: string, remember: boolean): Promise<LoginResult>;
  restoreSession(): Promise<RestoreResult>;
  logout(): Promise<void>;
  getVersions(): Promise<Versions>;
  checkXpraPath(path: string): Promise<XpraPathCheck>;
  setStartAtLogin(enabled: boolean): Promise<{ supported: boolean; enabled: boolean }>;

  // Applications
  listApps(refresh?: boolean): Promise<AppsView>;
  appIcons(appIds: string[]): Promise<Record<string, string | null>>;
  launchApp(appId: string): Promise<LaunchResult>;
  endApp(appId: string): Promise<{ session: NativeSession | null }>;
  endSession(): Promise<void>;
  detach(): Promise<void>;
  prewarmSession(): Promise<PrewarmResult>;
  setFavorite(appId: string, favorite: boolean): Promise<{ favorite: boolean }>;

  // Settings / diagnostics
  getSettings(): Promise<Settings>;
  saveSettings(settings: Settings): Promise<Settings>;
  streamStatus(): Promise<StreamStatus>;
  streamLog(limit?: number): Promise<{ lines: string[]; dropped: number }>;
  probeConnection(): Promise<ConnectionState>;

  // Events
  onLaunchState(cb: (event: LaunchStateEvent) => void): Unlisten;
  onStreamStatus(cb: (status: StreamStatus) => void): Unlisten;
  onConnectionState(cb: (connection: ConnectionState) => void): Unlisten;
  onSessionChanged(cb: (session: NativeSession | null) => void): Unlisten;
  onInventoryChanged(cb: (event: InventoryChangedEvent) => void): Unlisten;
  onAuthExpired(cb: (event: AuthExpiredEvent) => void): Unlisten;
}
