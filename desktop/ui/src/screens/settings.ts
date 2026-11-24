/**
 * Settings dialog.
 *
 * All persistence happens in the Rust core (`get_settings` / `save_settings`);
 * the UI only collects non-sensitive preferences and never stores them itself.
 * Start-at-login is hidden when the core reports it is unsupported (v1).
 */

import type { AppContext } from "../app";
import { toBridgeError } from "../errors";
import type { QualityProfile, Settings, XpraInfo } from "../types";
import { h } from "../ui/dom";
import { hostFromUrl } from "../ui/format";
import { icon, logoMark } from "../ui/icons";
import { openAboutDialog } from "./about";
import { toast } from "../ui/toast";

export function openSettingsDialog(ctx: AppContext): void {
  const client = ctx.getClient();
  let saving = false;
  let signingOut = false;

  const dialog = h("dialog", {
    class: "modal settings-modal",
    "aria-labelledby": "settings-title",
  });

  const close = (): void => {
    if (dialog.open) dialog.close();
    dialog.remove();
  };

  const serverUrl = client.server?.url ?? client.serverUrl ?? "";
  const host = hostFromUrl(serverUrl) || "not configured";
  const user = client.user;
  const displayName = user?.displayName || user?.username || "Signed in";

  // -- Connection ---------------------------------------------------------

  const changeServerButton = h(
    "button",
    {
      class: "btn ghost",
      type: "button",
      onclick: () => {
        close();
        ctx.beginServerChange();
      },
    },
    "Change server…",
  );

  const signOutButton = h(
    "button",
    {
      class: "btn ghost danger-text",
      type: "button",
      onclick: () => {
        if (!signingOut) {
          signingOut = true;
          signOutButton.textContent = "Confirm sign out";
          signOutButton.classList.add("danger");
          return;
        }
        close();
        void ctx.signOut();
      },
    },
    "Sign out",
  );

  const connectionSection = h(
    "section",
    { class: "settings-section" },
    h("h3", { class: "settings-heading" }, "Connection"),
    settingRow(
      "Server",
      `${client.server?.product ?? "RAST"} ${client.server?.version ?? ""} · ${host}`.trim(),
      h("div", { class: "setting-value-inline" }, h("code", { class: "code" }, serverUrl || "—"), changeServerButton),
    ),
    settingRow(
      "Signed in as",
      user ? `${displayName} · @${user.username}${user.role === "admin" ? " · admin" : ""}` : "Not signed in",
      signOutButton,
    ),
  );

  // -- Streaming ----------------------------------------------------------

  const qualityOptions: { value: QualityProfile; title: string; description: string }[] = [
    { value: "balanced", title: "Balanced", description: "Good quality with moderate bandwidth." },
    { value: "responsive", title: "Responsive", description: "Lower latency for interactive work." },
    { value: "high", title: "High", description: "Best image quality, uses more bandwidth." },
  ];

  const qualityGroup = h(
    "fieldset",
    { class: "fieldset" },
    h("legend", { class: "setting-label" }, "Quality profile"),
    h(
      "p",
      { class: "setting-description" },
      "Passed to the native Xpra client for the stream that renders your application windows.",
    ),
    h(
      "div",
      { class: "quality-options", role: "radiogroup", "aria-label": "Quality profile" },
      ...qualityOptions.map((option) =>
        h(
          "label",
          { class: "quality-option" },
          h("input", {
            type: "radio",
            name: "quality",
            value: option.value,
            checked: client.settings.quality === option.value,
          }),
          h(
            "span",
            { class: "quality-option-body" },
            h("span", { class: "quality-option-title" }, option.title),
            h("span", { class: "quality-option-desc" }, option.description),
          ),
        ),
      ),
    ),
  );

  const xpraInfo = client.xpra;
  const xpraStatus = h("div", { class: "xpra-status" });
  const renderXpraStatus = (info: XpraInfo, override?: { valid: boolean; version: string | null; message: string | null; path: string }): void => {
    if (override) {
      xpraStatus.replaceChildren(
        icon(override.valid ? "check" : "alert", 14),
        h(
          "span",
          {},
          override.valid
            ? `${override.path}${override.version ? ` · v${override.version}` : ""}`
            : override.message ?? "That path is not a usable Xpra client.",
        ),
      );
      xpraStatus.dataset.tone = override.valid ? "ok" : "warn";
      return;
    }
    const text =
      info.state === "found"
        ? `${info.path ?? "Xpra.app"}${info.version ? ` · v${info.version}` : ""}`
        : info.message ?? "Xpra client not detected. Install the official client from xpra.org.";
    xpraStatus.replaceChildren(icon(info.state === "found" ? "check" : "alert", 14), h("span", {}, text));
    xpraStatus.dataset.tone = info.state === "found" ? "ok" : "warn";
  };
  renderXpraStatus(xpraInfo);

  const xpraPathInput = h("input", {
    id: "settings-xpra-path",
    class: "input",
    type: "text",
    placeholder: "Auto-detect (recommended)",
    value: client.settings.xpraPath,
    spellcheck: "false",
  });

  const checkPathButton = h(
    "button",
    {
      class: "btn ghost small",
      type: "button",
      onclick: () => {
        const path = xpraPathInput.value.trim();
        checkPathButton.disabled = true;
        checkPathButton.textContent = "Checking…";
        void ctx.bridge
          .checkXpraPath(path)
          .then((result) => {
            renderXpraStatus(xpraInfo, {
              valid: result.valid,
              version: result.version,
              message: result.message,
              path: result.path || path || "(auto-detect)",
            });
          })
          .catch((error) => {
            toast("Couldn't check the Xpra path.", "error", toBridgeError(error).message);
          })
          .finally(() => {
            checkPathButton.disabled = false;
            checkPathButton.textContent = "Check path";
          });
      },
    },
    "Check path",
  );

  const streamingSection = h(
    "section",
    { class: "settings-section" },
    h("h3", { class: "settings-heading" }, "Streaming"),
    qualityGroup,
    switchRow({
      name: "clipboard",
      label: "Clipboard sharing",
      description: "Sync copied text and images both ways with your server session.",
      checked: client.settings.clipboard,
    }),
    switchRow({
      name: "audio",
      label: "Audio",
      description: "Play remote application audio through your Mac.",
      checked: client.settings.audio,
    }),
    settingRow(
      "Xpra client",
      "The official Xpra macOS client renders every application window outside this launcher.",
      h("div", { class: "setting-column" }, xpraStatus, h("div", { class: "setting-value-inline" }, xpraPathInput, checkPathButton)),
    ),
    switchRow({
      name: "detach-on-quit",
      label: "Detach on quit",
      description:
        "Close the native windows when RAST Desktop quits. Remote applications keep running on your server.",
      checked: client.settings.detachOnQuit,
    }),
  );

  // Start-at-login is intentionally hidden while the core reports it unsupported.
  if (client.startAtLogin.supported) {
    streamingSection.append(
      switchRow({
        name: "start-at-login",
        label: "Start at login",
        description: "Open RAST Desktop automatically when you sign in to your Mac.",
        checked: client.startAtLogin.enabled,
      }),
    );
  }

  // -- About --------------------------------------------------------------

  const aboutValues: Record<string, HTMLElement> = {};
  const aboutValue = (key: string, label: string, value: string): HTMLElement => {
    const valueNode = h("span", { class: "about-inline-value" }, value);
    aboutValues[key] = valueNode;
    return h(
      "span",
      { class: "about-inline-item" },
      h("span", { class: "about-inline-label" }, label),
      valueNode,
    );
  };

  const protocolVersion = client.server?.desktop?.protocol ?? null;
  const versionsSection = h(
    "section",
    { class: "settings-section" },
    h("h3", { class: "settings-heading" }, "About"),
    h(
      "div",
      { class: "about-inline" },
      aboutValue("client", "Client", client.clientVersion),
      aboutValue("server", "Server", client.server ? `RAST ${client.server.version}` : "Not connected"),
      aboutValue("protocol", "Protocol", protocolVersion !== null ? `v${protocolVersion}` : "unknown"),
      aboutValue("xpra", "Xpra", xpraInfo.version ?? xpraInfo.state),
    ),
    h(
      "div",
      { class: "about-inline-foot" },
      h(
        "span",
        { class: "settings-note-inline" },
        "Remote windows are rendered by the native Xpra client — never inside this window.",
      ),
      h(
        "button",
        { class: "btn ghost small", type: "button", onclick: () => openAboutDialog(ctx) },
        icon("info", 13),
        "About RAST Desktop",
      ),
    ),
  );

  // -- Save / cancel -------------------------------------------------------

  const saveButton = h(
    "button",
    {
      class: "btn primary",
      type: "submit",
      form: "settings-form",
    },
    "Save changes",
  );

  const form = h(
    "form",
    {
      id: "settings-form",
      class: "settings-form",
      onsubmit: (event) => {
        event.preventDefault();
        if (saving) return;
        const qualityInput = form.querySelector<HTMLInputElement>('input[name="quality"]:checked');
        const quality = (qualityInput?.value ?? client.settings.quality) as QualityProfile;
        const next: Settings = {
          ...client.settings,
          serverUrl: client.settings.serverUrl,
          quality,
          clipboard: (form.querySelector<HTMLInputElement>('input[name="clipboard"]')?.checked ?? true),
          audio: (form.querySelector<HTMLInputElement>('input[name="audio"]')?.checked ?? true),
          xpraPath: xpraPathInput.value.trim(),
          detachOnQuit: form.querySelector<HTMLInputElement>('input[name="detach-on-quit"]')?.checked ?? true,
          startAtLogin: client.startAtLogin.supported
            ? (form.querySelector<HTMLInputElement>('input[name="start-at-login"]')?.checked ??
              client.startAtLogin.enabled)
            : client.settings.startAtLogin,
        };
        saving = true;
        saveButton.disabled = true;
        saveButton.textContent = "Saving…";
        void ctx.bridge
          .saveSettings(next)
          .then(async (saved) => {
            ctx.updateSettings(saved);
            if (client.startAtLogin.supported) {
              try {
                await ctx.bridge.setStartAtLogin(saved.startAtLogin);
              } catch {
                /* the switch is best-effort in v1 */
              }
            }
            toast("Settings saved.", "success");
            close();
          })
          .catch((error) => {
            toast("Couldn't save settings.", "error", toBridgeError(error).message);
            saving = false;
            saveButton.disabled = false;
            saveButton.textContent = "Save changes";
          });
      },
    },
    connectionSection,
    streamingSection,
    versionsSection,
  );

  const closeButton = h(
    "button",
    {
      class: "icon-btn modal-close",
      type: "button",
      "aria-label": "Close settings",
      title: "Close",
      onclick: close,
    },
    icon("x", 17),
  );

  dialog.append(
    h(
      "div",
      { class: "modal-head" },
      h(
        "div",
        { class: "modal-title" },
        h("span", { class: "modal-icon" }, logoMark(22)),
        h("h2", { id: "settings-title" }, "Settings"),
      ),
      closeButton,
    ),
    h("div", { class: "modal-body" }, form),
    h(
      "footer",
      { class: "modal-foot" },
      h(
        "span",
        { class: "modal-foot-note" },
        ctx.bridge.mode === "mock" ? "Mock bridge · demo data (nothing is saved to disk)" : "Preferences are stored by the RAST Desktop core.",
      ),
      h("div", { class: "modal-foot-actions" }, h("button", { class: "btn ghost", type: "button", onclick: close }, "Cancel"), saveButton),
    ),
  );

  dialog.addEventListener("close", () => dialog.remove());
  dialog.addEventListener("cancel", () => dialog.remove());

  document.body.appendChild(dialog);
  dialog.showModal();

  // Fill the authoritative version data asynchronously (the dialog opens instantly).
  void ctx.bridge
    .getVersions()
    .then((loaded) => {
      aboutValues.client!.textContent = loaded.client;
      aboutValues.server!.textContent = loaded.server ? `RAST ${loaded.server}` : "Not connected";
      aboutValues.protocol!.textContent = loaded.protocol !== null ? `v${loaded.protocol}` : "unknown";
      aboutValues.xpra!.textContent = loaded.xpra.version ?? loaded.xpra.state;
    })
    .catch(() => {
      /* keep the values from the client state snapshot */
    });
}

// ---------------------------------------------------------------------------
// Small form building blocks
// ---------------------------------------------------------------------------

function settingRow(label: string, description: string, control: HTMLElement): HTMLElement {
  return h(
    "div",
    { class: "setting-row" },
    h(
      "div",
      { class: "setting-text" },
      h("span", { class: "setting-label" }, label),
      h("span", { class: "setting-description" }, description),
    ),
    h("div", { class: "setting-control" }, control),
  );
}

function switchRow(options: {
  name: string;
  label: string;
  description: string;
  checked: boolean;
}): HTMLElement {
  const id = `settings-${options.name}`;
  const input = h("input", {
    id,
    class: "switch-input",
    type: "checkbox",
    name: options.name,
    checked: options.checked,
  });
  return h(
    "label",
    { class: "switch-row", for: id },
    h(
      "span",
      { class: "setting-text" },
      h("span", { class: "setting-label" }, options.label),
      h("span", { class: "setting-description" }, options.description),
    ),
    input,
    h("span", { class: "switch", "aria-hidden": "true" }),
  );
}
