// The pure half of the preview-database machinery (docs/preview-databases.md):
// every decision `scripts/preview-deploy.mjs` and the teardown workflow make,
// as functions of their inputs and nothing else, so they can be tested without
// a Cloudflare account. Nothing here touches the network or the filesystem.
import { createHash } from "node:crypto"
import { applyEdits, modify, parse } from "jsonc-parser"

/** The one production database (wrangler.jsonc). Never created, never deleted. */
export const PRODUCTION_DATABASE = "ruminate"

/**
 * The clone every PR branch whose migrations match main's shares. Rebuilt when
 * main gains a migration; never swept, never torn down by a PR closing.
 */
export const SHARED_PREVIEW_DATABASE = "ruminate-preview"

/** Per-branch clones are `ruminate-preview-<slug>`; the sweep only ever
 * considers names under this prefix. */
export const PREVIEW_PREFIX = "ruminate-preview-"

/**
 * The longest database name this script will mint. The D1 docs do not state a
 * limit; 63 is the conventional DNS-label ceiling and comfortably under
 * anything the API has been seen to accept, so a branch name is truncated to
 * fit rather than risking a refused create.
 */
export const MAX_DATABASE_NAME_LENGTH = 63

/** Hex chars of the branch hash appended to a truncated slug. */
const COLLISION_SUFFIX_LENGTH = 6

const sha256 = (text) => createHash("sha256").update(text).digest("hex")

/**
 * The fingerprint of a migrations directory: sha256 over the sorted files as
 * `name\ncontent\n`. Sensitive to a new file, a renamed file, and an edited
 * one — any of which means the clone that was migrated under the old
 * fingerprint may not match what the branch's code expects.
 *
 * @param {{ name: string, content: string }[]} files
 * @returns {string}
 */
export function migrationsFingerprint(files) {
  const sorted = [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return sha256(sorted.map((file) => `${file.name}\n${file.content}\n`).join(""))
}

/**
 * A branch name as a database-name suffix: lowercase, runs of anything but
 * `[a-z0-9]` collapsed to one dash, no leading or trailing dash, and cut to
 * fit `MAX_DATABASE_NAME_LENGTH` behind the prefix. A cut slug carries six hex
 * characters of the FULL branch name's hash, so two long branches that share
 * a prefix never map to one database.
 *
 * @param {string} branch
 * @returns {string}
 */
export function previewSlug(branch) {
  const plain = branch
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  const budget = MAX_DATABASE_NAME_LENGTH - PREVIEW_PREFIX.length
  if (plain.length > 0 && plain.length <= budget) return plain
  const suffix = sha256(branch).slice(0, COLLISION_SUFFIX_LENGTH)
  const head = plain.slice(0, budget - COLLISION_SUFFIX_LENGTH - 1).replace(/-+$/g, "")
  return head.length > 0 ? `${head}-${suffix}` : suffix
}

/** @param {string} branch */
export function previewDatabaseName(branch) {
  return `${PREVIEW_PREFIX}${previewSlug(branch)}`
}

/**
 * Which clone a branch previews against. Migrations identical to main's mean
 * the branch changes no schema, so it shares the one clone every such branch
 * shares; a branch that adds or edits a migration gets its own, so two PRs
 * with different schema changes never collide.
 *
 * @param {{ branch: string, fingerprint: string, mainFingerprint: string | null }} input
 * @returns {{ name: string, shared: boolean }}
 */
export function chooseDatabase({ branch, fingerprint, mainFingerprint }) {
  if (mainFingerprint !== null && fingerprint === mainFingerprint) {
    return { name: SHARED_PREVIEW_DATABASE, shared: true }
  }
  return { name: previewDatabaseName(branch), shared: false }
}

/**
 * Reuse the clone or rebuild it from production? A clone is kept while the
 * fingerprint it was migrated under still matches the branch's migrations —
 * so a push that changes only code keeps whatever the tester has written to
 * it. Any migration change, a clone with no recorded fingerprint (its last
 * migration run failed part-way, or it predates this script), or an explicit
 * refresh rebuilds it.
 *
 * @param {{ exists: boolean, storedFingerprint: string | null, fingerprint: string, refresh: boolean }} input
 * @returns {{ recreate: boolean, reason: string }}
 */
export function shouldRecreate({ exists, storedFingerprint, fingerprint, refresh }) {
  if (!exists) return { recreate: true, reason: "no such database yet" }
  if (refresh) return { recreate: true, reason: "PREVIEW_DB_REFRESH=1" }
  if (storedFingerprint === null) {
    return { recreate: true, reason: "no migrations fingerprint recorded (last run incomplete?)" }
  }
  if (storedFingerprint !== fingerprint) {
    return { recreate: true, reason: "migrations changed since the clone was migrated" }
  }
  return { recreate: false, reason: "migrations unchanged" }
}

/**
 * Which per-branch clones to delete: every `ruminate-preview-<slug>` whose
 * slug is not that of an open PR's head branch. Production and the shared
 * clone are never candidates, whatever they are called. With no list of open
 * branches (GitHub unreachable) nothing is deleted — a missed sweep costs a
 * database for one more build; a wrong one costs a tester their state.
 *
 * @param {{ databases: string[], openBranches: string[] | null }} input
 * @returns {{ remove: string[], keep: string[], skipped: string | null }}
 */
export function sweepPlan({ databases, openBranches }) {
  const candidates = databases.filter(
    (name) =>
      name.startsWith(PREVIEW_PREFIX) &&
      name !== SHARED_PREVIEW_DATABASE &&
      name !== PRODUCTION_DATABASE,
  )
  if (openBranches === null) {
    return { remove: [], keep: candidates, skipped: "open pull requests unknown" }
  }
  const live = new Set(openBranches.map(previewDatabaseName))
  return {
    remove: candidates.filter((name) => !live.has(name)),
    keep: candidates.filter((name) => live.has(name)),
    skipped: null,
  }
}

/**
 * `wrangler.jsonc` with its D1 binding pointed at the clone and `REPLICA_ID`
 * set to the clone's id, and NOTHING else changed — edits are applied to the
 * text in place, comments and all, so the generated file diffs against the
 * real one in exactly three lines. The Worker name is deliberately left
 * alone: the version must land on the same Worker so the branch alias URL
 * and the OAuth callback registered for it keep working.
 *
 * @param {string} jsonc the text of wrangler.jsonc
 * @param {{ databaseName: string, databaseId: string }} clone
 * @returns {string}
 */
export function rewritePreviewConfig(jsonc, { databaseName, databaseId }) {
  const formattingOptions = { insertSpaces: true, tabSize: 2, eol: "\n" }
  const bindings = parse(jsonc)?.d1_databases
  if (!Array.isArray(bindings) || bindings.length !== 1) {
    throw new Error("wrangler.jsonc: expected exactly one d1_databases binding")
  }
  let text = jsonc
  const edits = [
    [["d1_databases", 0, "database_name"], databaseName],
    [["d1_databases", 0, "database_id"], databaseId],
    [["vars", "REPLICA_ID"], databaseId],
  ]
  for (const [path, value] of edits) {
    text = applyEdits(text, modify(text, path, value, { formattingOptions }))
  }
  return text
}

/**
 * The head branches of a GitHub pulls listing (`GET /repos/:o/:r/pulls`),
 * drafts included — a draft PR is still being previewed.
 *
 * @param {unknown} body
 * @returns {string[]}
 */
export function openPullBranches(body) {
  if (!Array.isArray(body)) return []
  return body
    .map((pull) => pull?.head?.ref)
    .filter((ref) => typeof ref === "string" && ref.length > 0)
}
