/**
 * Bridge to the Tauri Rust core.
 *
 * The UI never performs HTTP, never touches cookies/tokens and never renders
 * remote content: everything goes through the commands and events defined in
 * `desktop/UI-CONTRACT.md`. This file is the single adapter between those
 * commands and the rest of the UI.
 *
 * In a plain browser (no Tauri internals — e.g. headless Chromium screenshots
 * or `npm run mock`) an equivalent mock bridge is loaded instead. The mock
 * implements the same event API, so no screen branches on mock vs. real.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { toBridgeError } from "./errors";
import type {
  AppEntry,
  AppsView,
  AuthExpiredEvent,
  Bridge,
  ClientState,
  ConnectionState,
  InventoryChangedEvent,
  LaunchResult,
  LaunchStateEvent,
  LoginResult,
  PrewarmResult,
  RestoreResult,
  ServerInfo,
  Settings,
  StreamStatus,
  Unlisten,
  Versions,
  XpraPathCheck,
} from "./types";

/** Command names from desktop/UI-CONTRACT.md — keep them snake_case. */
const CMD = {
  getClientState: "get_client_state",
  configureServer: "configure_server",
  login: "login",
  restoreSession: "restore_session",
  logout: "logout",
  getVersions: "get_versions",
  checkXpraPath: "check_xpra_path",
  setStartAtLogin: "set_start_at_login",
  listApps: "list_apps",
  appIcons: "app_icons",
  launchApp: "launch_app",
  endApp: "end_app",
  endSession: "end_session",
  detach: "detach",
  prewarmSession: "prewarm_session",
  setFavorite: "set_favorite",
  getSettings: "get_settings",
  saveSettings: "save_settings",
  streamStatus: "stream_status",
  streamLog: "stream_log",
  probeConnection: "probe_connection",
} as const;

/** True when the bundle is running inside the Tauri WebView. */
export function hasTauriInternals(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    throw toBridgeError(error);
  }
}

/**
 * Subscribe to a core event. The Tauri listen() API is async; this wrapper
 * returns a synchronous unlisten function and tolerates event-API failures so
 * the UI degrades to command-only updates instead of crashing.
 */
function subscribe<T>(event: string, handler: (payload: T) => void): Unlisten {
  let unlisten: UnlistenFn | null = null;
  let cancelled = false;
  void listen<T>(event, (e) => handler(e.payload))
    .then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    })
    .catch(() => {
      /* events unavailable — polling/commands still update the UI */
    });
  return () => {
    cancelled = true;
    if (unlisten) {
      unlisten();
      unlisten = null;
    }
  };
}

/** Real adapter: Tauri `invoke` commands + Tauri events. */
export class TauriBridge implements Bridge {
  readonly mode = "tauri" as const;

  getClientState(): Promise<ClientState> {
    return call(CMD.getClientState);
  }

  configureServer(url: string): Promise<ServerInfo> {
    return call(CMD.configureServer, { url });
  }

  login(username: string, password: string, remember: boolean): Promise<LoginResult> {
    return call(CMD.login, { username, password, remember });
  }

  restoreSession(): Promise<RestoreResult> {
    return call(CMD.restoreSession);
  }

  logout(): Promise<void> {
    return call(CMD.logout);
  }

  getVersions(): Promise<Versions> {
    return call(CMD.getVersions);
  }

  checkXpraPath(path: string): Promise<XpraPathCheck> {
    return call(CMD.checkXpraPath, { path });
  }

  setStartAtLogin(enabled: boolean): Promise<{ supported: boolean; enabled: boolean }> {
    return call(CMD.setStartAtLogin, { enabled });
  }

  listApps(refresh?: boolean): Promise<AppsView> {
    return call(CMD.listApps, refresh ? { refresh: true } : undefined);
  }

  appIcons(appIds: string[]): Promise<Record<string, string | null>> {
    return call(CMD.appIcons, { appIds });
  }

  launchApp(appId: string): Promise<LaunchResult> {
    return call(CMD.launchApp, { appId });
  }

  endApp(appId: string): Promise<{ session: import("./types").NativeSession | null }> {
    return call(CMD.endApp, { appId });
  }

  endSession(): Promise<void> {
    return call(CMD.endSession);
  }

  detach(): Promise<void> {
    return call(CMD.detach);
  }

  prewarmSession(): Promise<PrewarmResult> {
    return call(CMD.prewarmSession);
  }

  setFavorite(appId: string, favorite: boolean): Promise<{ favorite: boolean }> {
    return call(CMD.setFavorite, { appId, favorite });
  }

  getSettings(): Promise<Settings> {
    return call(CMD.getSettings);
  }

  saveSettings(settings: Settings): Promise<Settings> {
    return call(CMD.saveSettings, { settings });
  }

  streamStatus(): Promise<StreamStatus> {
    return call(CMD.streamStatus);
  }

  streamLog(limit?: number): Promise<{ lines: string[]; dropped: number }> {
    return call(CMD.streamLog, limit === undefined ? undefined : { limit });
  }

  probeConnection(): Promise<ConnectionState> {
    return call(CMD.probeConnection);
  }

  onLaunchState(cb: (event: LaunchStateEvent) => void): Unlisten {
    return subscribe("launch-state", cb);
  }

  onStreamStatus(cb: (status: StreamStatus) => void): Unlisten {
    return subscribe("stream-status", cb);
  }

  onConnectionState(cb: (connection: ConnectionState) => void): Unlisten {
    return subscribe("connection-state", cb);
  }

  onSessionChanged(cb: (session: import("./types").NativeSession | null) => void): Unlisten {
    return subscribe("session-changed", (event: { session: import("./types").NativeSession | null }) =>
      cb(event.session),
    );
  }

  onInventoryChanged(cb: (event: InventoryChangedEvent) => void): Unlisten {
    return subscribe("inventory-changed", cb);
  }

  onAuthExpired(cb: (event: AuthExpiredEvent) => void): Unlisten {
    return subscribe("auth-expired", cb);
  }
}

/**
 * Pick the bridge implementation.
 *
 * - Inside the Tauri WebView: the real core adapter.
 * - In a plain browser (screenshots, `npm run mock`): the mock bridge, so the
 *   same production bundle is testable on Linux without a Mac or a server.
 *   `VITE_RAST_MOCK=1` forces the mock for harnesses that shim Tauri globals.
 */
export async function createBridge(): Promise<Bridge> {
  const forceMock = import.meta.env.VITE_RAST_MOCK === "1";
  if (hasTauriInternals() && !forceMock) {
    return new TauriBridge();
  }
  const { MockBridge } = await import("./mock");
  return new MockBridge();
}

/** Convenience for the launcher: merge icon payloads into app entries. */
export function applyIcons(
  apps: AppEntry[],
  icons: Record<string, string | null>,
): AppEntry[] {
  return apps.map((app) => {
    const icon = icons[app.id];
    return icon ? { ...app, hasIcon: true, iconUrl: icon } : app;
  });
}
