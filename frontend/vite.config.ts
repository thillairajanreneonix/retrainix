import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In development the API runs on :8080 (uvicorn); in the container FastAPI serves
// the built files itself, so the browser always talks to one origin.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:8080",
    },
  },
});
