/**
 * Sign-in screen. The password is passed once to the Rust core; the UI never
 * stores it, logs it or persists anything itself. `Remember me` asks the core
 * to keep the session cookie in the macOS Keychain.
 */

import type { AppContext } from "../app";
import { loginErrorMessage } from "../errors";
import { h, replace } from "../ui/dom";
import { hostFromUrl } from "../ui/format";
import { icon, logoMark, wordmark } from "../ui/icons";

export function renderLogin(ctx: AppContext, notice?: string | null): HTMLElement {
  const client = ctx.getClient();
  const host = hostFromUrl(client.server?.url ?? client.serverUrl);
  const isMock = ctx.bridge.mode === "mock";
  let busy = false;

  const errorBox = h("div", { class: "form-error", role: "alert", hidden: true });
  const errorText = h("span", { class: "form-error-text" });
  errorBox.append(icon("alert", 15), errorText);

  const username = h("input", {
    id: "login-username",
    class: "input",
    type: "text",
    name: "username",
    autocomplete: "username",
    autocapitalize: "none",
    spellcheck: "false",
    required: true,
    "aria-describedby": "login-remember-hint",
  });

  const password = h("input", {
    id: "login-password",
    class: "input",
    type: "password",
    name: "password",
    autocomplete: "current-password",
    required: true,
  });

  const revealButton = h(
    "button",
    {
      class: "input-action",
      type: "button",
      "aria-label": "Show password",
      title: "Show password",
      onclick: () => {
        const show = password.type === "password";
        password.type = show ? "text" : "password";
        revealButton.replaceChildren(icon(show ? "eye-off" : "eye", 16));
        revealButton.setAttribute("aria-label", show ? "Hide password" : "Show password");
      },
    },
    icon("eye", 16),
  );

  const remember = h("input", {
    type: "checkbox",
    name: "remember",
    class: "checkbox",
    checked: true,
    "aria-describedby": "login-remember-hint",
  });

  const submitButton = h("button", { class: "btn primary block auth-submit", type: "submit" }, "Sign in");

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
    username.disabled = value;
    password.disabled = value;
    remember.disabled = value;
    submitButton.disabled = value;
    replace(submitButton, value ? h("span", { class: "spinner" }) : null, value ? "Signing in…" : "Sign in");
  };

  const submit = async (): Promise<void> => {
    if (busy) return;
    clearError();
    if (!username.value.trim()) {
      showError("Enter your username.");
      username.focus();
      return;
    }
    if (!password.value) {
      showError("Enter your password.");
      password.focus();
      return;
    }
    setBusy(true);
    try {
      const result = await ctx.bridge.login(username.value.trim(), password.value, remember.checked);
      await ctx.handleSignedIn(result);
    } catch (error) {
      showError(loginErrorMessage(error, host));
      setBusy(false);
      password.select();
    }
  };

  const noticeBox = notice
    ? h("div", { class: "auth-notice", role: "status" }, icon("info", 15), h("span", {}, notice))
    : null;

  const serverChip = h(
    "div",
    { class: "server-chip", title: client.server?.url ?? client.serverUrl ?? "" },
    icon("server", 14),
    h("span", { class: "server-chip-host" }, host || "No server configured"),
    client.server
      ? h("span", { class: "badge" }, `RAST ${client.server.version}`)
      : null,
  );

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
    h("label", { class: "field-label", for: "login-username" }, "Username"),
    h("div", { class: "input-wrap" }, icon("user", 15, "input-icon"), username),
    h(
      "div",
      { class: "field-label-row" },
      h("label", { class: "field-label", for: "login-password" }, "Password"),
    ),
    h("div", { class: "input-wrap has-action" }, icon("lock", 15, "input-icon"), password, revealButton),
    errorBox,
    h(
      "label",
      { class: "check-row" },
      remember,
      h("span", { class: "check-text" }, "Remember me"),
    ),
    h(
      "p",
      { class: "field-hint", id: "login-remember-hint" },
      "Keeps your session in the macOS Keychain. Your password is never stored.",
    ),
    submitButton,
  );

  const card = h(
    "main",
    { class: "auth-card auth-card-narrow", "aria-labelledby": "login-title" },
    h("div", { class: "auth-brand" }, h("span", { class: "auth-logo" }, logoMark(30)), wordmark()),
    serverChip,
    h("h1", { class: "auth-title", id: "login-title" }, "Sign in"),
    h("p", { class: "auth-lede" }, "Use your RAST account. The password is sent only to your server."),
    noticeBox,
    form,
    isMock
      ? h(
          "p",
          { class: "mock-hint" },
          icon("info", 14),
          h(
            "span",
            {},
            "Preview mode: the mock bridge signs in with any username and a password of 4+ characters. Try “change-me” or “rate-limited” to see error handling.",
          ),
        )
      : null,
    h(
      "footer",
      { class: "auth-foot" },
      h(
        "button",
        {
          class: "link-button",
          type: "button",
          onclick: () => ctx.showFirstRun({ prefill: client.serverUrl ?? "", cancelable: false }),
        },
        "Use a different server",
      ),
      h("span", { class: "auth-version" }, isMock ? "Mock bridge (demo data)" : "RAST Desktop"),
    ),
  );

  const screen = h("div", { class: "auth-screen" }, h("div", { class: "auth-glow", "aria-hidden": "true" }), card);

  window.requestAnimationFrame(() => {
    if (!busy) username.focus();
  });

  return screen;
}
