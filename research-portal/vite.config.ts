import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "./",
  publicDir: false,
  build: {
    outDir: "../portal-app",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        entryFileNames: "assets/portal.js",
        chunkFileNames: "assets/[name]-[hash].js",
        manualChunks: {
          "react-vendor": ["react", "react-dom", "react-dom/client", "react/jsx-runtime", "scheduler"],
          "supabase-vendor": ["@supabase/supabase-js"],
          "icon-vendor": ["lucide-react"],
        },
        assetFileNames: (assetInfo) => {
          if (assetInfo.name?.endsWith(".css")) return "assets/portal.css";
          return "assets/[name][extname]";
        },
      },
    },
  },
  plugins: [react()],
});
