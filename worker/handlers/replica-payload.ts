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

import type { NoteId } from "../../src/schema"

/** One row of the `nodes` table. */
export interface NodeRow {
  id: string
  /** Type registry in docs/graph-schema-v2.md (`note`, `text`, `h1`…). */
  type: string
  /** Marker-free content; for notes, the title. */
  text: string
  /** JSON or null. Notes carry their metadata entries; code carries `{language}`. */
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
  /**
   * Server-assigned row sequence (migrations/0005). Present on rows the
   * replica hands OUT; absent on rows a client pushes IN, because only the
   * replica may assign one — `rowsToEvents` never reads this field.
   */
  seq?: number
  /**
   * The note the block was written in (migrations/0006) — where it shows in
   * the **Unassigned** basket once nothing links to it. Set at creation,
   * never changed by linking; note roots have none. Absent = no note (a note root, or
   * a row older than the backfill), which keeps every older client and
   * fixture valid.
   */
  notes_id?: NoteId
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
  /**
   * Server-assigned row sequence (migrations/0005). Present on rows the
   * replica hands OUT; absent on rows a client pushes IN, because only the
   * replica may assign one — `rowsToEvents` never reads this field.
   */
  seq?: number
}

/** The `link` table's primary key (within one tenant): [source, dest, kind]. */
/**
 * One row of the `views` table (migrations/0015) — an entrypoint into the
 * graph, and the viewer's own: `user_id` is the key's first column, so a view
 * may name a `root_id` belonging to somebody else (a share) without touching
 * their node.
 */
export interface ViewRow {
  /** Minted per view; several per root are allowed. */
  id: string
  /** The node this view enters the graph at — a note or a block. */
  root_id: string
  /** Query language (`type:todo`); null = the whole subgraph. */
  filter: string | null
  /** `text:desc`; null = document order. */
  sort: string | null
  /** Listed in the sidebar. */
  pinned: boolean
  /** Fractional index ordering the sidebar; null = not placed yet, so the
   * client falls back to its own order until something is dragged. */
  sort_key: string | null
  /** ms epoch — per-row LWW, as `NodeRow.updated_at`. */
  updated_at: number
  /** Soft-delete stamp; see `NodeRow.deleted_at`. */
  deleted_at?: number
  /** Server-assigned; see `NodeRow.seq`. Shared with nodes and link, so one
   * cursor covers all three tables. */
  seq?: number
}

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
  if (row.seq !== null && row.seq !== undefined) node.seq = Number(row.seq)
  if (row.notes_id !== null && row.notes_id !== undefined) node.notes_id = String(row.notes_id)
  return node
}

/** Read one view row out of a driver result (see `toNodeRow`). `pinned` is
 * an INTEGER column on both engines and a boolean on the wire. */
export function toViewRow(row: Record<string, unknown>): ViewRow {
  const view: ViewRow = {
    id: String(row.id),
    root_id: String(row.root_id),
    filter: row.filter === null || row.filter === undefined ? null : String(row.filter),
    sort: row.sort === null || row.sort === undefined ? null : String(row.sort),
    pinned: Number(row.pinned) === 1,
    sort_key: row.sort_key === null || row.sort_key === undefined ? null : String(row.sort_key),
    updated_at: Number(row.updated_at),
  }
  if (row.deleted_at !== null && row.deleted_at !== undefined) {
    view.deleted_at = Number(row.deleted_at)
  }
  if (row.seq !== null && row.seq !== undefined) view.seq = Number(row.seq)
  return view
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
  if (row.seq !== null && row.seq !== undefined) link.seq = Number(row.seq)
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
  /** View rows (migrations/0015). A delete is a tombstoned row here, as it is
   * for nodes and links — there is no purge channel for views, because none
   * was ever needed. */
  views: ViewRow[]
  deleteNodes: string[]
  deleteLinks: LinkKey[]
}

export const emptyGraphDiff = (): GraphDiff => ({
  nodes: [],
  links: [],
  views: [],
  deleteNodes: [],
  deleteLinks: [],
})

export const isEmptyGraphDiff = (diff: GraphDiff): boolean =>
  diff.nodes.length === 0 &&
  diff.links.length === 0 &&
  diff.views.length === 0 &&
  diff.deleteNodes.length === 0 &&
  diff.deleteLinks.length === 0

/** Body of `PUT /api/replica/notes`: row upserts (per-row LWW) + deletes. */
export interface ReplicaPutPayload {
  nodes: NodeRow[]
  links: LinkRow[]
  /** View rows. Optional on the wire: a client that predates 0015 pushes
   * none, and its absence must not be read as "delete them all". */
  views?: ViewRow[]
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
  views: ViewRow[]
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
  /** LIVE rows only — tombstones are not part of "how big is my corpus".
   * `pages` is the note count. The wire name is frozen; the type value it
   * counts is not — migrations/0008 rewrote it from `page` to `note`. */
  counts: { nodes: number; links: number; pages: number }
  schema_version: string | null
  replica_cursor: string | null
}

const isString = (x: unknown): x is string => typeof x === "string"

/** `deleted_at`: absent, null, or a number. Returns the value to store on the
 * row (undefined = live), or `false` when the field is malformed. */
function parseDeletedAt(value: unknown): number | undefined | false {
  if (value === undefined || value === null) return undefined
  return typeof value === "number" && Number.isFinite(value) ? value : false
}

function parseViewRow(x: unknown): ViewRow | null {
  if (typeof x !== "object" || x === null) return null
  const row = x as Record<string, unknown>
  const deletedAt = parseDeletedAt(row.deleted_at)
  if (
    !isString(row.id) ||
    row.id.length === 0 ||
    !isString(row.root_id) ||
    row.root_id.length === 0 ||
    !(row.filter === null || isString(row.filter)) ||
    !(row.sort === null || isString(row.sort)) ||
    typeof row.pinned !== "boolean" ||
    !(row.sort_key === null || isString(row.sort_key)) ||
    typeof row.updated_at !== "number" ||
    deletedAt === false
  ) {
    return null
  }
  const view: ViewRow = {
    id: row.id,
    root_id: row.root_id,
    filter: row.filter as string | null,
    sort: row.sort as string | null,
    pinned: row.pinned,
    sort_key: row.sort_key as string | null,
    updated_at: row.updated_at,
  }
  if (deletedAt !== undefined) view.deleted_at = deletedAt
  return view
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
    deletedAt === false ||
    !(row.notes_id === undefined || row.notes_id === null || isString(row.notes_id))
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
  if (isString(row.notes_id)) node.notes_id = row.notes_id
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

  // Absent is "this client has no views to say anything about" — never "delete
  // the ones you hold".
  let views: ViewRow[] | undefined
  if (raw.views !== undefined) {
    if (!Array.isArray(raw.views)) return null
    views = []
    for (const entry of raw.views) {
      const parsed = parseViewRow(entry)
      if (!parsed) return null
      views.push(parsed)
    }
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
    views,
    deleteNodes: raw.deleteNodes as string[] | undefined,
    deleteLinks: (raw.deleteLinks as LinkKey[] | undefined)?.map((key) => [...key] as LinkKey),
    cursor: raw.cursor as string | undefined,
  }
}

/**
 * The replica wire protocol this build speaks. Every client request carries it
 * as `X-Replica-Protocol`; the Worker refuses anything below its minimum with
 * `409 client_too_old` (replica.ts). Bump it with any change an OLD client
 * cannot survive — a cursor whose meaning changed, a row shape it would
 * misread — and raise the minimum in the same change. A refused client keeps
 * working locally and shows a notice; what it can no longer do is drift
 * silently, which is what a stale cached bundle did after 0005 (below).
 *
 * `0` is every client shipped before this header existed.
 *
 * `2` is the stored note-root type value (migrations/0008): the rows a note is
 * built from say `type = 'note'` where they used to say `'page'`. A protocol-1
 * client asks the graph for `page` roots, finds none, and shows an empty
 * corpus with every block still sitting in its store — the exact silent drift
 * this header exists to prevent, so the minimum goes to 2 with it.
 */
const REPLICA_PROTOCOL = 2
export const REPLICA_PROTOCOL_HEADER = "X-Replica-Protocol"
/** Spread into every replica request's headers. */
export const REPLICA_PROTOCOL_HEADERS = { [REPLICA_PROTOCOL_HEADER]: String(REPLICA_PROTOCOL) }

/**
 * Cursors at or above this are pre-0005 millisecond timestamps, not row
 * sequences, and mean nothing to a server that compares `seq > ?`.
 *
 * A client that stored one before the cutover would otherwise ask for
 * `seq > 1788891492616`, match nothing, and never pull again — silently, and
 * forever. Both sides treat such a cursor as "no cursor": the client
 * (database-mode.ts) so it never sends one, and the Worker (replica.ts) for
 * the client on a cached bundle that predates that guard and has no way to
 * be told. One full pull, then a sequence cursor from there on.
 *
 * The two spaces cannot collide: sequences count writes from 1 and this floor
 * is a trillion, which the corpus would reach roughly never.
 */
export const LEGACY_TIMESTAMP_CURSOR_FLOOR = 1e12

/**
 * Parse the `since` query param: a row sequence (migrations/0005), as the
 * digits the last pull answered with. Returns the number, or null when
 * malformed — the caller answers 400. Whether it is a *legacy* cursor is the
 * caller's question (`LEGACY_TIMESTAMP_CURSOR_FLOOR`), not a parse failure.
 */
export function parseSinceCursor(raw: string): number | null {
  return /^\d{1,15}$/.test(raw) ? Number(raw) : null
}
