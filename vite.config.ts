/// <reference types="vitest/config" />
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import tailwindcss from "@tailwindcss/vite"
import { TanStackRouterVite } from "@tanstack/router-plugin/vite"
import react from "@vitejs/plugin-react"
import jotaiDebugLabel from "jotai/babel/plugin-debug-label"
import jotaiReactRefresh from "jotai/babel/plugin-react-refresh"
import { visualizer } from "rollup-plugin-visualizer"
import type { PluginOption } from "vite"
import { defineConfig } from "vite"
import { nodePolyfills } from "vite-plugin-node-polyfills"
import { VitePWA } from "vite-plugin-pwa"
import { defaultExclude } from "vitest/config"

/**
 * What build of the changelog this is, as `<newest week>.<hash>`.
 *
 * The dialog after an update shows the releases a reader has not seen, which
 * needs a stamp it can compare against the one it stored last time. The week
 * is what the comparison is made on — it says which releases are new — and the
 * hash is there so that two builds in the same week are not mistaken for one,
 * which would leave the stamp stale until the following Monday.
 */
function changelogVersion(): string {
  const source = readFileSync("CHANGELOG.md", "utf8")
  const week = /^## (\d{4}-W\d{2})\s*$/m.exec(source)?.[1] ?? "0000-W00"
  return `${week}.${createHash("sha256").update(source).digest("hex").slice(0, 8)}`
}

// https://vitejs.dev/config/
export default defineConfig({
  // A string small enough to sit in the app bundle, so the dialog can decide
  // whether it has anything to show before fetching the changelog itself.
  define: { __CHANGELOG_VERSION__: JSON.stringify(changelogVersion()) },
  test: {
    // Keep vitest out of transient agent worktrees (checked out under
    // `.claude/worktrees/` by Claude Code sessions), which otherwise get
    // scanned as duplicate test trees without their own node_modules.
    exclude: [...defaultExclude, "**/.claude/**"],
    // Replaces Node's broken experimental `localStorage` global (see file).
    setupFiles: ["./src/vitest.setup.ts"],
  },
  plugins: [
    tailwindcss(),
    TanStackRouterVite(),
    react({ babel: { plugins: [jotaiDebugLabel, jotaiReactRefresh] } }),
    // The bundle treemap is a local diagnostic, so it is written to the repo
    // root (gitignored) rather than `dist/`: anything in `dist/` is deployed
    // as a Worker asset, matched by the precache `globPatterns` below, and —
    // being revisioned rather than content-hashed — re-downloaded by every
    // service worker install, which is ~700KB of the wait before
    // "Update Ruminate" can appear.
    visualizer({ filename: "stats.html" }) as unknown as PluginOption,
    VitePWA({
      strategies: "generateSW",
      registerType: "prompt",
      injectRegister: "auto",
      manifest: {
        name: "Ruminate",
        short_name: "Ruminate",
        description: "A block-based note-taking app for better thinking",
        theme_color: "#000000",
        background_color: "#000000",
        icons: [
          {
            src: "icon-1024.png",
            sizes: "1024x1024",
            type: "image/png",
          },
        ],
        start_url: "/",
        display: "standalone",
      },
      workbox: {
        globPatterns: ["**/*.{html,css,js,woff2}"],
        // The experimental SQL store's worker chunk (plus the sqlite wasm it
        // fetches) is only loaded when the storage flag is on — keep it out of
        // the precache so flag-off users never download it.
        globIgnores: ["**/sql-worker-*.js", "**/sqlite3-*.js"],
        ignoreURLParametersMatching: [/^utm_/, /^fbclid$/],
        // No `skipWaiting` here: with registerType "prompt" the new service
        // worker must *wait* until the user clicks "Update Ruminate", which
        // posts SKIP_WAITING to the waiting worker and reloads. Auto-skipping
        // would activate the worker on install, leaving nothing for the button
        // to message — so the button would appear to do nothing.
        navigateFallback: "index.html",
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024, // 5MB
        sourcemap: true,
        // Do not cache function routes
        navigateFallbackDenylist: [/cors-proxy/, /file-proxy/, /git-lfs-file/, /github-auth/],
      },
      devOptions: {
        enabled: process.env.NODE_ENV === "development",
        type: "module",
      },
    }),
    // Fixes isomorphic-git Buffer error
    // https://github.com/isomorphic-git/isomorphic-git/issues/1753
    nodePolyfills(),
  ],
  // The SQLite worker (src/data/sql-worker.ts) is an ES module worker — it
  // imports @sqlite.org/sqlite-wasm, which locates its .wasm via
  // import.meta.url and so cannot be bundled as an iife.
  worker: {
    format: "es",
  },
  optimizeDeps: {
    // Per @sqlite.org/sqlite-wasm's docs: keep the wasm loader out of the dev
    // prebundle so its asset URLs resolve correctly.
    exclude: ["@sqlite.org/sqlite-wasm"],
  },
  build: {
    // This is a rich editor app (the full markdown/unified + block editor stack),
    // so the bundle is legitimately large. Raise the size-warning threshold
    // rather than manually splitting vendors: separating React into its own
    // chunk broke module init order at runtime (React resolved to undefined).
    // Route-level lazy-loading is the safer optimization to revisit later.
    chunkSizeWarningLimit: 3500,
  },
})
