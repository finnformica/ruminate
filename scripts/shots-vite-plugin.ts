// Shots mode (docs/screenshots.md): the signed-in app under `vite dev` with
// no Worker and no database. This plugin is in vite.config.ts for every run
// but applies ONLY to `vite serve --mode shots` (`isShotsRun`): in a build,
// in any mode, and in any other dev mode it does nothing, so the mock layer
// (src/shots/) is never part of a bundle. src/shots/bundle-guard.test.ts and
// the CI build job check that.
//
// Applied, it
//   1. puts the user and src/shots/install.ts at the top of index.html, so
//      the mock layer runs before the app's own entry;
//   2. serves the fixture set at /__shots/fixtures.json, read from the
//      directory in SHOTS_FIXTURES (shots/demo by default);
//   3. prints each request the mock layer has no answer for, posted to
//      /__shots/log.
import { readFileSync } from "node:fs"
import path from "node:path"
import type { Plugin } from "vite"

export const SHOTS_MODE = "shots"

/** Is this the one run the plugin applies to? */
export const isShotsRun = (env: { mode: string; command: string }): boolean =>
  env.mode === SHOTS_MODE && env.command === "serve"

/** The fixture file of the set in `dir`. */
export const fixturesFile = (dir: string): string => path.join(dir, "fixtures.json")

export function shotsPlugin(): Plugin {
  let file = ""
  let user: unknown = null
  let kind = "demo"
  return {
    name: "ruminate-shots",
    apply: (_config, env) => isShotsRun(env),
    // Compile the app's modules at start, not on the first shot's load. The
    // service worker's packages (src/sw.ts) are bundled at start too: found
    // late, they make Vite reload the page in the middle of the first shot.
    // Named, not scanned: a scan of src/sw.ts takes the server past the
    // box's 1 GB cap for a served job.
    config: () => ({
      server: { warmup: { clientFiles: ["./src/index.tsx"] } },
      optimizeDeps: { include: ["workbox-precaching", "workbox-routing"] },
    }),
    configResolved(config) {
      file = fixturesFile(path.resolve(config.root, process.env.SHOTS_FIXTURES || "shots/demo"))
      const fixtures = JSON.parse(readFileSync(file, "utf8")) as { user: unknown; kind: string }
      user = fixtures.user
      kind = fixtures.kind
    },
    configureServer(server) {
      server.middlewares.use("/__shots/fixtures.json", (_req, res) => {
        res.setHeader("Content-Type", "application/json")
        res.setHeader("Cache-Control", "no-store")
        res.end(readFileSync(file))
      })
      server.middlewares.use("/__shots/log", (req, res) => {
        let line = ""
        req.on("data", (chunk: Buffer) => (line += chunk.toString()))
        req.on("end", () => {
          console.error(`\x1b[31m[shots] ${line.slice(0, 300)}\x1b[0m`)
          res.statusCode = 204
          res.end()
        })
      })
    },
    transformIndexHtml: () => [
      {
        tag: "script",
        children: `window.__RUMINATE_SHOTS__ = ${JSON.stringify({ user, kind })}`,
        injectTo: "head-prepend",
      },
      {
        tag: "script",
        attrs: { type: "module", src: "/src/shots/install.ts" },
        injectTo: "head-prepend",
      },
    ],
  }
}
