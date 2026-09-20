# Applications portal preview

The public Applications page embeds this separately built preview. It imports the production React App and CSS directly from `research-portal/src`; it does not maintain a second set of experiment, observation, chamber, or health screens.

Build from the repository root:

```sh
npm ci --prefix research-portal
node research-portal/node_modules/vite/bin/vite.js build --config applications-preview/vite.config.mjs
```

The Vite preview-only transform supplies in-memory fixture state, removes App's authentication and network refresh effects, and omits the internal support and chamber-control tiles. Production source files and the portal build are unchanged. `offline.ts` replaces the Supabase module only in this build; supported actions update in-memory samples and unsupported actions return a clear error. The embedded page also uses `connect-src 'none'`.

The overview uses fixed tiles in a compact layout with animated connections to System Health. The layout scales to the available viewport; opening a tile renders the production detail view at its normal size. The preview enables the four-graph overview only for Experiment 1; the other experiment views use one graph. Regenerate and verify this build when changing shared portal components.
