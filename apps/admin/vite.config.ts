import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src")
    }
  },
  server: {
    port: 5173,
    proxy: {
      "/admin/api": {
        target: "http://localhost:8080",
        changeOrigin: true
      },
      "/v1": {
        target: "http://localhost:8080",
        changeOrigin: true
      },
      "/charts": {
        target: "http://localhost:8080",
        changeOrigin: true
      },
      "/llms.txt": {
        target: "http://localhost:8080",
        changeOrigin: true
      }
    }
  }
});

