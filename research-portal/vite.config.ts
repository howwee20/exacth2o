import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "./",
  publicDir: false,
  build: {
    outDir: "../portal-app",
    emptyOutDir: true,
    // One stylesheet (assets/portal.css) even though features load on demand.
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        // A content-hashed entry: lazily loaded chunks import the entry by file name, so the page
        // must load it under exactly that URL (a "?v=" query would make it a second module instance).
        entryFileNames: "assets/portal-[hash].js",
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
