import type { LinkRow, NodeRow } from "../../worker/handlers/replica-payload"
import { upgradedPageProps } from "./frontmatter-props"
import { normalizeBlockText } from "./normalize-block-text"
import type { SqlDriver, SqlStatement } from "./sql-driver"

/**
 * Versioned data transforms — one-time rewrites of existing rows, run by
 * every engine that opens a corpus (the browser sqlite-wasm store, the
 * `node:sqlite` test driver, and the per-user corpus Durable Object) through
 * the shared schema path (`ensureCorpusSchema` → `ensureDataVersion`).
 *
 * Where `schema_version` guards DDL, the `data_version` meta key guards data
 * shape: when it is below the current version, the transform rewrites the
 * affected rows and stamps the key — idempotent (a rerun finds nothing left
 * to rewrite) and transactional (one `driver.batch`: every rewrite and the
 * version stamp land together or not at all).
 *
 * Version 1 (the data-quality bundle):
 * - Text nodes whose text is a near-miss marker spelling (`[] x`, `[X] x`,
 *   `* x`, `2) x` — `normalize-block-text.ts`) become their typed form, the
 *   same normalization ingest now applies to new saves. Fence-aware: the
 *   transform replays the ingest's fence scan over each page's rollup order,
 *   and a node inside a code fence — or reachable with conflicting fence
 *   states, or unreachable from any page — is left verbatim.
 * - Page props in the legacy `{"frontmatter": raw}` shape are parsed into
 *   individual entries where the canonical round trip is value-faithful
 *   (`frontmatter-props.ts`); degenerate YAML keeps the raw blob.
 *
 * **LWW / cross-device story.** Rewritten rows get a fresh `updated_at`, so
 * they replicate like any edit. Every device (and the server DO) runs the
 * identical deterministic transform, so whichever timestamp wins the per-row
 * LWW race, the winning content is the same — the corpus converges. A
 * not-yet-updated client can still push a raw-spelled row afterwards (its
 * ingest preserves near-misses verbatim); that row simply stays text until
 * the note is next saved by an updated client, whose ingest normalizes it.
 *
 * **The empty-corpus rule.** An empty corpus does not stamp `data_version`:
 * rows can arrive *after* first open (the tenant-#1 D1 import lands rows in a
 * DO whose constructor already ran, and a fresh device pulls its corpus after
 * opening an empty store). Leaving the key unset until data exists means the
 * next open transforms whatever arrived; the re-check costs one SELECT.
 */

export const DATA_VERSION_KEY = "data_version"
export const CURRENT_DATA_VERSION = 1

/** Mirrors the rollup's walk depth cap so a corrupted (cyclic) graph can
 * never hang the transform. */
const MAX_WALK_DEPTH = 64

const CHILD_KIND = "child"

/**
 * The node rows version 1 rewrites, given the full graph — pure and
 * deterministic (every engine computes the same rewrites; only `now`
 * differs). Returns only changed rows.
 */
export function planDataVersion1(nodes: NodeRow[], links: LinkRow[], now: number): NodeRow[] {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const childrenOf = new Map<string, LinkRow[]>()
  for (const link of links) {
    if (link.kind !== CHILD_KIND) continue
    const list = childrenOf.get(link.source_id)
    if (list) list.push(link)
    else childrenOf.set(link.source_id, [link])
  }
  for (const list of childrenOf.values()) {
    // The rollup's deterministic sibling order (sort key, destination tiebreak).
    list.sort((a, b) =>
      a.sort_key < b.sort_key
        ? -1
        : a.sort_key > b.sort_key
          ? 1
          : a.destination_id < b.destination_id
            ? -1
            : 1,
    )
  }

  // Fence state per node, replaying the ingest's scan over each page's rollup
  // order: `false`/`true` = outside/inside a fence, "conflict" = reached with
  // both states (multi-parent across a fence boundary) — left verbatim.
  const fenceState = new Map<string, boolean | "conflict">()
  for (const page of nodes) {
    if (page.type !== "page") continue
    let fenceOpen = false
    const visit = (id: string, depth: number) => {
      const node = byId.get(id)
      if (!node) return
      const previous = fenceState.get(id)
      if (previous === undefined) fenceState.set(id, fenceOpen)
      else if (previous !== fenceOpen) fenceState.set(id, "conflict")
      if (node.text.trimStart().startsWith("```")) fenceOpen = !fenceOpen
      if (depth + 1 >= MAX_WALK_DEPTH) return
      for (const link of childrenOf.get(id) ?? []) visit(link.destination_id, depth + 1)
    }
    for (const link of childrenOf.get(page.id) ?? []) visit(link.destination_id, 0)
  }

  const changed: NodeRow[] = []
  for (const node of nodes) {
    if (node.type === "page") {
      const props = upgradedPageProps(node.props)
      if (props !== null) changed.push({ ...node, props, updated_at: now })
      continue
    }
    if (node.type !== "text") continue
    if (fenceState.get(node.id) !== false) continue // fenced, conflicted, or unreachable
    const normalized = normalizeBlockText(node.text)
    if (normalized) {
      changed.push({ ...node, type: normalized.type, text: normalized.text, updated_at: now })
    }
  }
  return changed
}

const upsertNodeStatement = (node: NodeRow): SqlStatement => ({
  sql:
    "INSERT INTO nodes (id, type, text, props, updated_at) VALUES (?, ?, ?, ?, ?) " +
    "ON CONFLICT (id) DO UPDATE SET type = excluded.type, text = excluded.text, " +
    "props = excluded.props, updated_at = excluded.updated_at",
  params: [node.id, node.type, node.text, node.props, node.updated_at],
})

/**
 * Bring the corpus behind `driver` to the current data version — see the
 * module header. Called from `ensureCorpusSchema`, so every engine runs it on
 * open, after the DDL ladder.
 */
export async function ensureDataVersion(driver: SqlDriver): Promise<void> {
  const versionRows = await driver.exec("SELECT value FROM meta WHERE key = ?", [DATA_VERSION_KEY])
  if (Number(versionRows[0]?.value ?? 0) >= CURRENT_DATA_VERSION) return

  const nodeRows = await driver.exec("SELECT id, type, text, props, updated_at FROM nodes")
  const linkRows = await driver.exec(
    "SELECT source_id, destination_id, kind, sort_key, updated_at FROM link",
  )
  const nodes: NodeRow[] = nodeRows.map((row) => ({
    id: String(row.id),
    type: String(row.type),
    text: String(row.text),
    props: row.props === null ? null : String(row.props),
    updated_at: Number(row.updated_at),
  }))
  const links: LinkRow[] = linkRows.map((row) => ({
    source_id: String(row.source_id),
    destination_id: String(row.destination_id),
    kind: String(row.kind),
    sort_key: String(row.sort_key),
    updated_at: Number(row.updated_at),
  }))

  const statements = planDataVersion1(nodes, links, Date.now()).map(upsertNodeStatement)
  // The empty-corpus rule (module header): only stamp the version once there
  // is data the transform actually saw.
  if (nodes.length > 0) {
    statements.push({
      sql:
        "INSERT INTO meta (key, value) VALUES (?, ?) " +
        "ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      params: [DATA_VERSION_KEY, String(CURRENT_DATA_VERSION)],
    })
  }
  if (statements.length > 0) await driver.batch(statements)
}
