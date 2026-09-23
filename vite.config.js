var __spreadArray =
  (this && this.__spreadArray) ||
  function (to, from, pack) {
    if (pack || arguments.length === 2)
      for (var i = 0, l = from.length, ar; i < l; i++) {
        if (ar || !(i in from)) {
          if (!ar) ar = Array.prototype.slice.call(from, 0, i)
          ar[i] = from[i]
        }
      }
    return to.concat(ar || Array.prototype.slice.call(from))
  }
/// <reference types="vitest/config" />
import { createHash } from "node:crypto"
import { readdirSync, readFileSync } from "node:fs"
import tailwindcss from "@tailwindcss/vite"
import { TanStackRouterVite } from "@tanstack/router-plugin/vite"
import react from "@vitejs/plugin-react"
import jotaiDebugLabel from "jotai/babel/plugin-debug-label"
import jotaiReactRefresh from "jotai/babel/plugin-react-refresh"
import { visualizer } from "rollup-plugin-visualizer"
import { defineConfig } from "vite"
import { nodePolyfills } from "vite-plugin-node-polyfills"
import { VitePWA } from "vite-plugin-pwa"
import { defaultExclude } from "vitest/config"
/**
 * What build of the changelog this is, as `<newest week>.<hash>`.
 *
 * The card shown after an update lists the releases a reader has not seen,
 * which needs a stamp it can compare against the one it stored last time. The
 * week says which releases are new; the hash is there so that two builds in
 * the same week are not mistaken for one, which would leave the stamp stale
 * until the following Monday.
 *
 * Read from the changelog folder, which is the changelog: every file under it
 * counts towards the hash, and the newest week's folder gives the week. A new
 * entry therefore moves the stamp the moment it is written, with no step in
 * between.
 */
function changelogVersion() {
  var _a
  var weeks = readdirSync("changelog").sort()
  var texts = []
  for (var _i = 0, weeks_1 = weeks; _i < weeks_1.length; _i++) {
    var week_1 = weeks_1[_i]
    for (var _b = 0, _c = readdirSync("changelog/".concat(week_1)).sort(); _b < _c.length; _b++) {
      var name_1 = _c[_b]
      if (name_1.endsWith(".md"))
        texts.push(readFileSync("changelog/".concat(week_1, "/").concat(name_1), "utf8"))
    }
  }
  var week = (_a = weeks.at(-1)) !== null && _a !== void 0 ? _a : "0000-W00"
  var hash = createHash("sha256").update(texts.join("\0")).digest("hex").slice(0, 8)
  return "".concat(week, ".").concat(hash)
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
    exclude: __spreadArray(__spreadArray([], defaultExclude, true), ["**/.claude/**"], false),
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
    visualizer({ filename: "stats.html" }),
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
        // The SQL store's worker chunk and the sqlite wasm it loads are
        // precached with the rest: they ARE the notes when signed in, and a
        // cold start offline (the app closed and reopened on a phone) has
        // nowhere else to get them — without them the store never opens,
        // nothing loads, and nothing written is kept.
        globPatterns: ["**/*.{html,css,js,woff2,wasm}"],
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
