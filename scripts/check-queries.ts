/**
 * The tenancy + soft-delete query guard, as a CI gate.
 *
 *   npm run check:queries
 *
 * Column-scoped tenancy is filter discipline (docs/multi-tenant-design.md,
 * "Decision reversal"). This script makes a lapse in that discipline a red
 * build: it scans every SQL string literal under `worker/**` and
 * `src/data/**` and fails on any statement that touches `nodes`, `link`, or
 * `meta` without naming its tenant, or without saying what it means about
 * tombstones. It also fails on any use of the raw `env.DB` binding outside
 * `worker/tenancy-db.ts`.
 *
 * The rules, the annotations that waive them, and the file-level opt-out all
 * live in `src/data/sql-tenancy-guard.ts` — the same module `TenantDb` uses at
 * runtime, so CI and production cannot disagree about what "scoped" means.
 * That module is where to read them; this file is only the walk and the
 * report.
 */
import { checkSource, explainRule, type GuardMode } from "../src/data/sql-tenancy-guard"

// `node:fs`/`node:path` via `getBuiltinModule`, dodging the vite
// node-polyfills alias (same trick as src/data/sql-node-test-driver.ts).
const builtin = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process
  ?.getBuiltinModule as (id: string) => unknown
const { readdirSync, readFileSync } = builtin("node:fs") as {
  readdirSync: (
    path: string,
    options: { withFileTypes: true },
  ) => {
    name: string
    isDirectory(): boolean
  }[]
  readFileSync: (path: string, encoding: "utf8") => string
}

/** Directories scanned, and the schema shape their statements are written for. */
const ROOTS: { dir: string; mode: GuardMode }[] = [
  // The Worker talks to the column-tenanted D1 corpus.
  { dir: "worker", mode: "tenant" },
  // The browser store is one user per browser profile: no `user_id` column,
  // but the same soft-delete discipline.
  { dir: "src/data", mode: "single" },
]

/** The one module allowed to read the raw D1 binding. */
const TENANCY_MODULE = "worker/tenancy-db.ts"

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`
    if (entry.isDirectory()) yield* walk(path)
    else if (path.endsWith(".ts") || path.endsWith(".tsx")) yield path
  }
}

let failures = 0
let scanned = 0

for (const root of ROOTS) {
  for (const path of walk(root.dir)) {
    scanned += 1
    const violations = checkSource(readFileSync(path, "utf8"), {
      mode: root.mode,
      allowEnvDb: path === TENANCY_MODULE,
    })
    for (const violation of violations) {
      failures += 1
      const why =
        violation.rule === "env-db-outside-tenancy-module"
          ? `the raw D1 binding is reachable only from ${TENANCY_MODULE}; handlers take a TenantDb`
          : explainRule(violation.rule)
      console.error(`${path}:${violation.line}  ${violation.rule}`)
      console.error(`  ${why}`)
      console.error(`  ${violation.statement}`)
    }
  }
}

if (failures > 0) {
  console.error(`\ncheck:queries — ${failures} violation(s) across ${scanned} files`)
  process.exit(1)
}
console.log(`check:queries — ${scanned} files scanned, every corpus statement is scoped ✓`)
