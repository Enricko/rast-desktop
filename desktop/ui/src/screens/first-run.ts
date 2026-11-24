/**
 * First-run server setup screen.
 *
 * The UI never talks HTTP itself: the URL is handed to the Rust core, which
 * validates it, fetches `/api/bootstrap`, requires the desktop capability and
 * stores it in settings. On success the app moves to the sign-in screen.
 */

import type { AppContext } from "../app";
import { configureServerErrorMessage } from "../errors";
import { h, replace } from "../ui/dom";
import { hostFromUrl, normalizeServerUrl } from "../ui/format";
import { icon, logoMark, wordmark } from "../ui/icons";

export interface FirstRunOptions {
  /** Pre-fill (e.g. the current server when changing servers). */
  prefill?: string;
  /** A notice shown above the form (e.g. "session expired", unsupported server). */
  notice?: string | null;
  /** Show a "Back" action (when reached from settings). */
  cancelable?: boolean;
}

export function renderFirstRun(ctx: AppContext, options: FirstRunOptions = {}): HTMLElement {
  const client = ctx.getClient();
  const credentialLabel =
    client.credentialStore === "keychain" ? "macOS Keychain" : "local development credential store";
  let busy = false;

  const errorBox = h("div", { class: "form-error", role: "alert", hidden: true });
  const errorText = h("span", { class: "form-error-text" });
  errorBox.append(icon("alert", 15), errorText);

  const input = h("input", {
    id: "server-url",
    class: "input",
    type: "url",
    inputmode: "url",
    placeholder: "https://desktop.example.com",
    autocomplete: "url",
    spellcheck: "false",
    value: options.prefill ?? client.serverUrl ?? "",
    "aria-describedby": "server-url-hint",
  });

  const submitButton = h(
    "button",
    { class: "btn primary block auth-submit", type: "submit" },
    "Continue",
  );

  const showError = (message: string): void => {
    errorText.textContent = message;
    errorBox.hidden = false;
  };
  const clearError = (): void => {
    errorBox.hidden = true;
    errorText.textContent = "";
  };
  const setBusy = (value: boolean): void => {
    busy = value;
    input.disabled = value;
    submitButton.disabled = value;
    replace(submitButton, value ? h("span", { class: "spinner" }) : null, value ? "Connecting…" : "Continue");
  };

  const submit = async (): Promise<void> => {
    if (busy) return;
    clearError();
    const normalised = normalizeServerUrl(input.value);
    if ("error" in normalised) {
      showError(normalised.error);
      input.focus();
      return;
    }
    setBusy(true);
    try {
      const server = await ctx.bridge.configureServer(normalised.url);
      if (!server.supported) {
        showError(server.message ?? "This server does not support RAST Desktop yet.");
        setBusy(false);
        return;
      }
      await ctx.handleServerConfigured(server);
    } catch (error) {
      showError(configureServerErrorMessage(error, hostFromUrl(normalised.url)));
      setBusy(false);
      input.focus();
    }
  };

  const form = h(
    "form",
    {
      class: "auth-form",
      novalidate: true,
      onsubmit: (event) => {
        event.preventDefault();
        void submit();
      },
    },
    h("label", { class: "field-label", for: "server-url" }, "Server URL"),
    h(
      "div",
      { class: "input-wrap" },
      icon("server", 15, "input-icon"),
      input,
    ),
    h(
      "p",
      { class: "field-hint", id: "server-url-hint" },
      "The public HTTPS URL of your RAST server — the same host you use in a browser.",
    ),
    errorBox,
    submitButton,
  );

  const backButton = options.cancelable
    ? h(
        "button",
        { class: "link-button", type: "button", onclick: () => ctx.showLauncher() },
        "Back to launcher",
      )
    : null;

  const notice = options.notice
    ? h(
        "div",
        { class: "auth-notice", role: "status" },
        icon("alert", 15),
        h("span", {}, options.notice),
      )
    : null;

  const card = h(
    "main",
    { class: "auth-card", "aria-labelledby": "first-run-title" },
    h("div", { class: "auth-brand" }, h("span", { class: "auth-logo" }, logoMark(30)), wordmark()),
    h("h1", { class: "auth-title", id: "first-run-title" }, "Connect to your server"),
    h(
      "p",
      { class: "auth-lede" },
      "RAST Desktop launches applications that run on your own RAST Linux server. Their windows are delivered by the native Xpra client — never rendered in this window.",
    ),
    notice,
    form,
    h(
      "ul",
      { class: "auth-points" },
      h("li", {}, icon("lock", 15), h("span", {}, "HTTPS only. Your password goes to your server, never to us.")),
      h(
        "li",
        {},
        icon("shield", 15),
        h("span", {}, `Your session is kept in the ${credentialLabel} — never in the WebView.`),
      ),
      h(
        "li",
        {},
        icon("window", 15),
        h("span", {}, "Remote windows are rendered by the native Xpra client, not here."),
      ),
    ),
    h(
      "footer",
      { class: "auth-foot" },
      backButton,
      h("span", { class: "auth-version" }, ctx.bridge.mode === "mock" ? "RAST Desktop · mock bridge (demo data)" : "RAST Desktop"),
    ),
  );

  const screen = h("div", { class: "auth-screen" }, h("div", { class: "auth-glow", "aria-hidden": "true" }), card);

  // Focus the field once mounted so the user can type immediately.
  window.requestAnimationFrame(() => {
    if (!busy) input.focus();
    input.select();
  });

  return screen;
}
