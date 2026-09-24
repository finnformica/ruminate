// The Preview command for Workers Builds (docs/preview-databases.md).
//
//   npm run preview:deploy            what the dashboard runs on a PR branch push
//   npm run preview:deploy -- --dry-run   print every command, run none of them
//   node scripts/preview-deploy.mjs --slug <branch>   the clone's name, nothing else
//
// A preview used to be `wrangler versions upload` on its own: the same Worker,
// the same bindings, and so the PRODUCTION database — which no preview could
// migrate, and every preview wrote its test edits into. This script gives
// each pull request a clone of production to preview against instead:
//
//   1. gate      — no open PR for this branch → no preview at all (exit 0)
//   2. fingerprint the branch's migrations, and main's
//   3. choose    — same as main → the shared clone; otherwise this branch's own
//   4. reuse or rebuild the clone (production → export → import)
//   5. migrate it with the branch's migrations, through a generated config
//   6. sweep     — clones whose PR is no longer open are deleted
//   7. upload    — `wrangler versions upload` with the generated config
//
// The dashboard's Build command stays `npm run build`; this runs after it and
// does not build. It needs wrangler to be authenticated with a token that can
// create, delete, export and import D1 databases — see the doc for which
// token that is, because the one Workers Builds mints by itself cannot.
//
// Everything decided here is decided by the pure functions in
// scripts/preview-db.mjs, which is where the tests are.
import { execFileSync, spawnSync } from "node:child_process"
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  PRODUCTION_DATABASE,
  chooseDatabase,
  migrationsFingerprint,
  openPullBranches,
  previewSlug,
  rewritePreviewConfig,
  shouldRecreate,
  sweepPlan,
} from "./preview-db.mjs"

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")
const MIGRATIONS_DIR = path.join(ROOT, "migrations")
const CONFIG = path.join(ROOT, "wrangler.jsonc")
/** Generated per build, gitignored: wrangler.jsonc with the clone swapped in. */
const GENERATED_CONFIG = path.join(ROOT, "wrangler.preview.generated.jsonc")
const REPO = "finnformica/ruminate"
/** The table the script keeps in every clone: what it was cloned from, when,
 * and the migrations fingerprint it was last migrated under. Not part of the
 * schema — production never has it. */
const CLONE_TABLE = "_preview_clone"

// -----------------------------------------------------------------------------
// Arguments
// -----------------------------------------------------------------------------

const argv = process.argv.slice(2)
const dryRun = argv.includes("--dry-run")
const slugIndex = argv.indexOf("--slug")
if (slugIndex !== -1) {
  const branch = argv[slugIndex + 1]
  if (!branch) fail("--slug needs a branch name")
  process.stdout.write(`${previewSlug(branch)}\n`)
  process.exit(0)
}
/** Anything else is handed to `wrangler versions upload` untouched. */
const uploadArgs = argv.filter((arg) => arg !== "--dry-run")

const branch = process.env.WORKERS_CI_BRANCH || gitOutput(["rev-parse", "--abbrev-ref", "HEAD"])
if (!branch || branch === "HEAD") fail("cannot tell which branch this is (WORKERS_CI_BRANCH unset)")

// -----------------------------------------------------------------------------
// 1. Gate: only a branch with an open pull request gets a preview
// -----------------------------------------------------------------------------

step(`branch ${branch}`)
const ownPulls = await github(
  `/repos/${REPO}/pulls?state=open&head=${encodeURIComponent(`finnformica:${branch}`)}`,
)
if (ownPulls === null) fail("GitHub API unreachable; cannot tell whether this branch has a PR")
if (openPullBranches(ownPulls).length === 0) {
  step(`no open PR for ${branch}; skipping preview`)
  process.exit(0)
}
step(`open PR found for ${branch}`)

// -----------------------------------------------------------------------------
// 2. Fingerprints: this branch's migrations, and main's
// -----------------------------------------------------------------------------

const fingerprint = migrationsFingerprint(
  readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .map((name) => ({ name, content: readFileSync(path.join(MIGRATIONS_DIR, name), "utf8") })),
)
const mainFiles = await mainMigrations()
const mainFingerprint = mainFiles === null ? null : migrationsFingerprint(mainFiles)
step(
  `migrations fingerprint ${fingerprint.slice(0, 12)} (main: ${
    mainFingerprint === null ? "unknown" : mainFingerprint.slice(0, 12)
  })`,
)

// -----------------------------------------------------------------------------
// 3. Choose the clone
// -----------------------------------------------------------------------------

const target = chooseDatabase({ branch, fingerprint, mainFingerprint })
step(
  target.shared
    ? `migrations match main → shared clone ${target.name}`
    : `migrations differ from main → this branch's clone ${target.name}`,
)

// -----------------------------------------------------------------------------
// 4. Reuse it, or rebuild it from production
// -----------------------------------------------------------------------------

let databases = listDatabases()
let existing = databases.find((db) => db.name === target.name) ?? null
const stored = existing ? readStoredFingerprint(target.name) : null
const decision = shouldRecreate({
  exists: existing !== null,
  storedFingerprint: stored,
  fingerprint,
  refresh: process.env.PREVIEW_DB_REFRESH === "1",
})

let databaseId = existing?.uuid ?? null
if (decision.recreate) {
  step(`rebuilding ${target.name}: ${decision.reason}`)
  if (existing) wrangler(["d1", "delete", target.name, "-y"])
  wrangler(["d1", "create", target.name])
  // `d1 create` prints the id as a config snippet meant for a human; the
  // listing is the machine-readable answer, so ask that.
  databases = listDatabases()
  existing = databases.find((db) => db.name === target.name) ?? null
  databaseId = existing?.uuid ?? (dryRun ? "00000000-0000-4000-8000-000000000000" : null)
  if (!databaseId) fail(`created ${target.name} but cannot find its id in 'wrangler d1 list'`)

  // Export production and import it whole. The dump carries `d1_migrations`
  // too, so the clone knows which migrations production has already applied
  // and `migrations apply` below runs only the branch's new ones. Two
  // consequences worth knowing: a migration production has ALREADY applied,
  // edited on a branch, does not re-run here (nor could it in production);
  // a migration that is NEW on the branch and later edited does, because the
  // fingerprint change rebuilds the clone from production, where it has never
  // run.
  //
  // Limits (D1 docs): 5 GB per import file, 100 KB per statement. Production
  // is ~1 MB across ten plain tables today; a single row over 100 KB would
  // need the chunked `--command` import described in the doc.
  const scratch = mkdtempSync(path.join(tmpdir(), "ruminate-preview-"))
  const dump = path.join(scratch, "production.sql")
  step(`exporting ${PRODUCTION_DATABASE} → ${dump}`)
  wrangler(["d1", "export", PRODUCTION_DATABASE, "--remote", "--output", dump])
  step(`importing into ${target.name}`)
  wrangler(["d1", "execute", target.name, "--remote", "--file", dump])

  const stamp = (key, value) =>
    `INSERT OR REPLACE INTO ${CLONE_TABLE} (key, value) VALUES ('${key}', '${sqlString(value)}')`
  wrangler([
    "d1",
    "execute",
    target.name,
    "--remote",
    "--command",
    [
      `CREATE TABLE IF NOT EXISTS ${CLONE_TABLE} (key TEXT PRIMARY KEY, value TEXT)`,
      stamp("source_database", PRODUCTION_DATABASE),
      stamp("cloned_at", new Date().toISOString()),
      stamp("build_uuid", process.env.WORKERS_CI_BUILD_UUID ?? ""),
      stamp("commit", process.env.WORKERS_CI_COMMIT_SHA ?? gitOutput(["rev-parse", "HEAD"]) ?? ""),
      stamp("branch", branch),
      // The fingerprint is stamped only once the migrations have run (below):
      // a clone whose migration failed part-way has none, and is rebuilt.
    ].join("; "),
  ])
} else {
  step(`reusing ${target.name} (${databaseId}): ${decision.reason}`)
}

// -----------------------------------------------------------------------------
// 5. Migrate the clone through a config that names it
// -----------------------------------------------------------------------------

const generated = rewritePreviewConfig(readFileSync(CONFIG, "utf8"), {
  databaseName: target.name,
  databaseId,
})
writeFileSync(GENERATED_CONFIG, generated)
step(
  `wrote ${path.relative(ROOT, GENERATED_CONFIG)} (binding → ${target.name}, REPLICA_ID → ${databaseId})`,
)

if (decision.recreate) {
  step(`applying migrations to ${target.name}`)
  wrangler(["d1", "migrations", "apply", target.name, "--remote", "--config", GENERATED_CONFIG])
  wrangler([
    "d1",
    "execute",
    target.name,
    "--remote",
    "--command",
    `INSERT OR REPLACE INTO ${CLONE_TABLE} (key, value) VALUES ('migrations_fingerprint', '${fingerprint}')`,
  ])
}

// -----------------------------------------------------------------------------
// 6. Sweep clones whose PR has closed
// -----------------------------------------------------------------------------

const allPulls = await github(`/repos/${REPO}/pulls?state=open&per_page=100`)
const sweep = sweepPlan({
  databases: databases.map((db) => db.name),
  openBranches: allPulls === null ? null : openPullBranches(allPulls),
})
if (sweep.skipped) step(`sweep skipped: ${sweep.skipped}`)
else if (sweep.remove.length === 0) step(`sweep: nothing to delete (${sweep.keep.length} live)`)
for (const name of sweep.remove) {
  step(`sweep: deleting ${name} (no open PR)`)
  wrangler(["d1", "delete", name, "-y"])
}

// -----------------------------------------------------------------------------
// 7. Upload the version against the clone
// -----------------------------------------------------------------------------

step(`uploading version with ${path.relative(ROOT, GENERATED_CONFIG)}`)
wrangler(["versions", "upload", "--config", GENERATED_CONFIG, ...uploadArgs])
step("done")

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function step(message) {
  console.log(`[preview] ${message}`)
}

function fail(message) {
  console.error(`[preview] ${message}`)
  process.exit(1)
}

/** Run wrangler, streaming its output; in a dry run, print the command. */
function wrangler(args) {
  const shown = `npx wrangler ${args.map(quote).join(" ")}`
  if (dryRun) {
    console.log(`  $ ${shown}`)
    return ""
  }
  console.log(`  $ ${shown}`)
  const result = spawnSync("npx", ["wrangler", ...args], {
    cwd: ROOT,
    stdio: ["ignore", "inherit", "inherit"],
    env: process.env,
  })
  if (result.status !== 0) fail(`'${shown}' failed with exit code ${result.status}`)
}

/** Run wrangler for its JSON output. Dry run: an empty result. */
function wranglerJson(args, fallback) {
  const shown = `npx wrangler ${args.map(quote).join(" ")}`
  console.log(`  $ ${shown}`)
  if (dryRun) return fallback
  const result = spawnSync("npx", ["wrangler", ...args, "--json"], {
    cwd: ROOT,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.status !== 0) {
    process.stderr.write(result.stderr ?? "")
    fail(`'${shown}' failed with exit code ${result.status}`)
  }
  return parseJsonOutput(result.stdout)
}

/** The JSON in wrangler's stdout, tolerating a banner around it. */
function parseJsonOutput(stdout) {
  try {
    return JSON.parse(stdout)
  } catch {
    const start = Math.min(...["[", "{"].map((c) => stdout.indexOf(c)).filter((i) => i >= 0))
    const end = Math.max(stdout.lastIndexOf("]"), stdout.lastIndexOf("}"))
    if (!Number.isFinite(start) || end < start) throw new Error(`unparseable output: ${stdout}`)
    return JSON.parse(stdout.slice(start, end + 1))
  }
}

/** Every D1 database on the account, as `{ uuid, name }`. */
function listDatabases() {
  const listed = wranglerJson(["d1", "list"], [])
  return (Array.isArray(listed) ? listed : [])
    .filter((db) => typeof db?.name === "string" && typeof db?.uuid === "string")
    .map((db) => ({ uuid: db.uuid, name: db.name }))
}

/** The fingerprint a clone was last migrated under, or null (no table, no
 * row, or a dry run). */
function readStoredFingerprint(name) {
  if (dryRun) return null
  // A clone without the table (never finished cloning) errors here; that is
  // a null, not a failure — the rebuild that follows creates it.
  const result = spawnSync(
    "npx",
    [
      "wrangler",
      "d1",
      "execute",
      name,
      "--remote",
      "--json",
      "--command",
      `SELECT value FROM ${CLONE_TABLE} WHERE key = 'migrations_fingerprint'`,
    ],
    { cwd: ROOT, encoding: "utf8", env: process.env },
  )
  if (result.status !== 0) return null
  try {
    const parsed = parseJsonOutput(result.stdout)
    const rows = (Array.isArray(parsed) ? parsed[0] : parsed)?.results
    const value = Array.isArray(rows) && rows.length > 0 ? rows[0].value : null
    return typeof value === "string" && value.length > 0 ? value : null
  } catch {
    return null
  }
}

/** main's migrations, from git if the checkout can see origin/main, else
 * from the GitHub contents API; null if neither works. */
async function mainMigrations() {
  const fromGit = mainMigrationsFromGit()
  if (fromGit !== null) return fromGit
  step("origin/main not available locally; reading main's migrations from GitHub")
  const listing = await github(`/repos/${REPO}/contents/migrations?ref=main`)
  if (!Array.isArray(listing)) return null
  const files = []
  for (const entry of listing) {
    if (typeof entry?.name !== "string" || !entry.name.endsWith(".sql")) continue
    const response = await fetch(entry.download_url, { headers: githubHeaders() })
    if (!response.ok) return null
    files.push({ name: entry.name, content: await response.text() })
  }
  return files
}

function mainMigrationsFromGit() {
  // A shallow CI checkout has no origin/main until asked for it.
  if (gitOutput(["rev-parse", "--verify", "origin/main"]) === null) {
    gitOutput(["fetch", "--depth=1", "origin", "main"])
  }
  const tree = gitOutput(["ls-tree", "--name-only", "origin/main", "migrations/"])
  if (tree === null) return null
  const files = []
  for (const filePath of tree.split("\n").filter((line) => line.endsWith(".sql"))) {
    const content = gitOutput(["show", `origin/main:${filePath}`])
    if (content === null) return null
    files.push({ name: path.basename(filePath), content })
  }
  return files
}

function gitOutput(args) {
  try {
    return execFileSync("git", args, {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).replace(/\n$/, "")
  } catch {
    return null
  }
}

function githubHeaders() {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "ruminate-preview-deploy",
  }
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`
  return headers
}

/** A GitHub API GET, parsed; null on any failure. The repo is public, so no
 * token is needed — GITHUB_TOKEN is honoured for the rate limit's sake. */
async function github(route) {
  const url = `https://api.github.com${route}`
  console.log(`  $ curl ${url}`)
  try {
    const response = await fetch(url, { headers: githubHeaders() })
    if (!response.ok) {
      console.warn(`[preview] GitHub answered ${response.status} for ${route}`)
      return null
    }
    return await response.json()
  } catch (error) {
    console.warn(
      `[preview] GitHub request failed: ${error instanceof Error ? error.message : error}`,
    )
    return null
  }
}

// Function declarations, not consts: the steps above run at module top level,
// before a `const` down here would be initialised.
function sqlString(value) {
  return String(value).replace(/'/g, "''")
}

function quote(arg) {
  return /[\s"']/.test(arg) ? JSON.stringify(arg) : arg
}
