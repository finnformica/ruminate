/// <reference types="vitest/config" />
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

// https://vitejs.dev/config/
export default defineConfig({
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
    visualizer({ filename: "dist/stats.html" }) as unknown as PluginOption,
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
  build: {
    // This is a rich editor app (the full markdown/unified + block editor stack),
    // so the bundle is legitimately large. Raise the size-warning threshold
    // rather than manually splitting vendors: separating React into its own
    // chunk broke module init order at runtime (React resolved to undefined).
    // Route-level lazy-loading is the safer optimization to revisit later.
    chunkSizeWarningLimit: 3500,
  },
})
