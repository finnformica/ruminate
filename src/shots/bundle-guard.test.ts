import { describe, expect, it } from "vitest"

// The plugin belongs to the Node half of the build (tsconfig.node.json), so
// it is loaded by path rather than imported into the app's project.
const PLUGIN = "../../scripts/shots-vite-plugin"
const { SHOTS_MODE, isShotsRun } = (await import(/* @vite-ignore */ PLUGIN)) as {
  SHOTS_MODE: string
  isShotsRun: (env: { mode: string; command: string }) => boolean
}

// `node:fs` via `getBuiltinModule`, dodging the vite node-polyfills alias
// (same trick as scripts/check-changelog.ts).
const builtin = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process
  ?.getBuiltinModule as (id: string) => unknown
const { existsSync, readdirSync, readFileSync } = builtin("node:fs") as {
  existsSync: (path: string) => boolean
  readdirSync: (path: string, options: { recursive: true }) => string[]
  readFileSync: (path: string, encoding: string) => string
}

/**
 * The guard on shots mode (docs/screenshots.md): the mock API and the auth
 * stub in src/shots/ must never reach a real user. They load only through
 * the shots plugin, which applies only to `vite serve --mode shots`. The
 * production build and the PR previews (Workers Builds runs `npm run
 * build`, then scripts/preview-deploy.mjs) are `vite build` in production
 * mode, which the plugin never applies to.
 *
 * The CI build job runs this file again after `npm run build`, so the last
 * test reads the real bundle there.
 */

/** A string only the mock layer holds (src/shots/install.ts). */
const MARKER = "__RUMINATE_SHOTS_MOCK_LAYER__"

describe("shots mode", () => {
  it("applies only to the dev server in the shots mode", () => {
    expect(isShotsRun({ mode: SHOTS_MODE, command: "serve" })).toBe(true)
    expect(isShotsRun({ mode: "production", command: "build" })).toBe(false)
    expect(isShotsRun({ mode: SHOTS_MODE, command: "build" })).toBe(false)
    expect(isShotsRun({ mode: "development", command: "serve" })).toBe(false)
    expect(isShotsRun({ mode: "test", command: "serve" })).toBe(false)
  })

  it("is never asked for by the build, the deploy or the previews", () => {
    const { scripts } = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts: Record<string, string>
    }
    for (const name of ["build", "deploy", "preview:deploy", "dev", "dev:worker"]) {
      expect(scripts[name], name).not.toMatch(/shots/)
    }
    for (const file of ["wrangler.jsonc", ".env.production", "scripts/preview-deploy.mjs"]) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/shots|SHOTS/)
    }
    expect(existsSync(".env.shots")).toBe(false)
  })

  it("is imported by nothing in the app", () => {
    const offenders = readdirSync("src", { recursive: true })
      .filter((file) => /\.(ts|tsx)$/.test(file) && !file.startsWith("shots"))
      .filter((file) => /from\s+["'][^"']*\/shots(\/|["'])/.test(readFileSync(`src/${file}`, "utf8")))
    expect(offenders).toEqual([])
  })

  it.runIf(existsSync("dist"))("is not in the production bundle", () => {
    const leaks = readdirSync("dist", { recursive: true })
      .filter((file) => /\.(js|html|map)$/.test(file))
      .filter((file) => {
        const text = readFileSync(`dist/${file}`, "utf8")
        return text.includes(MARKER) || text.includes("src/shots/") || text.includes("__shots/")
      })
    expect(leaks).toEqual([])
  })
})
