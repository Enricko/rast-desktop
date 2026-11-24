import { defineConfig } from "vite";

// The built bundle is loaded by the Tauri WebView through a custom protocol, so
// asset URLs must stay relative. `dist/` is the directory tauri.conf.json points
// frontendDist at.
export default defineConfig({
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    sourcemap: false,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
