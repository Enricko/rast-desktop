/**
 * Main launcher screen.
 *
 * Own UI only: it lists applications discovered by the Rust core, filters and
 * searches them, and asks the core to launch them. Remote application pixels
 * are rendered by the native Xpra client — never by this WebView. The running
 * panel therefore shows connection/streaming *status* only.
 */

import type { AppContext } from "../app";
import { toBridgeError } from "../errors";
import type {
  AppEntry,
  Bridge,
  ClientState,
  ConnectionLevel,
  ConnectionState,
  LaunchState,
  LaunchStateEvent,
  StreamState,
  StreamStatus,
  NativeSession,
  Unlisten,
  ViewMode,
} from "../types";
import { CONNECTION_LEVEL_LABELS, LAUNCH_STATE_LABELS } from "../types";
import { h, replace } from "../ui/dom";
import { formatLatency, fuzzyScore, hostFromUrl, initials, plural, relativeTime } from "../ui/format";
import { fallbackAppIcon, icon, logoMark, wordmark, type IconName } from "../ui/icons";
import { toast } from "../ui/toast";

type Filter =
  | { kind: "all" }
  | { kind: "favorites" }
  | { kind: "recent" }
  | { kind: "running" }
  | { kind: "category"; category: string };

interface LaunchTracking {
  state: LaunchState;
  message: string | null;
  attempt: number;
}

interface RunDisplay {
  state: LaunchState | null;
  label: string;
  tone: "ok" | "warn" | "danger" | "muted" | "neutral";
  detail: string | null;
}

interface GridFocus {
  appId: string;
  part: "open" | "fav" | "action";
}

interface LauncherNodes {
  connection: HTMLDivElement;
  userButton: HTMLButtonElement;
  userMenu: HTMLDivElement;
  sidebar: HTMLElement;
  title: HTMLHeadingElement;
  subtitle: HTMLParagraphElement;
  search: HTMLInputElement;
  searchWrap: HTMLLabelElement;
  viewGrid: HTMLButtonElement;
  viewList: HTMLButtonElement;
  bannerSlot: HTMLDivElement;
  runningSlot: HTMLElement;
  gridSlot: HTMLDivElement;
  statusLeft: HTMLSpanElement;
  statusRight: HTMLSpanElement;
  liveRegion: HTMLDivElement;
}

function filterKey(filter: Filter): string {
  return filter.kind === "category" ? `category:${filter.category}` : filter.kind;
}

function toneForState(state: LaunchState): RunDisplay["tone"] {
  switch (state) {
    case "attached":
      return "ok";
    case "failed":
      return "danger";
    case "launching":
    case "connecting":
    case "reconnecting":
      return "warn";
    case "detached":
      return "muted";
    default:
      return "neutral";
  }
}

function detailForState(state: LaunchState): string {
  switch (state) {
    case "launching":
      return "Starting the application on your server…";
    case "connecting":
      return "Starting the native Xpra client…";
    case "attached":
      return "Native windows on your desktop";
    case "reconnecting":
      return "Reconnecting with a fresh stream token…";
    case "detached":
      return "Remote application still running";
    case "failed":
      return "Native windows unavailable";
    default:
      return "";
  }
}

export class Launcher {
  readonly element: HTMLElement;

  private readonly bridge: Bridge;
  private apps: AppEntry[] = [];
  private client: ClientState;
  private session: NativeSession | null = null;
  private stale = false;
  private warnings: string[] = [];
  private loading = true;
  private error: string | null = null;
  private connection: ConnectionState | null = null;
  private stream: StreamStatus | null = null;
  private filter: Filter = { kind: "all" };
  private query = "";
  private view: ViewMode;
  private readonly icons: Record<string, string> = {};
  private readonly launchStates = new Map<string, LaunchTracking>();
  private readonly launching = new Set<string>();
  private readonly confirmations = new Set<string>();
  private readonly unsubs: Unlisten[] = [];
  private readonly timers = new Set<number>();
  private userMenuOpen = false;
  private destroyed = false;
  private inventoryTimer: number | null = null;
  private searchTimer: number | null = null;
  private nodes!: LauncherNodes;

  constructor(
    private readonly ctx: AppContext,
    client: ClientState,
  ) {
    this.bridge = ctx.bridge;
    this.client = client;
    this.view = client.settings.view === "list" ? "list" : "grid";
    this.element = this.build();
  }

  // -- Lifecycle ------------------------------------------------------------

  async start(): Promise<void> {
    this.subscribe();
    this.renderSidebar();
    this.renderContentHead();
    this.renderConnection();
    this.renderViewToggle();
    this.renderRunning();
    this.renderBanner();
    this.renderGrid();
    await Promise.all([this.loadApps(false), this.loadConnection(), this.loadStream()]);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const unlisten of this.unsubs) unlisten();
    this.unsubs.length = 0;
    document.removeEventListener("keydown", this.onDocumentKeydown);
    document.removeEventListener("click", this.onDocumentClick);
    if (this.inventoryTimer !== null) window.clearTimeout(this.inventoryTimer);
    if (this.searchTimer !== null) window.clearTimeout(this.searchTimer);
    for (const timer of this.timers) window.clearTimeout(timer);
    this.timers.clear();
  }

  // -- Data -----------------------------------------------------------------

  private async loadApps(refresh = false, silent = false): Promise<void> {
    if (!silent) {
      this.loading = this.apps.length === 0;
      this.error = null;
      this.renderGrid();
    }
    try {
      const view = await this.bridge.listApps(refresh);
      if (this.destroyed) return;
      this.apps = view.apps.map((app) => ({ ...app, warnings: [...app.warnings] }));
      this.session = view.session;
      this.stale = view.stale;
      this.warnings = view.warnings;
      // Drop transient launch states for apps that are no longer running.
      for (const [appId, tracking] of this.launchStates) {
        const app = this.apps.find((candidate) => candidate.id === appId);
        if (!app) this.launchStates.delete(appId);
        else if (!app.running && tracking.state !== "failed") this.launchStates.delete(appId);
      }
      await this.loadIcons();
      this.loading = false;
      this.error = null;
      this.renderAll();
    } catch (error) {
      if (this.destroyed) return;
      const err = toBridgeError(error);
      if (silent && this.apps.length > 0) {
        toast("Couldn't refresh applications.", "warning", err.message);
        return;
      }
      this.loading = false;
      this.error = err.message || "Couldn't load applications from your server.";
      this.renderGrid();
      this.renderBanner();
    }
  }

  private async loadIcons(): Promise<void> {
    const missing = this.apps.filter((app) => app.hasIcon && !this.icons[app.id]).map((app) => app.id);
    if (missing.length === 0) return;
    try {
      const icons = await this.bridge.appIcons(missing);
      for (const [appId, dataUrl] of Object.entries(icons)) {
        if (dataUrl) this.icons[appId] = dataUrl;
      }
    } catch {
      /* generated fallback icons are used instead */
    }
  }

  private async loadConnection(): Promise<void> {
    try {
      this.connection = await this.bridge.probeConnection();
    } catch {
      this.connection = null;
    }
    if (this.destroyed) return;
    this.renderConnection();
    this.renderBanner();
  }

  private async loadStream(): Promise<void> {
    try {
      this.stream = await this.bridge.streamStatus();
    } catch {
      this.stream = null;
    }
    if (this.destroyed) return;
    this.renderRunning();
    this.renderBanner();
  }

  private scheduleInventoryRefresh(): void {
    if (this.inventoryTimer !== null) window.clearTimeout(this.inventoryTimer);
    this.inventoryTimer = window.setTimeout(() => {
      this.inventoryTimer = null;
      void this.loadApps(true, true);
    }, 350);
  }

  private after(delayMs: number, fn: () => void): void {
    const id = window.setTimeout(() => {
      this.timers.delete(id);
      if (!this.destroyed) fn();
    }, delayMs);
    this.timers.add(id);
  }

  private renderAll(): void {
    this.renderSidebar();
    this.renderContentHead();
    this.renderRunning();
    this.renderBanner();
    this.renderStatusBar();
    this.renderGrid();
  }

  /** Bottom status bar: how native windows are delivered + protocol info. */
  private renderStatusBar(): void {
    const client = this.client;
    const xpra = client.xpra;
    const found = xpra.state === "found";
    const nativeLabel = found
      ? `Xpra ${xpra.version ?? ""} · seamless windows`.replace(/\s+/g, " ").trim()
      : "Xpra not detected";
    replace(
      this.nodes.statusLeft,
      icon(found ? "window" : "alert", 12),
      h("span", { class: "status-item", title: xpra.message ?? "Native window host status" }, nativeLabel),
      this.stream && this.stream.state !== "idle"
        ? h("span", { class: "status-item status-stream" }, `· stream ${this.stream.state}`)
        : null,
    );

    const protocol = client.server?.desktop?.protocol ?? null;
    const host = hostFromUrl(client.server?.url ?? client.serverUrl);
    replace(
      this.nodes.statusRight,
      h("span", { class: "status-item" }, host || "no server"),
      h("span", { class: "status-sep" }, "·"),
      h("span", { class: "status-item" }, protocol !== null ? `desktop protocol v${protocol}` : "desktop protocol unknown"),
      h("span", { class: "status-sep" }, "·"),
      h("span", { class: "status-item" }, "HTTPS"),
    );
  }

  // -- Bridge event subscriptions ------------------------------------------

  private subscribe(): void {
    this.unsubs.push(
      this.bridge.onLaunchState((event) => this.onLaunchState(event)),
      this.bridge.onStreamStatus((status) => {
        this.stream = status;
        this.renderRunning();
        this.renderBanner();
        this.renderStatusBar();
        if (status.state === "failed") {
          toast("Native window stream failed.", "warning", status.message ?? undefined);
        }
      }),
      this.bridge.onConnectionState((connection) => {
        const wasOffline = this.connection?.state === "offline";
        this.connection = connection;
        this.renderConnection();
        this.renderBanner();
        if (wasOffline && connection.state !== "offline") void this.loadApps(true, true);
      }),
      this.bridge.onSessionChanged((session) => {
        this.session = session;
        this.scheduleInventoryRefresh();
      }),
      this.bridge.onInventoryChanged(() => this.scheduleInventoryRefresh()),
    );
    document.addEventListener("keydown", this.onDocumentKeydown);
    document.addEventListener("click", this.onDocumentClick);
  }

  private onLaunchState(event: LaunchStateEvent): void {
    const app = event.appId ? this.apps.find((candidate) => candidate.id === event.appId) : null;
    const name = app?.name ?? "Application";
    if (event.appId) {
      this.launchStates.set(event.appId, {
        state: event.state,
        message: event.message,
        attempt: event.attempt,
      });
    }
    switch (event.state) {
      case "launching":
        this.announce(`Launching ${name}…`);
        break;
      case "connecting":
        this.announce(`Connecting ${name} to the native window stream…`);
        break;
      case "attached":
        this.announce(`${name} is attached. Its windows are on your desktop.`);
        this.scheduleInventoryRefresh();
        break;
      case "reconnecting":
        this.announce(`Reconnecting ${name}…`);
        break;
      case "detached":
        this.announce(`${name} detached. The remote application keeps running.`);
        this.scheduleInventoryRefresh();
        break;
      case "failed":
        toast(`Couldn't start ${name}'s native window.`, "error", event.message ?? undefined);
        this.announce(`${name} failed: ${event.message ?? "native window unavailable"}`);
        this.scheduleInventoryRefresh();
        break;
    }
    this.renderGrid();
    this.renderRunning();
    this.renderBanner();
  }

  private announce(message: string): void {
    if (!this.nodes) return;
    this.nodes.liveRegion.textContent = "";
    this.nodes.liveRegion.textContent = message;
  }

  // -- DOM construction -----------------------------------------------------

  private build(): HTMLElement {
    const connection = h("div", { class: "conn", role: "status", "aria-label": "Connection quality" });
    const userMenu = h("div", { class: "user-menu", role: "menu", hidden: true });
    const userButton = h(
      "button",
      {
        class: "user-chip",
        type: "button",
        "aria-haspopup": "menu",
        "aria-expanded": "false",
        "aria-label": "Account menu",
        onclick: (event) => {
          event.stopPropagation();
          this.toggleUserMenu();
        },
      },
      h("span", { class: "avatar" }, initials(this.userName())),
      h("span", { class: "user-chip-text" }, h("span", { class: "user-chip-name" }, this.userName())),
      icon("chevron-down", 13, "user-chip-chevron"),
    );

    const liveRegion = h("div", { class: "sr-only", "aria-live": "polite", "aria-atomic": "true" });

    const search = h("input", {
      class: "search-input",
      type: "search",
      placeholder: "Search applications",
      "aria-label": "Search applications",
      autocomplete: "off",
      spellcheck: "false",
      oninput: () => this.onSearchInput(),
    });
    const searchWrap = h(
      "label",
      { class: "search" },
      icon("search", 15, "search-icon"),
      search,
      h("kbd", { class: "search-key", "aria-hidden": "true" }, "/"),
    );

    const viewGrid = h(
      "button",
      {
        class: "view-btn",
        type: "button",
        "aria-label": "Grid view",
        "aria-pressed": "true",
        title: "Grid view",
        onclick: () => this.setView("grid"),
      },
      icon("grid", 15),
    );
    const viewList = h(
      "button",
      {
        class: "view-btn",
        type: "button",
        "aria-label": "List view",
        "aria-pressed": "false",
        title: "List view",
        onclick: () => this.setView("list"),
      },
      icon("list", 15),
    );

    const sidebar = h("nav", { class: "sidebar", "aria-label": "Application views" });
    const title = h("h1", { class: "content-title", id: "view-heading" }, "All applications");
    const subtitle = h("p", { class: "content-sub" });
    const bannerSlot = h("div", { class: "banner-slot", hidden: true });
    const runningSlot = h("section", {
      class: "running-slot",
      "aria-label": "Running applications",
      hidden: true,
    });
    const gridSlot = h("div", { class: "grid-slot", "aria-busy": "true" });
    const statusLeft = h("span", { class: "status-left" });
    const statusRight = h("span", { class: "status-right" });

    this.nodes = {
      connection,
      userButton,
      userMenu,
      sidebar,
      title,
      subtitle,
      search,
      searchWrap,
      viewGrid,
      viewList,
      bannerSlot,
      runningSlot,
      gridSlot,
      statusLeft,
      statusRight,
      liveRegion,
    };

    const header = h(
      "header",
      { class: "app-header" },
      h(
        "div",
        { class: "header-brand" },
        h("span", { class: "header-logo" }, logoMark(22)),
        wordmark("header-wordmark"),
      ),
      h("div", { class: "header-server" }, this.serverChip()),
      h(
        "div",
        { class: "header-right" },
        connection,
        h("div", { class: "header-user" }, userButton, userMenu),
        h(
          "button",
          {
            class: "icon-btn",
            type: "button",
            "aria-label": "Open settings",
            title: "Settings (⌘,)",
            onclick: () => this.ctx.openSettings(),
          },
          icon("settings", 18),
        ),
      ),
    );

    const content = h(
      "main",
      { class: "content", "aria-labelledby": "view-heading" },
      h(
        "div",
        { class: "content-head" },
        h("div", { class: "content-heading" }, title, subtitle),
        h(
          "div",
          { class: "content-tools" },
          searchWrap,
          h("div", { class: "view-toggle", role: "group", "aria-label": "View mode" }, viewGrid, viewList),
        ),
      ),
      bannerSlot,
      runningSlot,
      gridSlot,
      liveRegion,
    );

    this.buildUserMenu();
    const statusBar = h(
      "footer",
      { class: "status-bar", "aria-label": "Desktop status" },
      statusLeft,
      statusRight,
    );
    return h(
      "div",
      { class: "launcher" },
      header,
      h("div", { class: "app-body" }, sidebar, content),
      statusBar,
    );
  }

  private serverChip(): HTMLElement {
    const host = hostFromUrl(this.client.server?.url ?? this.client.serverUrl);
    const server = this.client.server;
    return h(
      "div",
      {
        class: "header-server-chip",
        title: server ? `${server.product} ${server.version} · ${server.url}` : host,
      },
      h("span", { class: "server-dot", "aria-hidden": "true" }),
      h("span", { class: "server-host" }, host || "Not connected"),
      server
        ? h("span", { class: "badge badge-quiet" }, `${server.product} ${server.version}`)
        : null,
    );
  }

  private userName(): string {
    const user = this.client.user;
    return user?.displayName || user?.username || "Signed in";
  }

  // -- Header: connection quality ------------------------------------------

  private renderConnection(): void {
    const node = this.nodes.connection;
    const connection = this.connection;
    if (!connection) {
      node.removeAttribute("data-level");
      replace(
        node,
        h("span", { class: "conn-dot", "data-tone": "muted" }),
        h("span", { class: "conn-text" }, h("span", { class: "conn-label" }, "Checking…")),
      );
      node.title = "Checking server reachability…";
      node.setAttribute("aria-label", "Connection quality: checking");
      return;
    }
    const level: ConnectionLevel = connection.state;
    const label = CONNECTION_LEVEL_LABELS[level] ?? connection.label;
    const latency = formatLatency(connection.latencyMs ?? undefined);
    const basis = level === "offline" ? "unreachable" : "reachability";
    node.dataset.level = level;
    replace(
      node,
      h("span", { class: "conn-dot" }),
      h(
        "span",
        { class: "conn-text" },
        h("span", { class: "conn-label" }, label),
        h("span", { class: "conn-basis" }, basis),
      ),
      latency ? h("span", { class: "conn-latency" }, latency) : null,
    );
    node.title = `${connection.label || "Server reachability"}: ${label}${
      latency ? `, ${latency} round-trip` : ""
    }. This is HTTPS reachability to your server, not a video-quality measure.`;
    node.setAttribute(
      "aria-label",
      `Connection quality: ${label}. ${connection.label || "Server reachability"}${
        latency ? `, ${latency} round-trip` : ""
      }.`,
    );
  }

  // -- Header: account menu -------------------------------------------------

  private buildUserMenu(): void {
    const user = this.client.user;
    replace(
      this.nodes.userMenu,
      h(
        "div",
        { class: "user-menu-head" },
        h("span", { class: "avatar avatar-lg" }, initials(this.userName())),
        h(
          "div",
          { class: "user-menu-identity" },
          h("div", { class: "user-menu-name" }, this.userName()),
          h(
            "div",
            { class: "user-menu-meta" },
            user ? `@${user.username}${user.role === "admin" ? " · admin" : ""}` : "Signed in",
          ),
        ),
      ),
      h("div", { class: "menu-sep", role: "separator" }),
      this.menuItem("About RAST Desktop", "info", () => this.ctx.openAbout()),
      this.menuItem("Settings", "settings", () => this.ctx.openSettings()),
      h("div", { class: "menu-sep", role: "separator" }),
      this.menuItem("Sign out", "logout", () => void this.ctx.signOut(), "danger"),
    );
  }

  private menuItem(
    label: string,
    iconName: IconName,
    action: () => void,
    tone: "danger" | "default" = "default",
  ): HTMLButtonElement {
    return h(
      "button",
      {
        class: `menu-item${tone === "danger" ? " menu-item-danger" : ""}`,
        type: "button",
        role: "menuitem",
        onclick: (event) => {
          event.stopPropagation();
          this.closeUserMenu();
          action();
        },
      },
      icon(iconName, 15),
      h("span", {}, label),
    );
  }

  private toggleUserMenu(): void {
    if (this.userMenuOpen) {
      this.closeUserMenu();
      return;
    }
    this.buildUserMenu();
    this.nodes.userMenu.hidden = false;
    this.userMenuOpen = true;
    this.nodes.userButton.setAttribute("aria-expanded", "true");
    const first = this.nodes.userMenu.querySelector<HTMLButtonElement>(".menu-item");
    first?.focus();
  }

  private closeUserMenu(): void {
    if (!this.userMenuOpen) return;
    this.userMenuOpen = false;
    this.nodes.userMenu.hidden = true;
    this.nodes.userButton.setAttribute("aria-expanded", "false");
  }

  private onDocumentClick = (event: Event): void => {
    if (!this.userMenuOpen) return;
    const target = event.target as Node | null;
    if (target && this.nodes.userButton.parentElement?.contains(target)) return;
    this.closeUserMenu();
  };

  // -- Sidebar --------------------------------------------------------------

  private renderSidebar(): void {
    const nav = this.nodes.sidebar;
    const previousFocus =
      document.activeElement instanceof HTMLElement
        ? (document.activeElement.closest<HTMLElement>(".side-item")?.dataset.filter ?? null)
        : null;
    const runningCount = this.apps.filter((app) => app.running || this.launchStates.has(app.id)).length;
    const recentCount = this.apps.filter((app) => app.lastUsedAt !== null).length;
    const favoritesCount = this.apps.filter((app) => app.favorite).length;
    const categories = this.categories();
    const activeKey = filterKey(this.filter);

    const mainFilters: { filter: Filter; label: string; iconName: IconName; count: number }[] = [
      { filter: { kind: "all" }, label: "All applications", iconName: "grid", count: this.apps.length },
      { filter: { kind: "favorites" }, label: "Favorites", iconName: "star", count: favoritesCount },
      { filter: { kind: "recent" }, label: "Recent", iconName: "clock", count: recentCount },
      { filter: { kind: "running" }, label: "Running", iconName: "activity", count: runningCount },
    ];

    replace(
      nav,
      h(
        "div",
        { class: "side-group" },
        ...mainFilters.map((item) =>
          this.sideItem(item.filter, item.label, item.iconName, item.count, activeKey),
        ),
      ),
      h(
        "div",
        { class: "side-group side-categories" },
        h("div", { class: "side-heading" }, "Categories"),
        ...categories.map((category) =>
          this.sideItem(
            { kind: "category", category },
            category,
            null,
            this.apps.filter((app) => app.category === category).length,
            activeKey,
          ),
        ),
        categories.length === 0 ? h("div", { class: "side-empty" }, "No categories") : null,
      ),
      h("div", { class: "side-spacer" }),
      h(
        "div",
        { class: "side-foot" },
        h("span", { class: "side-foot-line" }, `RAST Desktop ${this.client.clientVersion}`),
        h(
          "span",
          { class: "side-foot-line side-foot-muted" },
          `Signed in as ${this.client.user?.username ?? "—"}`,
        ),
        this.bridge.mode === "mock" ? h("span", { class: "mock-badge" }, "Demo data · mock bridge") : null,
      ),
    );

    if (previousFocus) {
      const active = nav.querySelector<HTMLElement>(`.side-item[data-filter="${previousFocus}"]`);
      active?.focus();
    }
  }

  private sideItem(
    filter: Filter,
    label: string,
    iconName: IconName | null,
    count: number,
    activeKey: string,
  ): HTMLButtonElement {
    const key = filterKey(filter);
    const isActive = key === activeKey;
    return h(
      "button",
      {
        class: `side-item${isActive ? " is-active" : ""}${filter.kind === "running" && count > 0 ? " has-live" : ""}`,
        type: "button",
        "data-filter": key,
        "aria-current": isActive ? "page" : false,
        onclick: () => this.setFilter(filter),
      },
      iconName
        ? h("span", { class: "side-icon" }, icon(iconName, 15))
        : h("span", { class: "side-dot", "aria-hidden": "true" }),
      h("span", { class: "side-label" }, label),
      h("span", { class: "side-count" }, String(count)),
    );
  }

  private categories(): string[] {
    const seen: string[] = [];
    for (const app of this.apps) {
      if (!seen.includes(app.category)) seen.push(app.category);
    }
    return seen.sort((a, b) => a.localeCompare(b));
  }

  private setFilter(filter: Filter): void {
    this.filter = filter;
    this.renderSidebar();
    this.renderContentHead();
    this.renderGrid();
  }

  // -- Content head / view toggle ------------------------------------------

  private renderContentHead(): void {
    const filter = this.filter;
    const filtered = this.filteredApps();
    const base = this.baseFilteredApps();
    this.nodes.title.textContent = this.filterTitle();
    const host = hostFromUrl(this.client.server?.url ?? this.client.serverUrl);
    let subtitle: string;
    if (this.query.trim()) {
      subtitle = `${filtered.length} of ${base.length} ${plural(base.length, "application")} match “${this.query.trim()}”`;
    } else {
      switch (filter.kind) {
        case "all":
          subtitle = `${this.apps.length} ${plural(this.apps.length, "application")} available on ${host || "your server"}`;
          break;
        case "favorites":
          subtitle = `${base.length} starred ${plural(base.length, "application")}`;
          break;
        case "recent":
          subtitle = `${base.length} recently launched ${plural(base.length, "application")}`;
          break;
        case "running":
          subtitle = `${base.length} ${plural(base.length, "application")} running on your server`;
          break;
        case "category":
          subtitle = `${base.length} ${plural(base.length, "application")} in ${filter.category}`;
          break;
      }
    }
    this.nodes.subtitle.textContent = subtitle;
  }

  private filterTitle(): string {
    const filter = this.filter;
    switch (filter.kind) {
      case "all":
        return "All applications";
      case "favorites":
        return "Favorites";
      case "recent":
        return "Recent";
      case "running":
        return "Running";
      case "category":
        return filter.category;
    }
  }

  private renderViewToggle(): void {
    const isGrid = this.view === "grid";
    this.nodes.viewGrid.setAttribute("aria-pressed", String(isGrid));
    this.nodes.viewList.setAttribute("aria-pressed", String(!isGrid));
    this.nodes.viewGrid.classList.toggle("is-active", isGrid);
    this.nodes.viewList.classList.toggle("is-active", !isGrid);
  }

  private setView(view: ViewMode): void {
    if (this.view === view) return;
    this.view = view;
    const settings = { ...this.ctx.getClient().settings, view };
    this.ctx.updateSettings(settings);
    void this.bridge.saveSettings(settings).catch(() => {
      /* non-critical UI preference; the core keeps its previous value */
    });
    this.renderViewToggle();
    this.renderGrid();
  }

  // -- Filtering / search ---------------------------------------------------

  private baseFilteredApps(): AppEntry[] {
    const filter = this.filter;
    switch (filter.kind) {
      case "favorites":
        return this.apps.filter((app) => app.favorite);
      case "recent":
        return this.apps.filter((app) => app.lastUsedAt !== null);
      case "running":
        return this.apps.filter((app) => app.running || this.launchStates.has(app.id));
      case "category":
        return this.apps.filter((app) => app.category === filter.category);
      default:
        return this.apps;
    }
  }

  private filteredApps(): AppEntry[] {
    const base = this.baseFilteredApps();
    const query = this.query.trim().toLowerCase();
    let list = base;
    if (query) {
      const scored = base
        .map((app) => ({ app, score: this.searchScore(app, query) }))
        .filter((entry) => entry.score >= 0)
        .sort((a, b) => b.score - a.score || a.app.name.localeCompare(b.app.name));
      list = scored.map((entry) => entry.app);
    }
    if (this.filter.kind === "recent" && !query) {
      list = [...list].sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0));
    }
    return list;
  }

  private searchScore(app: AppEntry, query: string): number {
    const name = fuzzyScore(query, app.name);
    const description = app.description ? fuzzyScore(query, app.description) : -1;
    const category = fuzzyScore(query, app.category);
    return Math.max(name, description >= 0 ? description - 60 : -1, category >= 0 ? category - 90 : -1);
  }

  private onSearchInput(): void {
    const value = this.nodes.search.value;
    if (this.searchTimer !== null) window.clearTimeout(this.searchTimer);
    this.searchTimer = window.setTimeout(() => {
      this.searchTimer = null;
      this.query = value.trim();
      this.renderContentHead();
      this.renderGrid();
    }, 70);
  }

  // -- Banners --------------------------------------------------------------

  private renderBanner(): void {
    this.renderStatusBar();
    const slot = this.nodes.bannerSlot;
    const banners: HTMLElement[] = [];
    const host = hostFromUrl(this.client.server?.url ?? this.client.serverUrl) || "the server";
    const offline = this.connection?.state === "offline";

    if (offline) {
      banners.push(
        this.banner(
          "warning",
          "wifi-off",
          `Can't reach ${host}`,
          "Showing the last known application list. RAST Desktop keeps retrying in the background.",
          { label: "Retry now", action: () => void this.retryAll() },
        ),
      );
    } else if (this.stale) {
      banners.push(
        this.banner(
          "info",
          "server",
          "Showing the last known application list",
          this.warnings.join(" ") || "The server could not be refreshed.",
          { label: "Refresh", action: () => void this.loadApps(true) },
        ),
      );
    }

    const xpra = this.client.xpra;
    if (!offline && (xpra.state === "missing" || xpra.state === "invalid")) {
      banners.push(
        this.banner(
          "warning",
          "alert",
          "Xpra client not detected",
          xpra.message ??
            "Install the official Xpra macOS client (Xpra.app) from xpra.org, then restart RAST Desktop.",
          { label: "Check again", action: () => void this.recheckXpra() },
        ),
      );
    }

    if (!offline && this.stream?.state === "failed" && xpra.state === "found") {
      banners.push(
        this.banner(
          "warning",
          "alert",
          "Native window stream failed",
          this.stream.message ??
            "The Xpra client could not attach. Remote applications keep running on the server.",
          { label: "Reconnect", action: () => void this.reconnectStream() },
        ),
      );
    }

    const viewWarnings = this.warnings.filter((warning) => warning.trim().length > 0);
    if (!offline && !this.stale && viewWarnings.length > 0) {
      banners.push(
        this.banner("info", "info", "Server notes", viewWarnings.join(" "), null),
      );
    }

    slot.replaceChildren(...banners);
    slot.hidden = banners.length === 0;
  }

  private banner(
    tone: "info" | "warning",
    iconName: IconName,
    title: string,
    detail: string,
    action: { label: string; action: () => void } | null,
  ): HTMLElement {
    return h(
      "div",
      { class: `banner banner-${tone}`, role: tone === "warning" ? "status" : "status" },
      h("span", { class: "banner-icon" }, icon(iconName, 16)),
      h(
        "div",
        { class: "banner-text" },
        h("span", { class: "banner-title" }, title),
        h("span", { class: "banner-detail" }, detail),
      ),
      action
        ? h(
            "button",
            { class: "btn small ghost banner-action", type: "button", onclick: action.action },
            action.label,
          )
        : null,
    );
  }

  private async recheckXpra(): Promise<void> {
    try {
      this.client = await this.ctx.refreshClient();
      this.renderBanner();
      toast(
        this.client.xpra.state === "found"
          ? "Xpra client detected."
          : this.client.xpra.message ?? "Xpra client still not found.",
        this.client.xpra.state === "found" ? "success" : "warning",
      );
    } catch (error) {
      toast("Couldn't re-check the Xpra client.", "error", toBridgeError(error).message);
    }
  }

  private async reconnectStream(): Promise<void> {
    const target =
      this.apps.find((app) => app.running && app.launchable) ??
      this.apps.find((app) => app.launchable);
    if (!target) {
      toast("Launch an application to reconnect the native stream.", "info");
      return;
    }
    await this.launch(target);
  }

  private async retryAll(): Promise<void> {
    this.loading = this.apps.length === 0;
    this.error = null;
    this.renderGrid();
    await Promise.all([this.loadApps(false), this.loadConnection(), this.loadStream()]);
  }

  // -- Running panel --------------------------------------------------------

  private runDisplay(app: AppEntry): RunDisplay {
    const tracking = this.launchStates.get(app.id);
    if (tracking) {
      return {
        state: tracking.state,
        label: LAUNCH_STATE_LABELS[tracking.state],
        tone: toneForState(tracking.state),
        detail:
          tracking.message ??
          (tracking.state === "reconnecting" && tracking.attempt > 0
            ? `Reconnecting… (attempt ${tracking.attempt})`
            : detailForState(tracking.state)),
      };
    }
    if (!app.running) {
      return { state: null, label: "", tone: "neutral", detail: null };
    }
    const streamState: StreamState = this.stream?.state ?? "idle";
    if (streamState === "idle") {
      return {
        state: null,
        label: "Running",
        tone: "ok",
        detail: "Remote application is running on the server.",
      };
    }
    const state = streamState as LaunchState;
    const attempt = this.stream?.attempt ?? 0;
    return {
      state,
      label: LAUNCH_STATE_LABELS[state],
      tone: toneForState(state),
      detail:
        this.stream?.message ??
        (state === "reconnecting" && attempt > 0
          ? `Reconnecting… (attempt ${attempt})`
          : detailForState(state)),
    };
  }

  private renderRunning(): void {
    const slot = this.nodes.runningSlot;
    const running = this.apps.filter((app) => app.running || this.launchStates.has(app.id));
    if (running.length === 0) {
      slot.hidden = true;
      slot.replaceChildren();
      return;
    }
    slot.hidden = false;
    const streamPill = this.streamPill();
    replace(
      slot,
      h(
        "div",
        { class: "running-head" },
        h(
          "div",
          { class: "running-title" },
          h("h2", { class: "running-heading" }, "Running now"),
          h("span", { class: "count-pill" }, String(running.length)),
        ),
        this.sessionBadge(),
        streamPill,
        h(
          "div",
          { class: "running-actions" },
          h(
            "button",
            {
              class: "btn small ghost",
              type: "button",
              title: "Close the native windows locally. Remote applications keep running.",
              onclick: () => void this.detachWindows(),
            },
            icon("window", 13),
            "Detach windows",
          ),
          this.endSessionButton(),
        ),
      ),
      h(
        "div",
        { class: "run-list" },
        ...running.map((app) => this.runCard(app)),
      ),
    );
  }

  private sessionBadge(): HTMLElement | null {
    const session = this.session;
    if (!session) return null;
    const backend = session.displayBackend ?? "unknown";
    const profile = session.profile ?? "default";
    return h(
      "span",
      {
        class: "session-badge",
        title: `Native session ${session.id} · display backend ${backend} · profile ${profile} · one macOS window per remote window`,
      },
      icon("server", 12),
      `${backend} · ${profile}`,
    );
  }

  private streamPill(): HTMLElement | null {
    const stream = this.stream;
    if (!stream || stream.state === "idle") return null;
    const labels: Record<StreamState, string> = {
      idle: "Idle",
      connecting: "Native windows connecting…",
      attached: "Native windows attached",
      reconnecting: `Reconnecting… (attempt ${stream.attempt}/${stream.maxAttempts})`,
      detached: "Native windows detached",
      failed: "Native window failed",
    };
    const tones: Record<StreamState, string> = {
      idle: "neutral",
      connecting: "warn",
      attached: "ok",
      reconnecting: "warn",
      detached: "muted",
      failed: "danger",
    };
    return h(
      "span",
      {
        class: `state-pill tone-${tones[stream.state]} stream-pill`,
        title: stream.message ?? `Xpra ${stream.xpraVersion ?? ""} · ${stream.state}`.trim(),
      },
      h("span", { class: "state-dot" }),
      labels[stream.state],
    );
  }

  private runCard(app: AppEntry): HTMLElement {
    const display = this.runDisplay(app);
    return h(
      "article",
      { class: "run-card", "data-app-id": app.id },
      this.appIconEl(app, "run-icon"),
      h(
        "div",
        { class: "run-info" },
        h(
          "div",
          { class: "run-name-row" },
          h("span", { class: "run-name" }, app.name),
          this.statusPill(display),
        ),
        h("div", { class: "run-detail" }, display.detail ?? ""),
      ),
      this.endAppButton(app),
    );
  }

  private endSessionButton(): HTMLButtonElement {
    const armed = this.confirmations.has("end-session");
    return h(
      "button",
      {
        class: `btn small ${armed ? "danger" : "ghost"}`,
        type: "button",
        title: armed
          ? "Click again to stop every remote application of this session"
          : "Stop every remote application in this session",
        onclick: () => {
          if (!armed) {
            this.armConfirm("end-session");
            this.renderRunning();
            return;
          }
          this.confirmations.delete("end-session");
          void this.endSession();
        },
      },
      icon("stop", 13),
      armed ? "Confirm end session" : "End session…",
    );
  }

  private async endSession(): Promise<void> {
    try {
      await this.bridge.endSession();
      this.launchStates.clear();
      this.announce("Ended the remote session. All remote applications were stopped.");
      toast("Ended the remote session. All remote applications were stopped.", "success");
      await this.loadApps(true, true);
    } catch (error) {
      toast("Couldn't end the remote session.", "error", toBridgeError(error).message);
    }
  }

  private async detachWindows(): Promise<void> {
    try {
      await this.bridge.detach();
      toast("Detached native windows. Remote applications keep running.", "success");
    } catch (error) {
      toast("Couldn't detach native windows.", "error", toBridgeError(error).message);
    }
  }

  private async endApp(app: AppEntry): Promise<void> {
    try {
      const result = await this.bridge.endApp(app.id);
      this.launchStates.delete(app.id);
      this.session = result.session;
      this.announce(`${app.name} ended.`);
      toast(`Ended ${app.name}.`, "success");
      await this.loadApps(true, true);
    } catch (error) {
      const err = toBridgeError(error);
      if (err.code === "no_run") {
        toast(`${app.name} was not running.`, "info");
        await this.loadApps(true, true);
        return;
      }
      toast(`Couldn't end ${app.name}.`, "error", err.message);
    }
  }

  private armConfirm(key: string): void {
    this.confirmations.add(key);
    this.after(3800, () => {
      if (this.confirmations.delete(key)) this.renderRunning();
    });
  }

  // -- App cards ------------------------------------------------------------

  private appIconEl(app: AppEntry, className: string): HTMLElement {
    const src = this.icons[app.id] ?? fallbackAppIcon(app.name);
    const image = h("img", { src, alt: "", loading: "lazy", decoding: "async" });
    image.addEventListener("error", () => {
      image.src = fallbackAppIcon(app.name);
    });
    return h("span", { class: className, "aria-hidden": "true" }, image);
  }

  private statusPill(display: RunDisplay): HTMLElement | null {
    if (display.state === null && display.label === "") return null;
    return h(
      "span",
      {
        class: `state-pill tone-${display.tone}`,
        title: display.detail ?? display.label,
      },
      h("span", { class: "state-dot" }),
      display.label,
    );
  }

  private favoriteButton(app: AppEntry): HTMLButtonElement {
    const label = app.favorite
      ? `Remove ${app.name} from favorites`
      : `Add ${app.name} to favorites`;
    return h(
      "button",
      {
        class: `fav-btn${app.favorite ? " is-favorite" : ""}`,
        type: "button",
        "aria-pressed": String(app.favorite),
        "aria-label": label,
        title: label,
        onclick: (event) => {
          event.stopPropagation();
          void this.toggleFavorite(app);
        },
      },
      icon(app.favorite ? "star-filled" : "star", 15),
    );
  }

  private actionButton(app: AppEntry, display: RunDisplay): HTMLButtonElement {
    if (!app.launchable) {
      return h(
        "button",
        {
          class: "btn small ghost app-action",
          type: "button",
          disabled: true,
          title: app.warnings.join("\n") || "This application can't be launched from RAST Desktop.",
        },
        "Unavailable",
      );
    }
    if (app.running) {
      return this.endAppButton(app);
    }
    const retrying = display.state === "failed" || display.state === "detached";
    return h(
      "button",
      {
        class: "btn small app-action",
        type: "button",
        title: retrying ? `Reconnect ${app.name}` : `Launch ${app.name}`,
        onclick: (event) => {
          event.stopPropagation();
          void this.activateApp(app);
        },
      },
      icon("play", 12),
      retrying ? (display.state === "detached" ? "Reconnect" : "Retry") : "Launch",
    );
  }

  private endAppButton(app: AppEntry): HTMLButtonElement {
    const key = `end:${app.id}`;
    const armed = this.confirmations.has(key);
    return h(
      "button",
      {
        class: `btn small app-action ${armed ? "danger" : "ghost"}`,
        type: "button",
        title: armed
          ? "Click again to end this application on the server"
          : `End ${app.name} on the server`,
        onclick: (event) => {
          event.stopPropagation();
          if (!armed) {
            this.armConfirm(key);
            this.renderGrid();
            this.renderRunning();
            return;
          }
          this.confirmations.delete(key);
          void this.endApp(app);
        },
      },
      icon("stop", 12),
      armed ? "Confirm" : "End",
    );
  }

  private openLabel(app: AppEntry, display: RunDisplay): string {
    if (!app.launchable) return `${app.name} — unavailable`;
    if (app.running) return `${app.name} — ${display.label || "running"}`;
    if (display.state === "failed") return `Retry ${app.name}`;
    return `Launch ${app.name}`;
  }

  private gridCard(app: AppEntry): HTMLElement {
    const display = this.runDisplay(app);
    const open = h(
      "button",
      {
        class: "app-open",
        type: "button",
        "aria-label": this.openLabel(app, display),
        onclick: () => void this.activateApp(app),
      },
      this.appIconEl(app, "app-icon"),
      h(
        "span",
        { class: "app-text" },
        h(
          "span",
          { class: "app-name-row" },
          h("span", { class: "app-name" }, app.name),
          app.running ? h("span", { class: "run-dot", "aria-hidden": "true" }) : null,
        ),
        h("span", { class: "app-desc" }, app.description ?? "Application from your RAST server."),
      ),
    );
    const foot = h(
      "div",
      { class: "app-foot" },
      h("span", { class: "app-cat" }, app.category),
      app.lastUsedAt !== null
        ? h("span", { class: "app-meta" }, `· ${relativeTime(app.lastUsedAt)}`)
        : null,
      app.warnings.length > 0
        ? h("span", { class: "app-warning", title: app.warnings.join("\n") }, icon("alert", 12))
        : null,
      h("span", { class: "app-foot-spacer" }),
      display.state !== null || display.label !== "" ? this.statusPill(display) : null,
      this.actionButton(app, display),
    );
    return h(
      "article",
      {
        class: `app-card${app.running ? " is-running" : ""}${app.launchable ? "" : " is-unavailable"}`,
        "data-app-id": app.id,
        role: "listitem",
      },
      open,
      this.favoriteButton(app),
      foot,
    );
  }

  private listCard(app: AppEntry): HTMLElement {
    const display = this.runDisplay(app);
    const open = h(
      "button",
      {
        class: "app-open",
        type: "button",
        "aria-label": this.openLabel(app, display),
        onclick: () => void this.activateApp(app),
      },
      this.appIconEl(app, "app-icon app-icon-sm"),
      h(
        "span",
        { class: "app-text" },
        h(
          "span",
          { class: "app-name-row" },
          h("span", { class: "app-name" }, app.name),
          app.running ? h("span", { class: "run-dot", "aria-hidden": "true" }) : null,
          app.version ? h("span", { class: "app-version" }, app.version) : null,
        ),
        h("span", { class: "app-desc" }, app.description ?? "Application from your RAST server."),
      ),
    );
    return h(
      "article",
      {
        class: `app-row${app.running ? " is-running" : ""}${app.launchable ? "" : " is-unavailable"}`,
        "data-app-id": app.id,
        role: "listitem",
      },
      open,
      h("span", { class: "app-cat app-row-cat" }, app.category),
      h(
        "span",
        { class: "app-row-status" },
        app.warnings.length > 0
          ? h("span", { class: "app-warning", title: app.warnings.join("\n") }, icon("alert", 13))
          : null,
        display.state !== null || display.label !== ""
          ? this.statusPill(display)
          : h("span", { class: "app-row-idle" }, "Ready"),
      ),
      this.actionButton(app, display),
      this.favoriteButton(app),
    );
  }

  // -- Grid rendering -------------------------------------------------------

  private renderGrid(): void {
    const slot = this.nodes.gridSlot;
    const previousFocus = this.captureGridFocus();
    slot.setAttribute("aria-busy", String(this.loading));

    if (this.loading) {
      slot.replaceChildren(this.skeletonGrid());
      return;
    }
    if (this.error !== null) {
      slot.replaceChildren(this.errorState());
      return;
    }
    const apps = this.filteredApps();
    if (apps.length === 0) {
      slot.replaceChildren(this.emptyState());
      return;
    }
    const container = h(
      "div",
      {
        class: this.view === "grid" ? "app-grid" : "app-list",
        role: "list",
        "aria-labelledby": "view-heading",
      },
      ...apps.map((app) => (this.view === "grid" ? this.gridCard(app) : this.listCard(app))),
    );
    slot.replaceChildren(container);
    this.applyRovingTabindex(container);
    this.restoreGridFocus(previousFocus, container);
  }

  private captureGridFocus(): GridFocus | null {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) return null;
    const card = active.closest<HTMLElement>("[data-app-id]");
    if (!card || !card.closest(".grid-slot")) return null;
    const appId = card.dataset.appId;
    if (!appId) return null;
    const part: GridFocus["part"] = active.classList.contains("fav-btn")
      ? "fav"
      : active.classList.contains("btn")
        ? "action"
        : "open";
    return { appId, part };
  }

  private restoreGridFocus(previous: GridFocus | null, container: HTMLElement): void {
    if (!previous) return;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    const card = Array.from(container.querySelectorAll<HTMLElement>("[data-app-id]")).find(
      (candidate) => candidate.dataset.appId === previous.appId,
    );
    if (!card) return;
    const target = card.querySelector<HTMLElement>(
      previous.part === "fav" ? ".fav-btn" : previous.part === "action" ? ".btn" : ".app-open",
    );
    target?.focus();
  }

  private applyRovingTabindex(container: HTMLElement): void {
    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>(".app-open"));
    buttons.forEach((button, index) => {
      button.tabIndex = index === 0 ? 0 : -1;
    });
    container.addEventListener("focusin", (event) => {
      const target = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>(".app-open");
      if (!target) return;
      for (const button of buttons) button.tabIndex = button === target ? 0 : -1;
    });
    container.addEventListener("keydown", this.onGridKeydown);
  }

  private onGridKeydown = (event: KeyboardEvent): void => {
    const target = event.target as HTMLElement | null;
    const open = target?.closest<HTMLButtonElement>(".app-open");
    if (!open) return;
    const grid = this.nodes.gridSlot.querySelector<HTMLElement>(".app-grid, .app-list");
    if (!grid) return;
    const buttons = Array.from(grid.querySelectorAll<HTMLButtonElement>(".app-open"));
    const index = buttons.indexOf(open);
    if (index < 0) return;
    const columns = this.view === "list" ? 1 : this.gridColumns();
    let nextIndex = -1;
    switch (event.key) {
      case "ArrowRight":
        nextIndex = Math.min(index + 1, buttons.length - 1);
        break;
      case "ArrowLeft":
        nextIndex = Math.max(index - 1, 0);
        break;
      case "ArrowDown":
        nextIndex = Math.min(index + columns, buttons.length - 1);
        break;
      case "ArrowUp":
        nextIndex = Math.max(index - columns, 0);
        break;
      case "Home":
        nextIndex = 0;
        break;
      case "End":
        nextIndex = buttons.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    buttons[nextIndex]?.focus();
  };

  private gridColumns(): number {
    const grid = this.nodes.gridSlot.querySelector<HTMLElement>(".app-grid");
    if (!grid) return 1;
    const template = window.getComputedStyle(grid).gridTemplateColumns;
    return Math.max(1, template.split(" ").filter((part) => part.trim().length > 0).length);
  }

  private skeletonGrid(): HTMLElement {
    return h(
      "div",
      { class: this.view === "grid" ? "app-grid" : "app-list", "aria-hidden": "true" },
      ...Array.from({ length: 8 }, () =>
        this.view === "grid"
          ? h(
              "div",
              { class: "app-card skeleton-card" },
              h("span", { class: "skeleton skeleton-icon" }),
              h(
                "span",
                { class: "skeleton-lines" },
                h("span", { class: "skeleton skeleton-line w60" }),
                h("span", { class: "skeleton skeleton-line w90" }),
                h("span", { class: "skeleton skeleton-line w40" }),
              ),
            )
          : h(
              "div",
              { class: "app-row skeleton-card" },
              h("span", { class: "skeleton skeleton-icon app-icon-sm" }),
              h(
                "span",
                { class: "skeleton-lines" },
                h("span", { class: "skeleton skeleton-line w60" }),
                h("span", { class: "skeleton skeleton-line w40" }),
              ),
            ),
      ),
    );
  }

  private errorState(): HTMLElement {
    return h(
      "div",
      { class: "empty-state", role: "alert" },
      h("span", { class: "empty-icon" }, icon("alert", 26)),
      h("h2", { class: "empty-title" }, "Couldn't load applications"),
      h("p", { class: "empty-detail" }, this.error ?? "The desktop core could not reach your server."),
      h(
        "button",
        { class: "btn primary", type: "button", onclick: () => void this.retryAll() },
        icon("refresh", 14),
        "Try again",
      ),
    );
  }

  private emptyState(): HTMLElement {
    const filter = this.filter;
    const query = this.query.trim();
    let iconName: IconName = "grid";
    let title = "No applications available";
    let detail = "Install applications on your RAST server, then refresh.";
    let action: HTMLButtonElement | null = h(
      "button",
      { class: "btn ghost", type: "button", onclick: () => void this.retryAll() },
      icon("refresh", 14),
      "Refresh",
    );

    if (query) {
      iconName = "search";
      title = `No applications match “${query}”`;
      detail = "Try a different name, or clear the search to see everything.";
      action = h(
        "button",
        {
          class: "btn ghost",
          type: "button",
          onclick: () => {
            this.nodes.search.value = "";
            this.query = "";
            this.renderContentHead();
            this.renderGrid();
            this.nodes.search.focus();
          },
        },
        "Clear search",
      );
    } else {
      switch (filter.kind) {
        case "favorites":
          iconName = "star";
          title = "No favorites yet";
          detail = "Star an application to keep it in this view.";
          action = null;
          break;
        case "recent":
          iconName = "clock";
          title = "Nothing launched yet";
          detail = "Applications you launch appear here, most recent first.";
          action = null;
          break;
        case "running":
          iconName = "activity";
          title = "Nothing running";
          detail = "Launch an application to start a native Xpra session on your server.";
          action = h(
            "button",
            { class: "btn ghost", type: "button", onclick: () => this.setFilter({ kind: "all" }) },
            "Show all applications",
          );
          break;
        case "category":
          iconName = "grid";
          title = `No applications in ${filter.category}`;
          detail = "This category is empty right now.";
          action = null;
          break;
        default:
          break;
      }
    }

    return h(
      "div",
      { class: "empty-state" },
      h("span", { class: "empty-icon" }, icon(iconName, 26)),
      h("h2", { class: "empty-title" }, title),
      h("p", { class: "empty-detail" }, detail),
      action,
    );
  }

  // -- Actions --------------------------------------------------------------

  private async activateApp(app: AppEntry): Promise<void> {
    if (!app.launchable) {
      toast(
        `${app.name} can't be launched from RAST Desktop.`,
        "warning",
        app.warnings[0] ?? undefined,
      );
      return;
    }
    const display = this.runDisplay(app);
    if (app.running && display.state !== "failed" && display.state !== "detached") {
      toast(
        `${app.name} is running — its windows are handled by the native Xpra client.`,
        "info",
        "Use “End” to stop the remote application, or “Detach windows” to close them locally.",
      );
      return;
    }
    await this.launch(app);
  }

  private async launch(app: AppEntry): Promise<void> {
    if (this.launching.has(app.id)) return;
    this.launching.add(app.id);
    this.launchStates.set(app.id, { state: "launching", message: null, attempt: 0 });
    this.renderGrid();
    this.renderRunning();
    this.announce(`Launching ${app.name}…`);
    try {
      const result = await this.bridge.launchApp(app.id);
      for (const warning of result.warnings) toast(warning, "warning");
      this.scheduleInventoryRefresh();
    } catch (error) {
      const err = toBridgeError(error);
      this.launchStates.set(app.id, { state: "failed", message: err.message, attempt: 0 });
      toast(
        `Couldn't launch ${app.name}.`,
        err.code === "xpra_missing" ? "warning" : "error",
        err.message,
      );
      this.announce(`Couldn't launch ${app.name}: ${err.message}`);
    } finally {
      this.launching.delete(app.id);
      this.renderGrid();
      this.renderRunning();
      this.renderBanner();
    }
  }

  private async toggleFavorite(app: AppEntry): Promise<void> {
    const next = !app.favorite;
    app.favorite = next;
    this.renderGrid();
    this.renderSidebar();
    try {
      const result = await this.bridge.setFavorite(app.id, next);
      app.favorite = result.favorite;
      toast(
        result.favorite ? `${app.name} added to favorites.` : `${app.name} removed from favorites.`,
        "info",
      );
    } catch (error) {
      app.favorite = !next;
      toast("Couldn't update favorites.", "error", toBridgeError(error).message);
    }
    this.renderGrid();
    this.renderSidebar();
  }

  // -- Global keyboard ------------------------------------------------------

  private onDocumentKeydown = (event: KeyboardEvent): void => {
    if ((event.metaKey || event.ctrlKey) && event.key === ",") {
      event.preventDefault();
      this.ctx.openSettings();
      return;
    }
    const target = event.target as HTMLElement | null;
    const typing =
      target !== null &&
      (target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.tagName === "SELECT" ||
        target.isContentEditable);
    const dialogOpen = document.querySelector("dialog[open]") !== null;

    if (event.key === "/" && !typing && !dialogOpen) {
      event.preventDefault();
      this.nodes.search.focus();
      this.nodes.search.select();
      return;
    }
    if (event.key === "Escape") {
      if (this.userMenuOpen) {
        this.closeUserMenu();
        this.nodes.userButton.focus();
        return;
      }
      if (target === this.nodes.search) {
        if (this.nodes.search.value) {
          this.nodes.search.value = "";
          this.query = "";
          this.renderContentHead();
          this.renderGrid();
        } else {
          this.nodes.search.blur();
        }
      }
    }
  };
}
