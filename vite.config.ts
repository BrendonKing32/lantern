import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `npm run dev` gives hot reload for the UI and forwards /api to `npm run dev:api`.
export default defineConfig({
  plugins: [react()],
  build: { chunkSizeWarningLimit: 1200 },
  // Harper finds its WebAssembly file relative to its own module, which
  // pre-bundling would break in dev.
  optimizeDeps: { exclude: ["harper.js"] },
  server: {
    proxy: { "/api": "http://localhost:8787" },
  },
  // Worker tests run in Node, where `cloudflare:workers` doesn't exist.
  test: {
    alias: { "cloudflare:workers": fileURLToPath(new URL("./test/cloudflare-workers.ts", import.meta.url)) },
    server: { deps: { inline: ["@cloudflare/workers-oauth-provider"] } },
  },
});
