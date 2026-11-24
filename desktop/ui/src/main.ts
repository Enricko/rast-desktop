/**
 * RAST Desktop launcher UI entry point.
 * The bundle is loaded by the Tauri WebView; in a plain browser the mock bridge
 * is selected automatically so the same build can be screenshot-tested.
 */

import "./styles.css";
import { App } from "./app";
import { createBridge } from "./bridge";

async function main(): Promise<void> {
  // Stable rendering for the headless screenshot harness: no animations.
  if (new URLSearchParams(window.location.search).get("capture") === "1") {
    document.documentElement.dataset.capture = "1";
  }

  const root = document.getElementById("root");
  if (!root) throw new Error("RAST Desktop: #root element is missing");

  const bridge = await createBridge();
  const app = new App(root, bridge);
  await app.start();
}

void main().catch((error: unknown) => {
  // Last-resort boot failure; the app normally renders its own fatal screen.
  console.error("RAST Desktop failed to start", error);
  const root = document.getElementById("root");
  if (!root) return;
  const container = document.createElement("div");
  container.className = "auth-screen";
  container.innerHTML = "";
  const card = document.createElement("main");
  card.className = "auth-card";
  const title = document.createElement("h1");
  title.className = "auth-title";
  title.textContent = "RAST Desktop couldn't start";
  const detail = document.createElement("p");
  detail.className = "auth-lede";
  detail.textContent = error instanceof Error ? error.message : "Unknown startup error.";
  card.append(title, detail);
  container.append(card);
  root.replaceChildren(container);
});
