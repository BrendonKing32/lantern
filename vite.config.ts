import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `npm run dev` gives hot reload for the UI and forwards /api to `npm run dev:api`.
export default defineConfig({
  plugins: [react()],
  build: { chunkSizeWarningLimit: 1200 },
  server: {
    proxy: { "/api": "http://localhost:8787" },
  },
});
