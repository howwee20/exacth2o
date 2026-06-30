import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "./",
  build: {
    outDir: "../portal-app",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        entryFileNames: "assets/portal.js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: (assetInfo) => {
          if (assetInfo.name?.endsWith(".css")) return "assets/portal.css";
          return "assets/[name][extname]";
        },
      },
    },
  },
  plugins: [react()],
});
