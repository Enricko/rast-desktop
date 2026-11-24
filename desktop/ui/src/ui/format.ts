/** Small formatting helpers shared by screens. */

/** `https://desktop.example.com/` -> `desktop.example.com` */
export function hostFromUrl(url: string | null | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).host;
  } catch {
    return url.replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
  }
}

/** Pluralise a simple English noun. */
export function plural(count: number, singular: string, pluralForm?: string): string {
  return count === 1 ? singular : (pluralForm ?? `${singular}s`);
}

/** "just now", "3 min ago", "2 h ago", "Yesterday", "12 Nov". */
export function relativeTime(timestamp: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - timestamp);
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} d ago`;
  return new Date(timestamp).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/** Initials for the user avatar, e.g. "Test Alice" -> "TA". */
export function initials(name: string, fallback = "?"): string {
  const parts = name
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return fallback;
  const first = parts[0]?.charAt(0) ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1]?.charAt(0) ?? "") : "";
  return (first + last).toUpperCase() || fallback;
}

/** Deterministic positive integer hash, used for fallback icon tints. */
export function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

/** "24 ms" / "1.2 s" */
export function formatLatency(ms: number | undefined): string {
  if (ms === undefined || Number.isNaN(ms)) return "";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

/** Normalise user-typed server URL to `https://host[:port][/path]`. */
export function normalizeServerUrl(input: string): { url: string } | { error: string } {
  const raw = input.trim();
  if (!raw) return { error: "Enter your server URL." };
  if (/^http:\/\//i.test(raw)) {
    return { error: "HTTPS is required. Use an https:// URL." };
  }
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return { error: "That doesn't look like a valid URL." };
  }
  if (parsed.protocol !== "https:") {
    return { error: "HTTPS is required. Use an https:// URL." };
  }
  if (!parsed.hostname || !parsed.hostname.includes(".")) {
    if (parsed.hostname !== "localhost") {
      return { error: "Enter the full server hostname, e.g. desktop.example.com." };
    }
  }
  if (parsed.username || parsed.password) {
    return { error: "Remove credentials from the URL — sign in on the next step." };
  }
  const path = parsed.pathname.replace(/\/+$/, "");
  return { url: `${parsed.origin}${path}` };
}

/**
 * Fuzzy match score for launcher search. Returns -1 for "no match", otherwise
 * a score where higher is better (exact > prefix > substring > subsequence),
 * with shorter strings and fewer gaps ranking slightly higher.
 */
export function fuzzyScore(query: string, text: string): number {
  const q = query.trim().toLowerCase();
  const t = text.toLowerCase();
  if (!q) return 0;
  if (t === q) return 1000;
  if (t.startsWith(q)) return 900 - t.length * 0.5;
  const index = t.indexOf(q);
  if (index >= 0) return 800 - index * 2 - t.length * 0.25;
  // Subsequence match (e.g. "vsc" -> "VS Code").
  let textIndex = 0;
  let gaps = 0;
  let lastMatch = -1;
  for (const character of q) {
    const found = t.indexOf(character, textIndex);
    if (found === -1) return -1;
    if (lastMatch >= 0) gaps += found - lastMatch - 1;
    lastMatch = found;
    textIndex = found + 1;
  }
  if (gaps > 8) return -1;
  return 500 - gaps * 6 - t.length * 0.5;
}
