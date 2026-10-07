// Builds the production portal App against the counting mock.
// PORTAL_SRC selects which research-portal/src to build (e.g. a worktree of an older revision).
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(root, "../../..");
const modules = path.join(repo, "research-portal/node_modules");
const { defineConfig } = await import(path.join(modules, "vite/dist/node/index.js"));
const { default: react } = await import(path.join(modules, "@vitejs/plugin-react/dist/index.js"));
const source = process.env.PORTAL_SRC ?? path.join(repo, "research-portal/src");
export default defineConfig({
  root,
  base: "./",
  publicDir: false,
  resolve: {
    alias: [
      { find: /^\.\/supabase$/, replacement: path.join(root, "mockSupabase.ts") },
      { find: /^@portal-src\/(.*)$/, replacement: `${source}/$1` },
      { find: /^react(.*)$/, replacement: path.join(modules, "react$1") },
      { find: /^react-dom(.*)$/, replacement: path.join(modules, "react-dom$1") },
      { find: /^lucide-react$/, replacement: path.join(modules, "lucide-react") },
      { find: /^@supabase\/supabase-js$/, replacement: path.join(modules, "@supabase/supabase-js") },
    ],
  },
  plugins: [react()],
  build: { outDir: process.env.LAB_OUT ?? path.join(root, "dist"), emptyOutDir: true },
});
