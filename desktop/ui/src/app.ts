/**
 * Application shell: boot → first-run → login → launcher, plus overlays
 * (settings, About) and the software-level auth-expiry handling.
 *
 * Screens are plain functions building DOM; this class owns the shared state
 * (the last `ClientState` from the core) and the screen transitions.
 */

import { toBridgeError } from "./errors";
import type {
  Bridge,
  ClientState,
  LoginResult,
  ServerInfo,
  Settings,
  Unlisten,
} from "./types";
import { h, replace } from "./ui/dom";
import { hostFromUrl } from "./ui/format";
import { logoMark } from "./ui/icons";
import { toast } from "./ui/toast";
import { renderFirstRun, type FirstRunOptions } from "./screens/first-run";
import { renderLogin } from "./screens/login";
import { Launcher } from "./screens/launcher";
import { openAboutDialog } from "./screens/about";
import { openSettingsDialog } from "./screens/settings";

export interface AppContext {
  readonly bridge: Bridge;
  /** Current core state; throws if called before boot completed. */
  getClient(): ClientState;
  getClientOrNull(): ClientState | null;
  refreshClient(): Promise<ClientState>;
  updateSettings(settings: Settings): void;
  handleServerConfigured(server: ServerInfo): Promise<void>;
  handleSignedIn(result: LoginResult): Promise<void>;
  showFirstRun(options?: FirstRunOptions): void;
  backFromServerSetup(): void;
  showLogin(notice?: string | null): void;
  showLauncher(): Promise<void>;
  openSettings(): void;
  openAbout(): void;
  signOut(): Promise<void>;
  beginServerChange(): void;
}

export class App implements AppContext {
  private client: ClientState | null = null;
  private launcher: Launcher | null = null;
  private unlistenAuth: Unlisten | null = null;
  private mockOverlayOpened = false;

  constructor(
    private readonly root: HTMLElement,
    readonly bridge: Bridge,
  ) {}

  async start(): Promise<void> {
    this.renderBoot();
    try {
      this.client = await this.bridge.getClientState();
    } catch (error) {
      this.renderFatal(toBridgeError(error).message);
      return;
    }
    if (!this.unlistenAuth) {
      this.unlistenAuth = this.bridge.onAuthExpired((event) => {
        void this.handleAuthExpired(event.message);
      });
    }
    await this.route();
  }

  // -- AppContext -----------------------------------------------------------

  getClient(): ClientState {
    if (!this.client) throw new Error("Client state requested before boot completed");
    return this.client;
  }

  getClientOrNull(): ClientState | null {
    return this.client;
  }

  async refreshClient(): Promise<ClientState> {
    const client = await this.bridge.getClientState();
    this.client = client;
    return client;
  }

  updateSettings(settings: Settings): void {
    if (this.client) this.client = { ...this.client, settings };
  }

  async handleServerConfigured(server: ServerInfo): Promise<void> {
    try {
      await this.refreshClient();
    } catch {
      /* the transition to login only needs the server info we already have */
    }
    toast(`Connected to RAST ${server.version}.`, "success");
    this.showLogin(`Connected to ${hostFromUrl(server.url)} — sign in to continue.`);
  }

  async handleSignedIn(result: LoginResult): Promise<void> {
    if (this.client) {
      this.client = { ...this.client, signedIn: true, user: result.user, server: result.server };
    }
    toast(`Signed in as ${result.user.displayName ?? result.user.username}.`, "success");
    await this.showLauncher();
  }

  showFirstRun(options: FirstRunOptions = {}): void {
    this.launcher?.destroy();
    this.launcher = null;
    replace(this.root, renderFirstRun(this, options));
  }

  backFromServerSetup(): void {
    if (this.client?.signedIn) {
      void this.showLauncher();
    } else {
      this.showLogin(null);
    }
  }

  showLogin(notice?: string | null): void {
    this.launcher?.destroy();
    this.launcher = null;
    replace(this.root, renderLogin(this, notice ?? null));
  }

  async showLauncher(): Promise<void> {
    let client: ClientState;
    try {
      client = await this.refreshClient();
    } catch (error) {
      toast("Couldn't load RAST Desktop state.", "error", toBridgeError(error).message);
      this.showLogin(null);
      return;
    }
    if (!client.signedIn) {
      this.showLogin("Your session ended. Sign in again.");
      return;
    }
    this.launcher?.destroy();
    const launcher = new Launcher(this, client);
    this.launcher = launcher;
    replace(this.root, launcher.element);
    await launcher.start();
    if (this.bridge.mode === "mock" && !this.mockOverlayOpened) {
      this.mockOverlayOpened = true;
      const state = new URLSearchParams(window.location.search).get("state");
      if (state === "settings") this.openSettings();
      else if (state === "about") this.openAbout();
    }
  }

  openSettings(): void {
    if (!this.client) return;
    openSettingsDialog(this);
  }

  openAbout(): void {
    if (!this.client) return;
    openAboutDialog(this);
  }

  async signOut(): Promise<void> {
    this.launcher?.destroy();
    this.launcher = null;
    try {
      await this.bridge.logout();
    } catch (error) {
      toast("Sign-out had a problem.", "warning", toBridgeError(error).message);
    }
    try {
      await this.refreshClient();
    } catch {
      /* still show the login screen */
    }
    this.showLogin("Signed out.");
  }

  beginServerChange(): void {
    const current = this.client?.serverUrl ?? "";
    this.showFirstRun({ prefill: current, cancelable: true });
  }

  // -- Boot routing ---------------------------------------------------------

  private async route(): Promise<void> {
    const client = this.client;
    if (!client) return;

    if (!client.serverUrl) {
      this.showFirstRun();
      return;
    }

    // A previously configured server may not support RAST Desktop (e.g. after a
    // server rollback). Show the setup screen with the honest server message.
    if (client.server && !client.server.supported) {
      this.showFirstRun({
        prefill: client.serverUrl,
        notice: client.server.message ?? "This RAST server does not support RAST Desktop yet.",
      });
      return;
    }

    if (client.signedIn) {
      await this.showLauncher();
      return;
    }

    // Try the saved Keychain session once at startup (contract: restore_session).
    try {
      const restored = await this.bridge.restoreSession();
      if (restored.signedIn) {
        await this.refreshClient();
        await this.showLauncher();
        return;
      }
      this.showLogin(
        restored.reason === "expired" ? "Your saved session expired. Sign in again." : null,
      );
    } catch (error) {
      const err = toBridgeError(error);
      if (err.code === "unsupported_server") {
        this.showFirstRun({ prefill: client.serverUrl, notice: err.message });
        return;
      }
      this.showLogin(
        err.code === "network"
          ? "Couldn't verify your saved session — sign in to continue."
          : err.message,
      );
    }
  }

  private async handleAuthExpired(message: string): Promise<void> {
    this.launcher?.destroy();
    this.launcher = null;
    try {
      await this.refreshClient();
    } catch {
      /* fall through to the login screen */
    }
    const text = message || "Your session expired. Sign in again.";
    toast(text, "warning");
    this.showLogin(text);
  }

  // -- Boot / fatal screens -------------------------------------------------

  private renderBoot(): void {
    replace(
      this.root,
      h(
        "div",
        { class: "boot-screen", role: "status", "aria-live": "polite" },
        h("div", { class: "boot-brand" }, logoMark(36, "boot-logo"), h("span", { class: "boot-wordmark" }, "RAST Desktop")),
        h("div", { class: "boot-spinner", "aria-hidden": "true" }),
        h("p", { class: "boot-text" }, "Starting RAST Desktop…"),
      ),
    );
  }

  private renderFatal(message: string): void {
    replace(
      this.root,
      h(
        "div",
        { class: "auth-screen" },
        h(
          "main",
          { class: "auth-card", role: "alert" },
          h("div", { class: "auth-brand" }, logoMark(30, "auth-logo")),
          h("h1", { class: "auth-title" }, "RAST Desktop couldn't start"),
          h("p", { class: "auth-lede" }, message),
          h(
            "button",
            { class: "btn primary block", type: "button", onclick: () => void this.start() },
            "Try again",
          ),
        ),
      ),
    );
  }
}
