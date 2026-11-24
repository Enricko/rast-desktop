/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "1" forces the browser mock bridge even if Tauri globals are shimmed. */
  readonly VITE_RAST_MOCK?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
