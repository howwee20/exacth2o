import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "./",
  publicDir: false,
  build: {
    outDir: "../portal-app",
    emptyOutDir: true,
    // The entry's stylesheet is assets/portal.css; a feature that imports its own stylesheet
    // (Web Analytics) gets a hashed CSS file loaded together with its chunk.
    cssCodeSplit: true,
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
          const names = assetInfo.names ?? [];
          if (names.some((name) => name.endsWith(".css"))) {
            return names.includes("index.css") ? "assets/portal.css" : "assets/[name]-[hash][extname]";
          }
          return "assets/[name][extname]";
        },
      },
    },
  },
  plugins: [react()],
});
