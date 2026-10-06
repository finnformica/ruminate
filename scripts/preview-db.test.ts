import path from "node:path"
import { parse } from "jsonc-parser"
import { describe, expect, it } from "vitest"

// `node:fs` via `getBuiltinModule`, dodging the vite node-polyfills alias
// (same trick as scripts/check-changelog.ts).
const builtin = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process
  ?.getBuiltinModule as (id: string) => unknown
const { readFileSync } = builtin("node:fs") as {
  readFileSync: (path: string, encoding: string) => string
}
import {
  MAX_DATABASE_NAME_LENGTH,
  PREVIEW_PREFIX,
  PRODUCTION_DATABASE,
  SHARED_PREVIEW_DATABASE,
  chooseDatabase,
  migrationsFingerprint,
  openPullBranches,
  previewDatabaseName,
  previewSlug,
  rewritePreviewConfig,
  shouldRecreate,
  sweepPlan,
} from "./preview-db.mjs"

/**
 * The decisions behind scripts/preview-deploy.mjs and the teardown workflow
 * (docs/preview-databases.md), without a Cloudflare account in the loop.
 */

describe("previewSlug", () => {
  it("lowercases and collapses everything but [a-z0-9] to single dashes", () => {
    expect(previewSlug("claude/Preview_Databases")).toBe("claude-preview-databases")
    expect(previewSlug("feature//odd  chars!!")).toBe("feature-odd-chars")
  })

  it("never starts or ends with a dash", () => {
    expect(previewSlug("/leading-and-trailing/")).toBe("leading-and-trailing")
  })

  it("is deterministic", () => {
    expect(previewSlug("spike/event-sourcing")).toBe(previewSlug("spike/event-sourcing"))
  })

  it("fits the database name limit, and a cut slug carries a hash of the full branch", () => {
    const long = "dependabot/npm_and_yarn/storybook/react-and-a-very-long-package-name-10.6.0"
    const slug = previewSlug(long)
    expect(`${PREVIEW_PREFIX}${slug}`.length).toBeLessThanOrEqual(MAX_DATABASE_NAME_LENGTH)
    expect(slug).toMatch(/-[0-9a-f]{6}$/)
    expect(slug).not.toMatch(/--/)
  })

  it("two long branches that share a prefix get different names", () => {
    const stem = "a-branch-name-long-enough-to-be-cut-off-at-the-limit-"
    expect(previewDatabaseName(`${stem}one`)).not.toBe(previewDatabaseName(`${stem}two`))
  })

  it("a branch with no usable characters still names a database", () => {
    expect(previewSlug("///")).toMatch(/^[0-9a-f]{6}$/)
  })
})

describe("migrationsFingerprint", () => {
  const files = [
    { name: "0001_init.sql", content: "CREATE TABLE a (id);" },
    { name: "0002_more.sql", content: "CREATE TABLE b (id);" },
  ]

  it("does not depend on the order the files are listed in", () => {
    expect(migrationsFingerprint([...files].reverse())).toBe(migrationsFingerprint(files))
  })

  it("changes when a migration's content changes", () => {
    const edited = [files[0], { ...files[1], content: "CREATE TABLE b (id, extra);" }]
    expect(migrationsFingerprint(edited)).not.toBe(migrationsFingerprint(files))
  })

  it("changes when a migration is added", () => {
    const added = [...files, { name: "0003_new.sql", content: "CREATE TABLE c (id);" }]
    expect(migrationsFingerprint(added)).not.toBe(migrationsFingerprint(files))
  })

  it("changes when a migration is renamed", () => {
    const renamed = [files[0], { ...files[1], name: "0002_renamed.sql" }]
    expect(migrationsFingerprint(renamed)).not.toBe(migrationsFingerprint(files))
  })

  it("fingerprints the real migrations directory", () => {
    const dir = path.join(__dirname, "..", "migrations")
    const real = readFileSync(path.join(dir, "0001_init.sql"), "utf8")
    expect(migrationsFingerprint([{ name: "0001_init.sql", content: real }])).toMatch(
      /^[0-9a-f]{64}$/,
    )
  })
})

describe("chooseDatabase", () => {
  it("a branch whose migrations match main's shares the shared clone", () => {
    expect(chooseDatabase({ branch: "x", fingerprint: "f", mainFingerprint: "f" })).toEqual({
      name: SHARED_PREVIEW_DATABASE,
      shared: true,
    })
  })

  it("a branch that changes migrations gets its own clone", () => {
    expect(chooseDatabase({ branch: "spike/x", fingerprint: "f", mainFingerprint: "g" })).toEqual({
      name: `${PREVIEW_PREFIX}spike-x`,
      shared: false,
    })
  })

  it("with main's fingerprint unknown, plays safe with a per-branch clone", () => {
    expect(chooseDatabase({ branch: "x", fingerprint: "f", mainFingerprint: null }).shared).toBe(
      false,
    )
  })
})

describe("shouldRecreate", () => {
  const same = { exists: true, storedFingerprint: "f", fingerprint: "f", refresh: false }

  it("reuses a clone migrated under the same fingerprint", () => {
    expect(shouldRecreate(same).recreate).toBe(false)
  })

  it("rebuilds when the migrations changed", () => {
    expect(shouldRecreate({ ...same, fingerprint: "g" }).recreate).toBe(true)
  })

  it("rebuilds a clone that never recorded a fingerprint", () => {
    expect(shouldRecreate({ ...same, storedFingerprint: null }).recreate).toBe(true)
  })

  it("rebuilds when there is no clone", () => {
    expect(shouldRecreate({ ...same, exists: false, storedFingerprint: null }).recreate).toBe(true)
  })

  it("rebuilds on request", () => {
    expect(shouldRecreate({ ...same, refresh: true }).recreate).toBe(true)
  })
})

describe("sweepPlan", () => {
  const databases = [
    PRODUCTION_DATABASE,
    SHARED_PREVIEW_DATABASE,
    `${PREVIEW_PREFIX}spike-event-sourcing`,
    `${PREVIEW_PREFIX}closed-branch`,
    "something-else",
  ]

  it("deletes only per-branch clones whose PR is no longer open", () => {
    const plan = sweepPlan({ databases, openBranches: ["spike/event-sourcing", "main"] })
    expect(plan.remove).toEqual([`${PREVIEW_PREFIX}closed-branch`])
    expect(plan.keep).toEqual([`${PREVIEW_PREFIX}spike-event-sourcing`])
    expect(plan.skipped).toBeNull()
  })

  it("never touches production, the shared clone, or unrelated databases", () => {
    const plan = sweepPlan({ databases, openBranches: [] })
    expect(plan.remove).toEqual([
      `${PREVIEW_PREFIX}spike-event-sourcing`,
      `${PREVIEW_PREFIX}closed-branch`,
    ])
    expect(plan.remove).not.toContain(PRODUCTION_DATABASE)
    expect(plan.remove).not.toContain(SHARED_PREVIEW_DATABASE)
    expect(plan.remove).not.toContain("something-else")
  })

  it("deletes nothing when the open PRs are unknown", () => {
    const plan = sweepPlan({ databases, openBranches: null })
    expect(plan.remove).toEqual([])
    expect(plan.skipped).not.toBeNull()
  })
})

describe("openPullBranches", () => {
  it("reads head refs, drafts included, and ignores malformed entries", () => {
    const body = [
      { head: { ref: "a" }, draft: false },
      { head: { ref: "b" }, draft: true },
      { head: {} },
      null,
    ]
    expect(openPullBranches(body)).toEqual(["a", "b"])
    expect(openPullBranches({ message: "rate limited" })).toEqual([])
  })
})

describe("rewritePreviewConfig", () => {
  const source = readFileSync(path.join(__dirname, "..", "wrangler.jsonc"), "utf8")
  const clone = {
    databaseName: "ruminate-preview-x",
    databaseId: "11111111-2222-4333-8444-555555555555",
  }

  it("points the one D1 binding at the clone and sets REPLICA_ID", () => {
    const rewritten = parse(rewritePreviewConfig(source, clone))
    expect(rewritten.d1_databases).toHaveLength(1)
    expect(rewritten.d1_databases[0].database_name).toBe(clone.databaseName)
    expect(rewritten.d1_databases[0].database_id).toBe(clone.databaseId)
    expect(rewritten.vars.REPLICA_ID).toBe(clone.databaseId)
  })

  it("changes nothing else — the Worker name above all", () => {
    const original = parse(source)
    const rewritten = parse(rewritePreviewConfig(source, clone))
    expect(rewritten.name).toBe(original.name)
    expect(rewritten.d1_databases[0].binding).toBe(original.d1_databases[0].binding)
    expect(rewritten.d1_databases[0].migrations_dir).toBe(original.d1_databases[0].migrations_dir)
    const { REPLICA_ID: _added, ...vars } = rewritten.vars
    expect(vars).toEqual(original.vars)
    const strip = (config: Record<string, unknown>) => {
      const { d1_databases: _d1, vars: _vars, ...rest } = config
      return rest
    }
    expect(strip(rewritten)).toEqual(strip(original))
  })

  it("keeps the comments — the generated file diffs in three lines", () => {
    const rewritten = rewritePreviewConfig(source, clone)
    const changed = rewritten.split("\n").filter((line) => !source.split("\n").includes(line))
    expect(changed).toHaveLength(3)
  })

  it("refuses a config with other than one D1 binding", () => {
    expect(() => rewritePreviewConfig('{ "d1_databases": [] }', clone)).toThrow(/exactly one/)
  })
})
