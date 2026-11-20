import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In development the API runs on :8080 (uvicorn); in the container FastAPI serves
// the built files itself, so the browser always talks to one origin.
// RETRAINIX_API_TARGET points the dev server at another local API (default: the one on :8080).
// Read through globalThis so the project needs no Node type package just for this line.
const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
const apiTarget = env.RETRAINIX_API_TARGET ?? "http://localhost:8080";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": apiTarget,
    },
  },
});
