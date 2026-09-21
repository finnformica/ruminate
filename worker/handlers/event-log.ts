// SPIKE — appending to the event log, and keeping the projections current
// (docs/event-sourcing.md, migrations-spike/events.sql).
//
// The write path, inverted. `planReplicaPut` takes ROWS and upserts them
// last-writer-wins, so the row is the truth and an overwrite is forever. This
// takes EVENTS, appends them, and applies their net effect to `nodes`, `link`
// and `views` — in ONE atomic batch, so the projections are never ahead of
// the log nor behind it, and everything that reads the corpus (pulls, MCP,
// shares, search) goes on reading the tables it always has.
//
// ## A fixed number of statements
//
// D1 allows 50 queries per Worker invocation on the free plan, and a paste
// can create two hundred blocks. So nothing here is per-event: the events
// travel as one JSON parameter and are inserted by one statement over
// `json_each`; their net effect per entity (`netChanges` — patches are
// absolute, so a run rolls up to "last value of each field") travels as one
// JSON parameter per table and lands in two statements each: an insert for
// what the append creates, an update for what it changes. Seven statements,
// whether the push is one keystroke or a whole imported notebook.
//
// ## Sequence
//
// `seq` is assigned here, in SQL, as MAX(seq) + position. SQLite materialises
// an INSERT … SELECT that reads its own table before writing, so the MAX is
// read once, before any row of this append exists, and positions are
// contiguous. A projection row then takes the `seq` of the last event that
// touched it — looked up by event id inside the same batch — which keeps the
// since-cursor pull exact, as 0005 made it.
//
// ## Idempotency
//
// An event's `id` is unique per tenant and the insert is ON CONFLICT DO
// NOTHING, so a push retried after a lost response appends nothing. The
// projections must not be re-applied either — an old net change laid over
// newer rows would regress them — so every projection statement applies a
// change only if its last event was inserted BY THIS APPEND (`append`).
// The unit of retry is the whole push, verbatim: a batch is one transaction,
// so it is either all in the log or none of it is.

import type { SqlStatement } from "../../src/data/sql-driver"
import { netChanges, type NetChange, type RuminateEvent } from "../../src/data/events"
import type { TenantDb } from "../tenancy-db"

export interface AppendContext {
  /** Names this request; minted by the caller (one per push). */
  appendId: string
  /** The verified user writing — the tenant, or a grantee writing through a share. */
  actor: number
  now: number
}

const ENTITIES = new Set(["block", "link", "view"])
const ACTIONS = new Set(["create", "update", "delete", "restore"])

/** Validate one pushed event's envelope. The patch is checked only for being
 * an object: its fields are the projection statements' to read, and a field
 * they do not know is ignored rather than refused (an older Worker must not
 * reject a newer client's event — it is appended intact and upcast later). */
export function parseEvent(raw: unknown): RuminateEvent | null {
  if (typeof raw !== "object" || raw === null) return null
  const event = raw as Record<string, unknown>
  const text = (key: string) => typeof event[key] === "string" && (event[key] as string).length > 0
  if (!text("id") || !text("entity_id") || !text("batch") || !text("device")) return null
  if (!ENTITIES.has(event.entity as string) || !ACTIONS.has(event.action as string)) return null
  if (typeof event.at !== "number" || typeof event.v !== "number") return null
  if (typeof event.patch !== "object" || event.patch === null || Array.isArray(event.patch)) {
    return null
  }
  // `seq`, `actor` and `received_at` are the replica's to assign.
  const { seq: _seq, ...rest } = event
  return rest as unknown as RuminateEvent
}

const changesFor = (changes: NetChange[], entity: NetChange["entity"]) =>
  JSON.stringify(changes.filter((change) => change.entity === entity))

/** The seq of a change's last event — the projection row's `seq`. */
const SEQ_OF_LAST_EVENT =
  "(SELECT e.seq FROM events e WHERE e.user_id = :tenant " +
  "AND e.id = json_extract(j.value, '$.last_event'))"
/** True only for a change this very append inserted (see "Idempotency"). */
const INSERTED_BY_THIS_APPEND =
  "EXISTS (SELECT 1 FROM events e WHERE e.user_id = :tenant " +
  "AND e.id = json_extract(j.value, '$.last_event') AND e.append = ?2)"
/** A field the change set, else the row's own value. `json_type` is SQL NULL
 * for an absent key and the text 'null' for a JSON null — which is how
 * "leave props alone" and "clear props" stay different things. */
const field = (table: string, name: string) =>
  `${name} = CASE WHEN json_type(j.value, '$.set.${name}') IS NULL THEN ${table}.${name} ` +
  `ELSE json_extract(j.value, '$.set.${name}') END`
const tombstone = (table: string) =>
  `deleted_at = CASE json_extract(j.value, '$.deleted') ` +
  `WHEN 1 THEN COALESCE(${table}.deleted_at, json_extract(j.value, '$.at')) ` +
  `WHEN 0 THEN NULL ELSE ${table}.deleted_at END`

/**
 * Plan one append: the statements that add `events` to the log and apply
 * them to the projections. Run them as ONE `tenant.batch` — the atomicity is
 * the design. `?1` is always the JSON; `:tenant` is bound by `TenantDb` and
 * by nothing else.
 */
export function planEventAppend(events: RuminateEvent[], ctx: AppendContext): SqlStatement[] {
  if (events.length === 0) return []
  const changes = netChanges(events)
  const params = (json: string) => [json, ctx.appendId]

  const statements: SqlStatement[] = [
    {
      sql:
        "INSERT INTO events (user_id, seq, id, entity, entity_id, action, patch, v, batch, " +
        "device, cause, actor, base_seq, ref_seq, at, received_at, append) " +
        "SELECT :tenant, " +
        "(SELECT COALESCE(MAX(seq), 0) FROM events WHERE user_id = :tenant) + j.key + 1, " +
        "json_extract(j.value, '$.id'), json_extract(j.value, '$.entity'), " +
        "json_extract(j.value, '$.entity_id'), json_extract(j.value, '$.action'), " +
        "json_extract(j.value, '$.patch'), json_extract(j.value, '$.v'), " +
        "json_extract(j.value, '$.batch'), json_extract(j.value, '$.device'), " +
        "json_extract(j.value, '$.cause'), ?4, json_extract(j.value, '$.base_seq'), " +
        "json_extract(j.value, '$.ref_seq'), json_extract(j.value, '$.at'), ?2, ?3 " +
        "FROM json_each(?1) AS j WHERE true " +
        "ON CONFLICT (user_id, id) DO NOTHING",
      params: [JSON.stringify(events), ctx.now, ctx.appendId, ctx.actor],
    },
  ]

  // Blocks → nodes
  statements.push(
    {
      sql:
        "INSERT INTO nodes (user_id, id, type, text, props, updated_at, deleted_at, notes_id, seq) " +
        "SELECT :tenant, json_extract(j.value, '$.entity_id'), " +
        "json_extract(j.value, '$.created.type'), json_extract(j.value, '$.created.text'), " +
        "json_extract(j.value, '$.created.props'), json_extract(j.value, '$.at'), NULL, " +
        `json_extract(j.value, '$.created.notes_id'), ${SEQ_OF_LAST_EVENT} ` +
        "FROM json_each(?1) AS j " +
        `WHERE json_type(j.value, '$.created') = 'object' AND ${INSERTED_BY_THIS_APPEND} ` +
        "ON CONFLICT (user_id, id) DO NOTHING",
      params: params(changesFor(changes, "block")),
    },
    {
      sql:
        `UPDATE nodes SET ${field("nodes", "type")}, ${field("nodes", "text")}, ` +
        `${field("nodes", "props")}, ${tombstone("nodes")}, ` +
        `updated_at = json_extract(j.value, '$.at'), seq = ${SEQ_OF_LAST_EVENT} ` +
        "FROM json_each(?1) AS j " +
        "WHERE nodes.user_id = :tenant AND nodes.id = json_extract(j.value, '$.entity_id') " +
        `AND ${INSERTED_BY_THIS_APPEND} ` +
        "/* includes-deleted: an event may edit or restore a tombstoned block */",
      params: params(changesFor(changes, "block")),
    },
  )

  // Links → link. The key fields ride in `created`; an update or delete names
  // its link by entity id, so the projection splits nothing: it matches on the
  // same `source|destination|kind` string the log holds.
  const LINK_KEY = "link.source_id || '|' || link.destination_id || '|' || link.kind"
  statements.push(
    {
      sql:
        "INSERT INTO link (user_id, source_id, destination_id, kind, sort_key, updated_at, deleted_at, seq) " +
        "SELECT :tenant, json_extract(j.value, '$.created.source_id'), " +
        "json_extract(j.value, '$.created.destination_id'), json_extract(j.value, '$.created.kind'), " +
        "json_extract(j.value, '$.created.sort_key'), json_extract(j.value, '$.at'), NULL, " +
        `${SEQ_OF_LAST_EVENT} FROM json_each(?1) AS j ` +
        `WHERE json_type(j.value, '$.created') = 'object' AND ${INSERTED_BY_THIS_APPEND} ` +
        "ON CONFLICT (user_id, source_id, destination_id, kind) DO NOTHING",
      params: params(changesFor(changes, "link")),
    },
    {
      sql:
        `UPDATE link SET ${field("link", "sort_key")}, ${tombstone("link")}, ` +
        `updated_at = json_extract(j.value, '$.at'), seq = ${SEQ_OF_LAST_EVENT} ` +
        "FROM json_each(?1) AS j " +
        `WHERE link.user_id = :tenant AND ${LINK_KEY} = json_extract(j.value, '$.entity_id') ` +
        `AND ${INSERTED_BY_THIS_APPEND} ` +
        "/* includes-deleted: re-linking a pair revives its tombstoned row */",
      params: params(changesFor(changes, "link")),
    },
  )

  // Views → views
  statements.push(
    {
      sql:
        "INSERT INTO views (user_id, id, root_id, filter, sort, pinned, sort_key, updated_at, deleted_at, seq) " +
        "SELECT :tenant, json_extract(j.value, '$.entity_id'), json_extract(j.value, '$.created.root_id'), " +
        "json_extract(j.value, '$.created.filter'), json_extract(j.value, '$.created.sort'), " +
        "COALESCE(json_extract(j.value, '$.created.pinned'), 0), " +
        "json_extract(j.value, '$.created.sort_key'), json_extract(j.value, '$.at'), NULL, " +
        `${SEQ_OF_LAST_EVENT} FROM json_each(?1) AS j ` +
        `WHERE json_type(j.value, '$.created') = 'object' AND ${INSERTED_BY_THIS_APPEND} ` +
        "ON CONFLICT (user_id, id) DO NOTHING",
      params: params(changesFor(changes, "view")),
    },
    {
      sql:
        `UPDATE views SET ${field("views", "root_id")}, ${field("views", "filter")}, ` +
        `${field("views", "sort")}, ${field("views", "pinned")}, ${field("views", "sort_key")}, ` +
        `${tombstone("views")}, updated_at = json_extract(j.value, '$.at'), seq = ${SEQ_OF_LAST_EVENT} ` +
        "FROM json_each(?1) AS j " +
        "WHERE views.user_id = :tenant AND views.id = json_extract(j.value, '$.entity_id') " +
        `AND ${INSERTED_BY_THIS_APPEND}`,
      params: params(changesFor(changes, "view")),
    },
  )

  return statements
}

/** Append a validated push. One batch: the log and its projections move together. */
export async function appendEvents(
  tenant: TenantDb,
  events: RuminateEvent[],
  ctx: AppendContext,
): Promise<void> {
  const statements = planEventAppend(events, ctx)
  if (statements.length > 0) await tenant.includingDeleted().batch(statements)
}

interface EventRecord {
  [column: string]: string | number | null
}

const toEvent = (row: EventRecord): RuminateEvent =>
  ({
    id: row.id,
    seq: Number(row.seq),
    entity: row.entity,
    entity_id: row.entity_id,
    action: row.action,
    patch: JSON.parse(String(row.patch)),
    v: Number(row.v),
    batch: row.batch,
    device: row.device,
    ...(row.cause === null ? {} : { cause: row.cause }),
    base_seq: row.base_seq === null ? null : Number(row.base_seq),
    ref_seq: row.ref_seq === null ? null : Number(row.ref_seq),
    at: Number(row.at),
  }) as RuminateEvent

const EVENT_COLUMNS =
  "id, seq, entity, entity_id, action, patch, v, batch, device, cause, base_seq, ref_seq, at"

/** The log after `since`, oldest first — the event-shaped pull. */
export async function readEventsSince(
  tenant: TenantDb,
  since: number,
  limit = 1000,
): Promise<RuminateEvent[]> {
  const rows = await tenant.exec(
    `SELECT ${EVENT_COLUMNS} FROM events WHERE user_id = :tenant AND seq > ?1 ORDER BY seq LIMIT ?2`,
    [since, limit],
  )
  return rows.map(toEvent)
}

/** One entity's events, oldest first — its version history. */
export async function readEntityHistory(
  tenant: TenantDb,
  entity: RuminateEvent["entity"],
  entityId: string,
): Promise<RuminateEvent[]> {
  const rows = await tenant.exec(
    `SELECT ${EVENT_COLUMNS} FROM events WHERE user_id = :tenant AND entity = ?1 ` +
      "AND entity_id = ?2 ORDER BY seq",
    [entity, entityId],
  )
  return rows.map(toEvent)
}
