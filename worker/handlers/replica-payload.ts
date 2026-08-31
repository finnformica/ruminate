// The replica wire format, shared between the Worker and the client.
//
// This module is deliberately pure — no Cloudflare types, no cookie handling,
// nothing but the row shapes of schema v2 (docs/graph-schema-v2.md), their
// validation, and the SQL planning for `PUT /api/replica/notes`. The Worker
// (`replica.ts`) imports it to validate and plan real requests; the client
// (`src/data/graph.ts`, `src/data/replica-sync.ts`) imports the *types* so the
// rows it builds are the rows the Worker parses — same repo, same file, no
// drift.

/** One row of the `nodes` table. */
export interface NodeRow {
  id: string
  /** Type registry in docs/graph-schema-v2.md (`page`, `text`, `h1`…). */
  type: string
  /** Marker-free content; for pages, the title. */
  text: string
  /** JSON or null. Pages carry `{frontmatter}` verbatim; code carries `{language}`. */
  props: string | null
  /** ms epoch — per-row LWW + since-cursor pulls. */
  updated_at: number
}

/** One row of the `link` table — containment (`kind: "child"`) today. */
export interface LinkRow {
  source_id: string
  destination_id: string
  kind: string
  /** Fractional index; sibling order under a source. */
  sort_key: string
  updated_at: number
}

/** The `link` table's primary key: [source_id, destination_id, kind]. */
export type LinkKey = [string, string, string]

export const linkKeyOf = (link: LinkRow): LinkKey => [
  link.source_id,
  link.destination_id,
  link.kind,
]

/**
 * A batch of row-level changes — what one save boils down to, and the unit the
 * push queue accumulates. Upserts and deletes are disjoint by key.
 */
export interface GraphDiff {
  nodes: NodeRow[]
  links: LinkRow[]
  deleteNodes: string[]
  deleteLinks: LinkKey[]
}

export const emptyGraphDiff = (): GraphDiff => ({
  nodes: [],
  links: [],
  deleteNodes: [],
  deleteLinks: [],
})

export const isEmptyGraphDiff = (diff: GraphDiff): boolean =>
  diff.nodes.length === 0 &&
  diff.links.length === 0 &&
  diff.deleteNodes.length === 0 &&
  diff.deleteLinks.length === 0

/** Body of `PUT /api/replica/notes`: row upserts (per-row LWW) + deletes. */
export interface ReplicaPutPayload {
  nodes: NodeRow[]
  links: LinkRow[]
  deleteNodes?: string[]
  deleteLinks?: LinkKey[]
  /** Opaque client marker of the replicated state (monotonic per client). */
  cursor?: string
}

/** Body of a full pull: `GET /api/replica/notes` — every row of both tables. */
export interface ReplicaCorpusBody {
  nodes: NodeRow[]
  links: LinkRow[]
  /** The replica cursor at pull time (meta `replica_cursor`); the client
   * stores it and sends it back as `?since=` on the next incremental pull. */
  cursor: string | null
}

/** Body of an incremental pull: `GET /api/replica/notes?since=<cursor>`. */
export interface ReplicaChangesBody {
  /** Rows whose `updated_at` is newer than the `since` timestamp. */
  nodes: NodeRow[]
  links: LinkRow[]
  /**
   * EVERY row key currently in the replica, changed or not, per table. The
   * replica keeps no tombstones, so deletions are detectable only by absence:
   * the client removes local rows (that it is not about to push) missing from
   * these lists.
   */
  nodeIds: string[]
  linkKeys: LinkKey[]
  cursor: string | null
}

/** The body of `GET /api/replica/status`. */
export interface ReplicaStatusBody {
  counts: { nodes: number; links: number; pages: number }
  schema_version: string | null
  replica_cursor: string | null
}

/** A planned SQL statement: the pure, D1-free representation of the write. */
export interface SqlStatement {
  sql: string
  params: (string | number | null)[]
}

const isString = (x: unknown): x is string => typeof x === "string"

function parseNodeRow(x: unknown): NodeRow | null {
  if (typeof x !== "object" || x === null) return null
  const row = x as Record<string, unknown>
  if (
    !isString(row.id) ||
    row.id.length === 0 ||
    !isString(row.type) ||
    !isString(row.text) ||
    !(row.props === null || isString(row.props)) ||
    typeof row.updated_at !== "number"
  ) {
    return null
  }
  return {
    id: row.id,
    type: row.type,
    text: row.text,
    props: row.props as string | null,
    updated_at: row.updated_at,
  }
}

function parseLinkRow(x: unknown): LinkRow | null {
  if (typeof x !== "object" || x === null) return null
  const row = x as Record<string, unknown>
  if (
    !isString(row.source_id) ||
    !isString(row.destination_id) ||
    !isString(row.kind) ||
    !isString(row.sort_key) ||
    typeof row.updated_at !== "number"
  ) {
    return null
  }
  return {
    source_id: row.source_id,
    destination_id: row.destination_id,
    kind: row.kind,
    sort_key: row.sort_key,
    updated_at: row.updated_at,
  }
}

const isLinkKey = (x: unknown): x is LinkKey =>
  Array.isArray(x) && x.length === 3 && x.every(isString)

/**
 * Validate an untrusted request body into a `ReplicaPutPayload`, or null.
 * Hand-rolled (no schema library) to keep the Worker bundle lean.
 */
export function parseReplicaPayload(body: unknown): ReplicaPutPayload | null {
  if (typeof body !== "object" || body === null) return null
  const raw = body as Record<string, unknown>
  if (!Array.isArray(raw.nodes) || !Array.isArray(raw.links)) return null

  const nodes: NodeRow[] = []
  for (const entry of raw.nodes) {
    const parsed = parseNodeRow(entry)
    if (!parsed) return null
    nodes.push(parsed)
  }
  const links: LinkRow[] = []
  for (const entry of raw.links) {
    const parsed = parseLinkRow(entry)
    if (!parsed) return null
    links.push(parsed)
  }

  if (
    raw.deleteNodes !== undefined &&
    !(Array.isArray(raw.deleteNodes) && raw.deleteNodes.every(isString))
  ) {
    return null
  }
  if (
    raw.deleteLinks !== undefined &&
    !(Array.isArray(raw.deleteLinks) && raw.deleteLinks.every(isLinkKey))
  ) {
    return null
  }
  if (raw.cursor !== undefined && !isString(raw.cursor)) return null

  return {
    nodes,
    links,
    deleteNodes: raw.deleteNodes as string[] | undefined,
    deleteLinks: (raw.deleteLinks as LinkKey[] | undefined)?.map((key) => [...key] as LinkKey),
    cursor: raw.cursor as string | undefined,
  }
}

/**
 * Plan the SQL for one replica push. Pure: returns statements + bind params;
 * the Worker turns them into a single `db.batch()` (one transaction).
 *
 * Per-row last-writer-wins: an upsert only lands when the incoming
 * `updated_at` is not older than the stored row, so replays are idempotent and
 * a stale push cannot clobber a newer row. Deletes are unconditional (no
 * tombstones — a resurrected row simply arrives with the next push). Node
 * deletes clean their link rows explicitly so the plan does not depend on the
 * engine enforcing `ON DELETE CASCADE`. Statement order: deletes first, then
 * node upserts before link upserts (links reference nodes).
 */
export function planReplicaPut(payload: ReplicaPutPayload): SqlStatement[] {
  const statements: SqlStatement[] = []

  for (const [source, destination, kind] of payload.deleteLinks ?? []) {
    statements.push({
      sql: "DELETE FROM link WHERE source_id = ?1 AND destination_id = ?2 AND kind = ?3",
      params: [source, destination, kind],
    })
  }
  for (const id of payload.deleteNodes ?? []) {
    statements.push({
      sql: "DELETE FROM link WHERE source_id = ?1 OR destination_id = ?1",
      params: [id],
    })
    statements.push({ sql: "DELETE FROM nodes WHERE id = ?1", params: [id] })
  }

  for (const node of payload.nodes) {
    statements.push({
      sql:
        "INSERT INTO nodes (id, type, text, props, updated_at) VALUES (?1, ?2, ?3, ?4, ?5) " +
        "ON CONFLICT (id) DO UPDATE SET type = excluded.type, text = excluded.text, " +
        "props = excluded.props, updated_at = excluded.updated_at " +
        "WHERE excluded.updated_at >= nodes.updated_at",
      params: [node.id, node.type, node.text, node.props, node.updated_at],
    })
  }
  for (const link of payload.links) {
    statements.push({
      sql:
        "INSERT INTO link (source_id, destination_id, kind, sort_key, updated_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5) " +
        "ON CONFLICT (source_id, destination_id, kind) DO UPDATE SET " +
        "sort_key = excluded.sort_key, updated_at = excluded.updated_at " +
        "WHERE excluded.updated_at >= link.updated_at",
      params: [link.source_id, link.destination_id, link.kind, link.sort_key, link.updated_at],
    })
  }

  if (payload.cursor !== undefined) {
    statements.push({
      sql: "UPDATE meta SET value = ?1 WHERE key = 'replica_cursor'",
      params: [payload.cursor],
    })
  }

  return statements
}

/**
 * Parse the `since` query param: the cursor is a ms-timestamp string (minted
 * by the client at push time, echoed back by pulls). Returns the numeric
 * timestamp, or null when malformed — the caller answers 400.
 */
export function parseSinceCursor(raw: string): number | null {
  return /^\d{1,15}$/.test(raw) ? Number(raw) : null
}
