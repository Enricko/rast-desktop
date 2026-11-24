/** Accessible toast notifications (bottom-right, polite live region). */

import { h } from "./dom";
import { icon, type IconName } from "./icons";

export type ToastKind = "info" | "success" | "warning" | "error";

const ICON_BY_KIND: Record<ToastKind, IconName> = {
  info: "info",
  success: "check",
  warning: "alert",
  error: "alert",
};

let stack: HTMLDivElement | null = null;

function ensureStack(): HTMLDivElement {
  if (stack?.isConnected) return stack;
  stack = h("div", {
    class: "toast-stack",
    role: "status",
    "aria-live": "polite",
    "aria-relevant": "additions",
  });
  document.body.appendChild(stack);
  return stack;
}

/**
 * Show a toast. `detail` is optional secondary text (never contains secrets —
 * bridge error messages are already redacted by the core).
 */
export function toast(message: string, kind: ToastKind = "info", detail?: string): void {
  const container = ensureStack();
  const close = (): void => {
    node.classList.add("is-leaving");
    window.setTimeout(() => node.remove(), 180);
  };
  const node = h(
    "div",
    { class: `toast toast-${kind}` },
    icon(ICON_BY_KIND[kind], 16, "toast-icon"),
    h(
      "div",
      { class: "toast-text" },
      h("div", { class: "toast-message" }, message),
      detail ? h("div", { class: "toast-detail" }, detail) : null,
    ),
    h(
      "button",
      { class: "toast-close", type: "button", "aria-label": "Dismiss notification", onclick: close },
      icon("x", 13),
    ),
  );
  container.appendChild(node);
  const timeout = kind === "error" || kind === "warning" ? 9000 : 5200;
  window.setTimeout(close, timeout);
}
