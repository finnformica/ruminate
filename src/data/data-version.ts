import type { LinkRow, NodeRow } from "../../worker/handlers/replica-payload"
import { upgradedPageProps } from "./frontmatter-props"
import { normalizeBlockText } from "./normalize-block-text"
import { derivePageIdAvoiding, needsMintedId } from "./page-identity"
import type { SqlDriver, SqlStatement } from "./sql-driver"

/**
 * Versioned data transforms — one-time rewrites of existing rows, run by
 * every engine that holds a corpus: the browser sqlite-wasm store and the
 * `node:sqlite` test driver (through `ensureCorpusSchema → ensureDataVersion`
 * on open), and the Worker's D1 partition for a verified user (through
 * `ensureTenantDataVersion`, once per isolate per tenant).
 *
 * Where `schema_version` guards DDL, the `data_version` meta key guards data
 * shape: when it is below the current version, the transform rewrites the
 * affected rows and stamps the key — idempotent (a rerun finds nothing left
 * to rewrite) and transactional (one write: every rewrite and the version
 * stamp land together or not at all).
 *
 * **The `CorpusAccess` port.** The transform's *planning* is pure and shared
 * (`planDataVersion1`); its *reads and writes* differ by shape, because the
 * D1 corpus is column-tenanted (`user_id` on every statement) and the browser
 * corpus is not. Rather than build SQL by string concatenation — the exact
 * leak-by-omission the tenancy guard exists to prevent — each shape supplies
 * its own four fully-written statements behind this port:
 * `singleTenantCorpus(driver)` below, and the tenant-scoped one in
 * `worker/tenancy-db.ts`.
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
 * they replicate like any edit. Every device (and the server) runs the
 * identical deterministic transform, so whichever timestamp wins the per-row
 * LWW race, the winning content is the same — the corpus converges. A
 * not-yet-updated client can still push a raw-spelled row afterwards (its
 * ingest preserves near-misses verbatim); that row simply stays text until
 * the note is next saved by an updated client, whose ingest normalizes it.
 *
 * Version 2 (minted page identity — docs/page-identity-design.md):
 * - Every live `type='page'` node whose id is still its title (not already
 *   `blk_`-prefixed, and not a date/week natural key) is re-keyed to a minted
 *   `blk_` id. The old id becomes the page's `text` — the title, now data —
 *   and the page's `props` carry over unchanged. Every `link` row naming the
 *   old id is re-pointed at the new one. Pre-migration URLs are not preserved:
 *   an id nothing resolves falls through to the new-note editor.
 * - **The mint is derived, not random** (`page-identity.ts`), and that is
 *   load-bearing: this transform runs independently on the browser store and
 *   on the D1 partition, so a random id would give one page two identities and
 *   the next sync would merge them into two pages. Deriving the id from the
 *   old one keeps the version-1 convergence property below intact.
 * - Re-keying is expressed as **upserts only** — the new rows are written and
 *   the old ones tombstoned, never hard-deleted — so a delete still replicates
 *   and the whole re-key lands in the single atomic write.
 *
 * **Tombstones are skipped.** The transform reads live rows only: rewriting a
 * deleted row would bump its `updated_at` for no visible gain, and a revived
 * row is normalized by the ingest that revives it. (Version 2 *creates*
 * tombstones — for the old page rows it replaces — but still reads none.)
 *
 * **The empty-corpus rule.** An empty corpus does not stamp `data_version`:
 * rows can arrive *after* first open (a fresh device pulls its corpus after
 * opening an empty store; the DO→D1 import lands rows in a partition the
 * Worker has already looked at). Leaving the key unset until data exists
 * means the next open transforms whatever arrived; the re-check costs one
 * SELECT.
 */

export const DATA_VERSION_KEY = "data_version"
export const CURRENT_DATA_VERSION = 2

/** Mirrors the rollup's walk depth cap so a corrupted (cyclic) graph can
 * never hang the transform. */
const MAX_WALK_DEPTH = 64

const CHILD_KIND = "child"

/** Kept local (like `CHILD_KIND`) so the transform module stays importable by
 * the Worker without dragging the ingest/rollup graph in behind it. */
const PAGE_TYPE = "page"

/**
 * The corpus a data-version transform reads and rewrites, abstracted over the
 * two schema shapes (see the module header). Every implementation writes its
 * own SQL in full — no fragment stitching.
 */
export interface CorpusAccess {
  /** The stored `data_version`, or null when unset. */
  readVersion(): Promise<string | null>
  /** Every LIVE node row. */
  readNodes(): Promise<NodeRow[]>
  /** Every LIVE link row. */
  readLinks(): Promise<LinkRow[]>
  /**
   * Apply the rewritten rows and — when `stampVersion` — the `data_version`
   * stamp, in ONE atomic write.
   */
  write(plan: DataVersionWrite, stampVersion: boolean): Promise<void>
}

/**
 * What a transform changes: whole rows to upsert, nothing else. A row carrying
 * `deleted_at` is a tombstone (version 2 retires the page rows it re-keys that
 * way), which is why the write is expressive enough to *stamp* a delete but
 * still cannot hard-delete anything.
 */
export interface DataVersionWrite {
  nodes: NodeRow[]
  links: LinkRow[]
}

const emptyWrite = (): DataVersionWrite => ({ nodes: [], links: [] })

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

/**
 * Version 2's re-key, given the full live graph — pure and deterministic, so
 * every engine computes the identical result (see the module header).
 *
 * For each page still keyed by its title: write the minted row (title moved
 * into `text`, props carried over untouched), tombstone the old row, and
 * re-point every link naming it — again as a fresh row plus a tombstone of the
 * old edge. Returns only changed rows, and nothing at all once every page is
 * minted, which is what makes a rerun a no-op.
 */
export function planDataVersion2(
  nodes: NodeRow[],
  links: LinkRow[],
  now: number,
): DataVersionWrite {
  // Sorted, so the collision-probe sequence cannot depend on row order.
  const pages = nodes
    .filter((node) => node.type === PAGE_TYPE && needsMintedId(node.id))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  if (pages.length === 0) return emptyWrite()

  const taken = new Set(nodes.map((node) => node.id))
  const minted = new Map<string, string>()
  for (const page of pages) {
    const fresh = derivePageIdAvoiding(page.id, taken)
    taken.add(fresh)
    minted.set(page.id, fresh)
  }

  const changedNodes: NodeRow[] = []
  for (const page of pages) {
    const id = minted.get(page.id) as string
    changedNodes.push({
      id,
      type: PAGE_TYPE,
      // The old id WAS the title — that is the whole finding this migration
      // answers — so it becomes the page's text.
      text: page.id,
      props: page.props,
      updated_at: now,
      // A deleted page stays deleted. Minting a live row for a tombstoned
      // page resurrects a note the user threw away — and re-keying makes it a
      // NEW id, so no later tombstone would ever match it again.
      ...(page.deleted_at === undefined ? {} : { deleted_at: page.deleted_at }),
    })
    changedNodes.push({ ...page, updated_at: now, deleted_at: now })
  }

  const changedLinks: LinkRow[] = []
  for (const link of links) {
    const source = minted.get(link.source_id)
    const destination = minted.get(link.destination_id)
    if (source === undefined && destination === undefined) continue
    changedLinks.push({
      ...link,
      source_id: source ?? link.source_id,
      destination_id: destination ?? link.destination_id,
      updated_at: now,
    })
    changedLinks.push({ ...link, updated_at: now, deleted_at: now })
  }

  return { nodes: changedNodes, links: changedLinks }
}

/** Read one node row out of a driver result, keeping `deleted_at` present
 * only when the row is actually tombstoned (see `replica-payload.ts`). */
export function toNodeRow(row: Record<string, unknown>): NodeRow {
  const node: NodeRow = {
    id: String(row.id),
    type: String(row.type),
    text: String(row.text),
    props: row.props === null || row.props === undefined ? null : String(row.props),
    updated_at: Number(row.updated_at),
  }
  if (row.deleted_at !== null && row.deleted_at !== undefined) {
    node.deleted_at = Number(row.deleted_at)
  }
  return node
}

/** Read one link row out of a driver result (see `toNodeRow`). */
export function toLinkRow(row: Record<string, unknown>): LinkRow {
  const link: LinkRow = {
    source_id: String(row.source_id),
    destination_id: String(row.destination_id),
    kind: String(row.kind),
    sort_key: String(row.sort_key),
    updated_at: Number(row.updated_at),
  }
  if (row.deleted_at !== null && row.deleted_at !== undefined) {
    link.deleted_at = Number(row.deleted_at)
  }
  return link
}

/** The `CorpusAccess` for a single-tenant corpus (browser store, test engine). */
export function singleTenantCorpus(driver: SqlDriver): CorpusAccess {
  return {
    readVersion: async () => {
      const rows = await driver.exec("SELECT value FROM meta WHERE key = ?", [DATA_VERSION_KEY])
      return rows[0]?.value == null ? null : String(rows[0].value)
    },
    readNodes: async () =>
      (
        await driver.exec(
          "SELECT id, type, text, props, updated_at FROM nodes WHERE deleted_at IS NULL",
        )
      ).map(toNodeRow),
    readLinks: async () =>
      (
        await driver.exec(
          "SELECT source_id, destination_id, kind, sort_key, updated_at FROM link " +
            "WHERE deleted_at IS NULL",
        )
      ).map(toLinkRow),
    write: async (plan, stampVersion) => {
      const statements: SqlStatement[] = plan.nodes.map((node) => ({
        sql:
          "INSERT INTO nodes (id, type, text, props, updated_at, deleted_at) " +
          "VALUES (?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT (id) DO UPDATE SET type = excluded.type, text = excluded.text, " +
          "props = excluded.props, updated_at = excluded.updated_at, " +
          "deleted_at = excluded.deleted_at",
        params: [
          node.id,
          node.type,
          node.text,
          node.props,
          node.updated_at,
          node.deleted_at ?? null,
        ],
      }))
      for (const link of plan.links) {
        statements.push({
          sql:
            "INSERT INTO link (source_id, destination_id, kind, sort_key, updated_at, deleted_at) " +
            "VALUES (?, ?, ?, ?, ?, ?) " +
            "ON CONFLICT (source_id, destination_id, kind) DO UPDATE SET " +
            "sort_key = excluded.sort_key, updated_at = excluded.updated_at, " +
            "deleted_at = excluded.deleted_at",
          params: [
            link.source_id,
            link.destination_id,
            link.kind,
            link.sort_key,
            link.updated_at,
            link.deleted_at ?? null,
          ],
        })
      }
      if (stampVersion) {
        statements.push({
          sql:
            "INSERT INTO meta (key, value) VALUES (?, ?) " +
            "ON CONFLICT (key) DO UPDATE SET value = excluded.value",
          params: [DATA_VERSION_KEY, String(CURRENT_DATA_VERSION)],
        })
      }
      if (statements.length > 0) await driver.batch(statements)
    },
  }
}

/**
 * Bring one corpus to the current data version — see the module header.
 * Called from `ensureCorpusSchema` for single-tenant engines, and from the
 * Worker's per-tenant check for the D1 partition.
 */
export async function ensureDataVersion(corpus: CorpusAccess): Promise<void> {
  if (Number((await corpus.readVersion()) ?? 0) >= CURRENT_DATA_VERSION) return

  const [nodes, links] = await Promise.all([corpus.readNodes(), corpus.readLinks()])
  const now = Date.now()

  // The ladder composes: version 2 plans against the graph version 1 leaves
  // behind, so a corpus arriving from any earlier version reaches the current
  // shape in one pass — and one write. Both plans are no-ops on an already
  // current corpus, so running them unconditionally is also the idempotence.
  const normalized = planDataVersion1(nodes, links, now)
  const byId = new Map(nodes.map((node) => [node.id, node]))
  for (const node of normalized) byId.set(node.id, node)

  const rekeyed = planDataVersion2([...byId.values()], links, now)

  // A page version 2 re-keyed may also have been rewritten by version 1; the
  // re-keyed row is the later word, so it wins the merge.
  const merged = new Map<string, NodeRow>()
  for (const node of normalized) merged.set(node.id, node)
  for (const node of rekeyed.nodes) merged.set(node.id, node)

  // The empty-corpus rule (module header): only stamp the version once there
  // is data the transform actually saw.
  await corpus.write({ nodes: [...merged.values()], links: rekeyed.links }, nodes.length > 0)
}
