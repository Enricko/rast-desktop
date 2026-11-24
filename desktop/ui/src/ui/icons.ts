/**
 * Inline SVG icon set (hand-authored 24×24 strokes, no icon-font dependency).
 * All icons inherit `currentColor` and are decorative unless the caller adds an
 * accessible label on the surrounding button.
 */

export type IconName =
  | "search"
  | "settings"
  | "star"
  | "star-filled"
  | "play"
  | "stop"
  | "x"
  | "chevron-down"
  | "check"
  | "refresh"
  | "window"
  | "server"
  | "user"
  | "info"
  | "grid"
  | "list"
  | "clock"
  | "activity"
  | "logout"
  | "eye"
  | "eye-off"
  | "alert"
  | "lock"
  | "wifi-off"
  | "clipboard"
  | "volume"
  | "monitor"
  | "keyboard"
  | "shield"
  | "install";

interface IconDef {
  /** Inner SVG markup, authored here (never user input). */
  d: string;
  filled?: boolean;
}

const ICONS: Record<IconName, IconDef> = {
  search: { d: '<circle cx="11" cy="11" r="7"/><path d="m16.5 16.5 4.5 4.5"/>' },
  settings: {
    d: '<path d="M4 6h9M17 6h3M4 12h4M12 12h8M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
  },
  star: {
    d: '<path d="M12 3.6l2.6 5.3 5.9.86-4.27 4.16 1.01 5.86L12 17l-5.24 2.78 1.01-5.86L3.5 9.76l5.9-.86z"/>',
  },
  "star-filled": {
    d: '<path d="M12 3.6l2.6 5.3 5.9.86-4.27 4.16 1.01 5.86L12 17l-5.24 2.78 1.01-5.86L3.5 9.76l5.9-.86z"/>',
    filled: true,
  },
  play: { d: '<path d="M8.5 5.6v12.8L19 12z"/>', filled: true },
  stop: { d: '<rect x="7" y="7" width="10" height="10" rx="1.6"/>', filled: true },
  x: { d: '<path d="M6 6l12 12M18 6 6 18"/>' },
  "chevron-down": { d: '<path d="m6.5 9.5 5.5 5.5 5.5-5.5"/>' },
  check: { d: '<path d="m5 12.5 4.5 4.5L19 7.5"/>' },
  refresh: { d: '<path d="M20 8.5A8 8 0 1 0 20.8 12"/><path d="M21 3.5v5h-5"/>' },
  window: { d: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.2"/><path d="M3.5 9.2h17"/>' },
  server: {
    d: '<rect x="3.5" y="4" width="17" height="7" rx="2"/><rect x="3.5" y="13" width="17" height="7" rx="2"/><path d="M7.5 7.5h.01M7.5 16.5h.01"/>',
  },
  user: { d: '<circle cx="12" cy="8" r="3.8"/><path d="M4.8 20a7.4 7.4 0 0 1 14.4 0"/>' },
  info: { d: '<circle cx="12" cy="12" r="8.6"/><path d="M12 11v5M12 7.9h.01"/>' },
  grid: {
    d: '<rect x="4" y="4" width="6.6" height="6.6" rx="1.5"/><rect x="13.4" y="4" width="6.6" height="6.6" rx="1.5"/><rect x="4" y="13.4" width="6.6" height="6.6" rx="1.5"/><rect x="13.4" y="13.4" width="6.6" height="6.6" rx="1.5"/>',
  },
  list: { d: '<path d="M8.5 6h11.5M8.5 12h11.5M8.5 18h11.5"/><path d="M4.2 6h.01M4.2 12h.01M4.2 18h.01"/>' },
  clock: { d: '<circle cx="12" cy="12" r="8.6"/><path d="M12 7.2V12l3.3 2"/>' },
  activity: { d: '<path d="M3 12h3.8l2.4-5.8 3.9 11.6 2.4-5.8H21"/>' },
  logout: {
    d: '<path d="M9 4H5.6A1.6 1.6 0 0 0 4 5.6v12.8A1.6 1.6 0 0 0 5.6 20H9"/><path d="M15 8l4 4-4 4M19 12H9"/>',
  },
  eye: {
    d: '<path d="M2.6 12S6.2 5.8 12 5.8 21.4 12 21.4 12 17.8 18.2 12 18.2 2.6 12 2.6 12z"/><circle cx="12" cy="12" r="2.9"/>',
  },
  "eye-off": {
    d: '<path d="M3 3l18 18"/><path d="M10.6 6.15A9.9 9.9 0 0 1 12 6c5.8 0 9.4 6 9.4 6a17.2 17.2 0 0 1-3.2 3.9M6.2 7.9A17.3 17.3 0 0 0 2.6 12S6.2 18 12 18a9.8 9.8 0 0 0 3.2-.5"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  },
  alert: { d: '<path d="M12 3.6 21 19H3z"/><path d="M12 9.4v4.2M12 16.4h.01"/>' },
  lock: {
    d: '<rect x="5" y="10.4" width="14" height="10" rx="2.2"/><path d="M8.5 10.4V7.6a3.5 3.5 0 0 1 7 0v2.8"/>',
  },
  "wifi-off": {
    d: '<path d="M3 3l18 18"/><path d="M8.4 15.6a5 5 0 0 1 7.2 0"/><path d="M5.2 11.9a10 10 0 0 1 3.7-2.3M15.4 9.5a10 10 0 0 1 3.4 2.1"/><path d="M12 19h.01"/>',
  },
  clipboard: {
    d: '<rect x="6" y="4.6" width="12" height="15.8" rx="2"/><path d="M9.4 4.6V3h5.2v1.6"/><path d="M9 10h6M9 13.4h6M9 16.8h4"/>',
  },
  volume: {
    d: '<path d="M4 9.4h3.1L11.7 5v14L7.1 14.6H4z"/><path d="M16 8.6a5 5 0 0 1 0 6.8M18.5 6.2a8.3 8.3 0 0 1 0 11.6"/>',
  },
  monitor: { d: '<rect x="3" y="4" width="18" height="12.4" rx="2"/><path d="M9 20.6h6M12 16.4v4.2"/>' },
  keyboard: {
    d: '<rect x="2.6" y="6" width="18.8" height="12" rx="2"/><path d="M6.4 10h.01M9.8 10h.01M13.2 10h.01M16.6 10h.01M6.4 14h.01M10 14h4M16.6 14h.01"/>',
  },
  shield: { d: '<path d="M12 3 20 6v6c0 4.6-3.2 7.9-8 9-4.8-1.1-8-4.4-8-9V6z"/>' },
  install: { d: '<path d="M12 4v10.2M8 10.6l4 4 4-4"/><path d="M4 19.6h16"/>' },
};

/**
 * Build an icon `<span>` (inline SVG). Decorative by default: pass
 * `label` when the icon is the only content of an interactive control.
 */
export function icon(name: IconName, size = 16, className?: string): HTMLSpanElement {
  const def = ICONS[name];
  const span = document.createElement("span");
  span.className = className ? `icon ${className}` : "icon";
  span.setAttribute("aria-hidden", "true");
  span.innerHTML = `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="${
    def.filled ? "currentColor" : "none"
  }" stroke="${def.filled ? "none" : "currentColor"}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${def.d}</svg>`;
  return span;
}

/** RAST hex logomark (same geometry as the web client favicon). */
export function logoMark(size = 26, className?: string): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = className ? `logo-mark ${className}` : "logo-mark";
  span.setAttribute("aria-hidden", "true");
  span.innerHTML = `<svg viewBox="0 0 32 32" width="${size}" height="${size}" fill="none">
    <path d="M16 3 27 9.5v13L16 29 5 22.5v-13z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
    <path d="M16 10.4 21.7 13.7v6.6L16 23.6 10.3 20.3v-6.6z" fill="currentColor"/>
  </svg>`;
  return span;
}

/** RAST Desktop wordmark used in headers and auth screens. */
export function wordmark(className?: string): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = className ? `wordmark ${className}` : "wordmark";
  span.innerHTML = '<span class="wordmark-name">RAST</span><span class="wordmark-suffix">Desktop</span>';
  return span;
}

/**
 * Generated fallback app icon (data: URL) for applications whose icon could not
 * be fetched by the core. Uses the app's initial and the UI accent colour.
 */
export function fallbackAppIcon(name: string): string {
  const letter = (name.trim().charAt(0) || "?").toUpperCase().replace(/[<>&"']/g, "");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" width="96" height="96"><rect width="96" height="96" rx="21" fill="#2b3642"/><text x="48" y="62" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="42" font-weight="700" fill="#7cb3f4">${letter}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
