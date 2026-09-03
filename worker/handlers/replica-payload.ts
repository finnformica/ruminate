// The replica wire format, shared between the Worker and the client.
//
// This module is deliberately pure — no Cloudflare types, no cookie handling,
// nothing but the row shapes of schema v3 (docs/graph-schema-v2.md), their
// validation, and the SQL planning for `PUT /api/replica/notes`. The Worker
// (`replica.ts`) imports it to validate and plan real requests; the client
// (`src/data/graph.ts`, `src/data/replica-sync.ts`) imports the *types* so the
// rows it builds are the rows the Worker parses — same repo, same file, no
// drift.
//
// The planned statements are written for the **column-tenanted** D1 shape:
// every one carries `user_id` and the `:tenant` token that `TenantDb`
// (worker/tenancy-db.ts) binds to the verified GitHub id. No caller can supply
// a tenant; the planner cannot even express one.

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
  /**
   * Soft-delete stamp (ms epoch), **present only on a tombstoned row** — a
   * live row omits the key entirely, which keeps the wire compact and keeps
   * every pre-tombstone client and fixture valid. All rows a single delete
   * touches share one stamp, so a future restore is "revive the rows stamped
   * at T".
   */
  deleted_at?: number
}

/** One row of the `link` table — containment (`kind: "child"`) today. */
export interface LinkRow {
  source_id: string
  destination_id: string
  kind: string
  /** Fractional index; sibling order under a source. */
  sort_key: string
  updated_at: number
  /** Soft-delete stamp; see `NodeRow.deleted_at`. A link to a tombstoned node
   * is NOT itself tombstoned — it is retained, just never traversed. */
  deleted_at?: number
}

/** The `link` table's primary key (within one tenant): [source, dest, kind]. */
export type LinkKey = [string, string, string]

export const linkKeyOf = (link: LinkRow): LinkKey => [
  link.source_id,
  link.destination_id,
  link.kind,
]

/** Is this row a tombstone? (The one place the convention is spelled out.) */
export const isTombstoned = (row: { deleted_at?: number }): boolean =>
  row.deleted_at !== undefined && row.deleted_at !== null

/** Read one node row out of a driver result, keeping `deleted_at` present only
 * when the row is actually tombstoned (see `NodeRow.deleted_at`). Both engines
 * hand back the same loose row shape, so both parse it here. */
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

/**
 * A batch of row-level changes — what one save boils down to, and the unit the
 * push queue accumulates. Since soft deletes, a delete is an ordinary row
 * carrying `deleted_at`, so it rides in `nodes`/`links`.
 *
 * `deleteNodes` / `deleteLinks` are the **purge** channel: a real removal,
 * with no tombstone to mirror. Nothing produces one today — pulls stopped
 * detecting deletion by absence when the key lists went away — so it is
 * carried for the wire contract older clients still push on, and for a purge
 * tool if one is ever built.
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
  /** Legacy delete channel, kept for older clients: the Worker turns these
   * into tombstone stamps rather than removals. Current clients push
   * tombstoned rows in `nodes`/`links` instead. */
  deleteNodes?: string[]
  deleteLinks?: LinkKey[]
  /** Opaque client marker of the replicated state (monotonic per client). */
  cursor?: string
}

/** Body of a successful `PUT /api/replica/notes` — applied row counts. */
export interface ReplicaPutResult {
  ok: true
  nodes: number
  links: number
  deletes: number
  /**
   * The cursor this batch committed, echoed back so the client can mark it
   * confirmed without a second request. The batch is one transaction, so a
   * 200 means this is what `meta.replica_cursor` now holds. Null when the
   * push carried no cursor (every chunk but the last).
   */
  cursor: string | null
}

/** Body of a full pull: `GET /api/replica/notes` — every row of both tables. */
export interface ReplicaCorpusBody {
  nodes: NodeRow[]
  links: LinkRow[]
  /** The replica cursor at pull time (meta `replica_cursor`); the client
   * stores it and sends it back as `?since=` on the next incremental pull. */
  cursor: string | null
}

/**
 * Body of an incremental pull: `GET /api/replica/notes?since=<cursor>` — rows
 * whose `updated_at` is newer than the `since` timestamp, tombstoned rows
 * included, which is how a deletion travels.
 *
 * Structurally identical to a full pull: it carries fewer rows, not different
 * fields. It used to carry the full key list of both tables as well, so the
 * client could delete local rows absent from them; tombstones replaced that
 * channel, and the lists were O(corpus) reads on every pull
 * (docs/graph-storage.md).
 */
export type ReplicaChangesBody = ReplicaCorpusBody

/** The body of `GET /api/replica/status`. */
export interface ReplicaStatusBody {
  /** LIVE rows only — tombstones are not part of "how big is my corpus". */
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

/** `deleted_at`: absent, null, or a number. Returns the value to store on the
 * row (undefined = live), or `false` when the field is malformed. */
function parseDeletedAt(value: unknown): number | undefined | false {
  if (value === undefined || value === null) return undefined
  return typeof value === "number" && Number.isFinite(value) ? value : false
}

function parseNodeRow(x: unknown): NodeRow | null {
  if (typeof x !== "object" || x === null) return null
  const row = x as Record<string, unknown>
  const deletedAt = parseDeletedAt(row.deleted_at)
  if (
    !isString(row.id) ||
    row.id.length === 0 ||
    !isString(row.type) ||
    !isString(row.text) ||
    !(row.props === null || isString(row.props)) ||
    typeof row.updated_at !== "number" ||
    deletedAt === false
  ) {
    return null
  }
  const node: NodeRow = {
    id: row.id,
    type: row.type,
    text: row.text,
    props: row.props as string | null,
    updated_at: row.updated_at,
  }
  if (deletedAt !== undefined) node.deleted_at = deletedAt
  return node
}

function parseLinkRow(x: unknown): LinkRow | null {
  if (typeof x !== "object" || x === null) return null
  const row = x as Record<string, unknown>
  const deletedAt = parseDeletedAt(row.deleted_at)
  if (
    !isString(row.source_id) ||
    !isString(row.destination_id) ||
    !isString(row.kind) ||
    !isString(row.sort_key) ||
    typeof row.updated_at !== "number" ||
    deletedAt === false
  ) {
    return null
  }
  const link: LinkRow = {
    source_id: row.source_id,
    destination_id: row.destination_id,
    kind: row.kind,
    sort_key: row.sort_key,
    updated_at: row.updated_at,
  }
  if (deletedAt !== undefined) link.deleted_at = deletedAt
  return link
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
 * `TenantDb` binds `:tenant` and runs them as a single batch (one
 * transaction).
 *
 * Per-row last-writer-wins: an upsert only lands when the incoming
 * `updated_at` is not older than the stored row, so replays are idempotent and
 * a stale push cannot clobber a newer row. `deleted_at` rides along as an
 * ordinary column, so a tombstone replicates — and a revive clears — under the
 * same rule.
 *
 * The legacy `deleteNodes`/`deleteLinks` channel becomes a tombstone stamp:
 * nothing is hard-deleted, every row a single push retires shares the one
 * `now` stamp, and a node's link rows are deliberately NOT touched (a link to
 * a tombstoned node is retained so a restore can put the node back in place;
 * the walk skips it at read time).
 *
 * Statement order: tombstones first, then node upserts before link upserts.
 */
export function planReplicaPut(payload: ReplicaPutPayload, now: number): SqlStatement[] {
  const statements: SqlStatement[] = []

  for (const [source, destination, kind] of payload.deleteLinks ?? []) {
    statements.push({
      sql:
        "UPDATE link SET deleted_at = ?4, updated_at = ?4 WHERE user_id = :tenant " +
        "AND source_id = ?1 AND destination_id = ?2 AND kind = ?3 AND deleted_at IS NULL",
      params: [source, destination, kind, now],
    })
  }
  for (const id of payload.deleteNodes ?? []) {
    statements.push({
      sql:
        "UPDATE nodes SET deleted_at = ?2, updated_at = ?2 " +
        "WHERE user_id = :tenant AND id = ?1 AND deleted_at IS NULL",
      params: [id, now],
    })
  }

  for (const node of payload.nodes) {
    statements.push({
      sql:
        "INSERT INTO nodes (user_id, id, type, text, props, updated_at, deleted_at) " +
        "VALUES (:tenant, ?1, ?2, ?3, ?4, ?5, ?6) " +
        "ON CONFLICT (user_id, id) DO UPDATE SET type = excluded.type, text = excluded.text, " +
        "props = excluded.props, updated_at = excluded.updated_at, " +
        "deleted_at = excluded.deleted_at " +
        "WHERE excluded.updated_at >= nodes.updated_at",
      params: [node.id, node.type, node.text, node.props, node.updated_at, node.deleted_at ?? null],
    })
  }
  for (const link of payload.links) {
    statements.push({
      sql:
        "INSERT INTO link (user_id, source_id, destination_id, kind, sort_key, updated_at, deleted_at) " +
        "VALUES (:tenant, ?1, ?2, ?3, ?4, ?5, ?6) " +
        "ON CONFLICT (user_id, source_id, destination_id, kind) DO UPDATE SET " +
        "sort_key = excluded.sort_key, updated_at = excluded.updated_at, " +
        "deleted_at = excluded.deleted_at " +
        "WHERE excluded.updated_at >= link.updated_at",
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

  if (payload.cursor !== undefined) {
    statements.push({
      sql:
        "INSERT INTO meta (user_id, key, value) VALUES (:tenant, 'replica_cursor', ?1) " +
        "ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value",
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
