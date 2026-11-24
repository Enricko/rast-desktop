/**
 * Bridge errors.
 *
 * The Rust core rejects `invoke` promises with a structured object:
 *   { code, message, action? }
 * The mock bridge throws `BridgeError` with the same codes. The UI normalises
 * everything it catches to a `BridgeError` and branches on `code` only.
 *
 * Codes are exactly the ones listed in desktop/UI-CONTRACT.md.
 */

export type ErrorCode =
  | "invalid_input"
  | "invalid_url"
  | "not_signed_in"
  | "unauthorized"
  | "forbidden"
  | "password_change_required"
  | "rate_limited"
  | "conflict"
  | "not_found"
  | "no_session"
  | "no_run"
  | "network"
  | "unsupported_server"
  | "unsupported_client_version"
  | "xpra_missing"
  | "unsupported"
  | "internal";

export type ErrorAction = "login" | "configure_server" | "install_xpra" | "retry";

const ERROR_CODES: ReadonlySet<string> = new Set<ErrorCode>([
  "invalid_input",
  "invalid_url",
  "not_signed_in",
  "unauthorized",
  "forbidden",
  "password_change_required",
  "rate_limited",
  "conflict",
  "not_found",
  "no_session",
  "no_run",
  "network",
  "unsupported_server",
  "unsupported_client_version",
  "xpra_missing",
  "unsupported",
  "internal",
]);

export class BridgeError extends Error {
  readonly code: ErrorCode;
  readonly action: ErrorAction | null;

  constructor(code: ErrorCode, message?: string, action?: ErrorAction | null) {
    super(message ?? code);
    this.name = "BridgeError";
    this.code = code;
    this.action = action ?? null;
  }
}

/** Normalise anything thrown by the bridge (or Tauri) into a BridgeError. */
export function toBridgeError(error: unknown): BridgeError {
  if (error instanceof BridgeError) return error;

  // Contract shape: { code, message, action? }
  if (error && typeof error === "object") {
    const candidate = error as { code?: unknown; message?: unknown; action?: unknown };
    if (typeof candidate.code === "string" && ERROR_CODES.has(candidate.code)) {
      const message = typeof candidate.message === "string" ? candidate.message : candidate.code;
      const action =
        candidate.action === "login" ||
        candidate.action === "configure_server" ||
        candidate.action === "install_xpra" ||
        candidate.action === "retry"
          ? candidate.action
          : null;
      return new BridgeError(candidate.code as ErrorCode, message, action);
    }
  }

  // Unexpected transport/Tauri failures: classify best-effort, never leak.
  const raw =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : "";
  const lower = raw.toLowerCase();

  if (/password change required/.test(lower)) {
    return new BridgeError("password_change_required", raw || "Password change required");
  }
  if (/unauthorized|not signed in|session expired|\b401\b/.test(lower)) {
    return new BridgeError("unauthorized", raw || "Not signed in");
  }
  if (/forbidden|\b403\b/.test(lower)) {
    return new BridgeError("forbidden", raw || "Forbidden");
  }
  if (/rate limit|too many requests|\b429\b/.test(lower)) {
    return new BridgeError("rate_limited", raw || "Rate limited");
  }
  if (/unsupported client|client version/.test(lower)) {
    return new BridgeError("unsupported_client_version", raw || "This client is too old");
  }
  if (/unsupported server|does not support|stream token/.test(lower)) {
    return new BridgeError("unsupported_server", raw || "Unsupported server");
  }
  if (/xpra/.test(lower) && /missing|not found|install/.test(lower)) {
    return new BridgeError("xpra_missing", raw || "Xpra not found", "install_xpra");
  }
  if (/network|unreachable|timeout|timed out|connection refused|dns|tls|certificate|offline/.test(lower)) {
    return new BridgeError("network", raw || "Network error");
  }
  return new BridgeError("internal", raw || "Something went wrong.");
}

/** True when the core says the user must sign in again. */
export function isAuthError(error: unknown): boolean {
  const code = toBridgeError(error).code;
  return code === "unauthorized" || code === "not_signed_in";
}

/** True when the failure means the server needs a newer RAST release. */
export function isUnsupportedServerError(error: unknown): boolean {
  return toBridgeError(error).code === "unsupported_server";
}

/** Human message for the first-run / server-configuration screen. */
export function configureServerErrorMessage(error: unknown, host: string): string {
  const err = toBridgeError(error);
  switch (err.code) {
    case "invalid_url":
    case "invalid_input":
      return err.message;
    case "network":
      return `Couldn't reach ${host || "that server"}. Check the URL and your internet connection.`;
    case "unsupported_server":
      return (
        err.message ||
        "This RAST server does not support RAST Desktop yet. It needs a RAST release with the desktop stream-token broker (see docs/PROTOCOL.md)."
      );
    case "unsupported_client_version":
      return err.message || "This RAST Desktop client is too old for that server. Update RAST Desktop.";
    default:
      return err.message || "Connection failed. Try again.";
  }
}

/** Human message for the sign-in screen. */
export function loginErrorMessage(error: unknown, host: string): string {
  const err = toBridgeError(error);
  switch (err.code) {
    case "unauthorized":
    case "not_signed_in":
      return "Incorrect username or password.";
    case "password_change_required":
      return (
        err.message ||
        "This account must change its password in the RAST web interface before it can sign in here."
      );
    case "forbidden":
      return err.message || "This account is not allowed to sign in.";
    case "rate_limited":
      return err.message || "Too many sign-in attempts. Wait a minute and try again.";
    case "network":
      return `Can't reach ${host || "the server"}. Check your connection and try again.`;
    case "unsupported_server":
      return err.message || "This server does not support RAST Desktop yet.";
    case "unsupported_client_version":
      return err.message || "This RAST Desktop client is too old for that server.";
    default:
      return err.message || "Sign-in failed. Try again.";
  }
}
