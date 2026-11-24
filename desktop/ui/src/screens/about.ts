/**
 * About dialog: client/server/protocol versions, Xpra client status and the
 * honest statement of how remote application windows are rendered.
 */

import type { AppContext } from "../app";
import { toBridgeError } from "../errors";
import type { ClientState, Versions } from "../types";
import { h } from "../ui/dom";
import { icon, logoMark, wordmark } from "../ui/icons";

function versionRow(label: string, value: string, note?: string): { row: HTMLElement; value: HTMLElement } {
  const valueNode = h("span", { class: "version-value" }, value);
  const row = h(
    "div",
    { class: "version-row" },
    h(
      "span",
      { class: "version-label" },
      label,
      note ? h("span", { class: "version-note" }, note) : null,
    ),
    valueNode,
  );
  return { row, value: valueNode };
}

export function openAboutDialog(ctx: AppContext): void {
  const client: ClientState = ctx.getClient();
  const protocol = client.server?.desktop?.protocol ?? null;

  const clientRow = versionRow("RAST Desktop", client.clientVersion, "launcher UI + core");
  const serverRow = versionRow("Server", client.server ? `RAST ${client.server.version}` : "Not connected");
  const protocolRow = versionRow(
    "Desktop protocol",
    protocol !== null ? `v${protocol}` : "Unknown",
    "stream tokens",
  );
  const xpraRow = versionRow(
    "Xpra client",
    client.xpra.version ?? client.xpra.state,
    "native window host",
  );

  const xpraDetail = h(
    "p",
    { class: "about-detail" },
    client.xpra.state === "found"
      ? `Detected at ${client.xpra.path ?? "an application bundle"}${client.xpra.version ? ` (version ${client.xpra.version})` : ""}.`
      : client.xpra.message ?? "Xpra.app was not detected. Install the official macOS client from xpra.org.",
  );

  const mockNote =
    ctx.bridge.mode === "mock"
      ? h(
          "p",
          { class: "mock-hint about-mock" },
          icon("info", 14),
          h("span", {}, "Mock bridge (demo data): versions and Xpra status are fixtures, no server is contacted."),
        )
      : null;

  const dialog = h("dialog", {
    class: "modal about-modal",
    "aria-labelledby": "about-title",
  });

  const close = (): void => {
    if (dialog.open) dialog.close();
    dialog.remove();
  };

  dialog.append(
    h(
      "div",
      { class: "modal-head" },
      h(
        "div",
        { class: "modal-title" },
        h("span", { class: "modal-icon" }, logoMark(22)),
        h("h2", { id: "about-title" }, "About RAST Desktop"),
      ),
      h(
        "button",
        { class: "icon-btn modal-close", type: "button", "aria-label": "Close about", onclick: close },
        icon("x", 17),
      ),
    ),
    h(
      "div",
      { class: "modal-body about-body" },
      h(
        "div",
        { class: "about-hero" },
        h("span", { class: "about-logo" }, logoMark(40)),
        wordmark("about-wordmark"),
        h("p", { class: "about-tagline" }, "Native macOS windows for applications running on your own RAST server."),
      ),
      h(
        "div",
        { class: "version-table" },
        clientRow.row,
        serverRow.row,
        protocolRow.row,
        xpraRow.row,
      ),
      xpraDetail,
      h(
        "p",
        { class: "about-note" },
        "RAST Desktop is a launcher and window host, not a website wrapper and not a remote-desktop viewer. Remote application pixels are rendered by the official Xpra macOS client in seamless mode — one native window per remote window. Nothing from your server is rendered inside this WebView.",
      ),
      mockNote,
      h(
        "p",
        { class: "about-license" },
        "RAST Desktop is MIT-licensed. The Xpra client is an external GPL-licensed program installed separately by the user.",
      ),
    ),
    h(
      "footer",
      { class: "modal-foot" },
      h("span", { class: "modal-foot-note" }, "Built as part of the RAST project."),
      h(
        "div",
        { class: "modal-foot-actions" },
        h("button", { class: "btn primary", type: "button", onclick: close }, "Close"),
      ),
    ),
  );

  dialog.addEventListener("close", () => dialog.remove());
  dialog.addEventListener("cancel", () => dialog.remove());
  document.body.appendChild(dialog);
  dialog.showModal();

  // Fill the authoritative version payload asynchronously.
  void ctx.bridge
    .getVersions()
    .then((versions: Versions) => {
      clientRow.value.textContent = versions.client;
      serverRow.value.textContent = versions.server ? `RAST ${versions.server}` : "Not connected";
      protocolRow.value.textContent = versions.protocol !== null ? `v${versions.protocol}` : "Unknown";
      xpraRow.value.textContent = versions.xpra.version ?? versions.xpra.state;
    })
    .catch((error) => {
      xpraDetail.textContent = `Version details unavailable: ${toBridgeError(error).message}`;
    });
}
