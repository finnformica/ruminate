import { eventStamp, type Entity, type RuminateEvent, type StampedEntity } from "./events"
import { parseProps } from "./graph"
import {
  derivedProps,
  isPropsRegister,
  propNameOf,
  propsRegister,
  propsStampOf,
  type BlockValueRow,
} from "./key-events"
import type { SqlStatement, SqlValue } from "./sql-driver"

/**
 * The client's `nodes`, `link` and `views` as a cache of the fold
 * (docs/event-only-sync.md, "The cache"). The log is the truth; each row is
 * the fold of one entity's events (`foldKeysByStamp`), every register with
 * its stamp in the row's `stamps` column, a JSON object with one key per
 * register and `alive`, as on the server (migrations/0025).
 *
 * The store reads the rows a batch names, applies the batch to them by
 * stamp, and writes them back in the same transaction as the append
 * (`sql-note-store.ts`). This module is the mapping both ways.
 *
 * - **A field** is in the entity only when its stamp is in `stamps`. A
 *   column's value without a stamp is a filler, not a value.
 * - **A block's props are keys** (docs/event-sourcing.md, "Per-key events"):
 *   each entry of its props is a `props.<name>` register with a stamp of its
 *   own, held in `stamps` beside the columns'; the `props` column is what
 *   the live keys derive to (`derivedProps`, keys sorted), and its `props`
 *   stamp the highest of theirs. A row written with one `props` stamp and
 *   no keys (a repair, the stamp fill) reads every entry of its props at
 *   that stamp. Each key is also a row of `block_values`, the mirror of the
 *   replica's read model, written beside the block's row.
 * - **Created** means `stamps.alive` is there: a create (or the stamp fill)
 *   set it. An entity an update reached before its create is held with no
 *   `alive` stamp, and as a tombstone, so no read of live rows sees it, and
 *   `getAllRows` leaves it out.
 */

/** The table of each entity, and the columns its fields live in. */
export const CACHE_TABLES = {
  block: { table: "nodes", key: ["id"], fields: ["type", "text", "props", "notes_id"] },
  link: {
    table: "link",
    key: ["source_id", "destination_id", "kind"],
    fields: ["source_id", "destination_id", "kind", "sort_key"],
  },
  view: {
    table: "views",
    key: ["id"],
    fields: ["root_id", "filter", "sort", "pinned", "sort_key", "stack"],
  },
} as const satisfies Record<
  Entity,
  { table: string; key: readonly string[]; fields: readonly string[] }
>

type AnyEntity = StampedEntity<Record<string, unknown>>

/** An entity's key columns from its entity id (`linkEntityId` for a link). */
export const keyValues = (entity: Entity, id: string): string[] =>
  entity === "link" ? id.split("|") : [id]

/** The entity id of a cache row. */
export const entityIdOfRow = (entity: Entity, row: Record<string, SqlValue>): string =>
  entity === "link"
    ? `${String(row.source_id)}|${String(row.destination_id)}|${String(row.kind)}`
    : String(row.id)

const parseStamps = (raw: SqlValue): Record<string, string> => {
  if (typeof raw !== "string") return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, string>) : {}
  } catch {
    return {}
  }
}

/** The fold's entity a cache row holds, its props as `props.<name>` registers. */
export function entityOfRow(entity: Entity, row: Record<string, SqlValue>): AnyEntity {
  const held = parseStamps(row.stamps)
  const fields: Record<string, unknown> = {}
  const stamps: Record<string, string> = {}
  for (const field of CACHE_TABLES[entity].fields) {
    if (field === "props" || !(field in held)) continue
    const value = row[field]
    fields[field] = field === "pinned" ? Boolean(value) : value
    stamps[field] = held[field]
  }
  if ("alive" in held) stamps.alive = held.alive
  if (entity === "block") {
    const props = parseProps(typeof row.props === "string" ? row.props : null) ?? {}
    let keyed = false
    for (const [name, stamp] of Object.entries(held)) {
      if (!isPropsRegister(name)) continue
      keyed = true
      const value = props[propNameOf(name)]
      fields[name] = value === undefined ? null : value
      stamps[name] = stamp
    }
    // One stamp for the whole props (a repair, the stamp fill): every live
    // entry holds it.
    if (!keyed && typeof held.props === "string") {
      for (const [name, value] of Object.entries(props)) {
        if (value === null || value === undefined) continue
        fields[propsRegister(name)] = value
        stamps[propsRegister(name)] = held.props
      }
    }
  }
  const created = "alive" in held
  const deletedAt = row.deleted_at === null ? null : Number(row.deleted_at)
  return {
    fields,
    stamps,
    alive: created && deletedAt === null,
    deleted_at: created ? deletedAt : null,
    created,
    stamp: Object.values(held).reduce((a, b) => (b > a ? b : a), ""),
    seq: row.seq === null ? 0 : Number(row.seq),
    at: Number(row.updated_at),
  }
}

/** The filler a NOT NULL column takes while its field has no stamp. */
const FILLER: Record<string, SqlValue> = {
  type: "",
  text: "",
  sort_key: "",
  root_id: "",
  pinned: 0,
}

const toSql = (value: unknown): SqlValue =>
  value === undefined || value === null
    ? null
    : typeof value === "boolean"
      ? value
        ? 1
        : 0
      : (value as SqlValue)

/** Rows in one statement: the columns times this stay well under SQLite's
 * bound on parameters (32,766). */
const ROWS_PER_WRITE = 500

/** The `stamps` column a block's row takes: its registers' stamps, and
 * `props` as the highest of its keys'. */
function stampsColumn(entity: Entity, value: AnyEntity): string {
  if (entity !== "block") return JSON.stringify(value.stamps)
  const stamps: Record<string, string> = {}
  for (const [name, stamp] of Object.entries(value.stamps)) {
    if (stamp !== undefined && name !== "props") stamps[name] = stamp
  }
  const propsStamp = propsStampOf(value.stamps)
  if (propsStamp !== undefined) stamps.props = propsStamp
  return JSON.stringify(stamps)
}

/**
 * Write entities back as their cache rows: one multi-row upsert per
 * `ROWS_PER_WRITE` rows, so a pulled page of 2,000 events is a few
 * statements, not one per entity. `seq` never goes backwards — a push
 * answered meanwhile (`markEventsPushed`, outside the runtime's queue) may
 * have raised it — and stays NULL until an event is placed, so a row never
 * placed has no `seq`, as the read-outs agree (the first ES-4 difference).
 * A block's keys go to `block_values` beside its row.
 */
export function cacheRowStatements(
  entity: Entity,
  entries: readonly (readonly [id: string, value: AnyEntity])[],
): SqlStatement[] {
  const { table, key, fields } = CACHE_TABLES[entity]
  const isKey = (column: string) => (key as readonly string[]).includes(column)
  const columns = [...new Set([...key, ...fields])]
  const all = [...columns, "updated_at", "deleted_at", "seq", "stamps"]
  const rowOf = ([id, value]: readonly [string, AnyEntity]): SqlValue[] => {
    const keyOf = keyValues(entity, id)
    const values = columns.map((column) => {
      const at = (key as readonly string[]).indexOf(column)
      if (at >= 0) return keyOf[at]
      if (column === "props") return derivedProps(value.fields)
      return column in value.fields ? toSql(value.fields[column]) : (FILLER[column] ?? null)
    })
    // A tombstone, or an entity no create has reached: neither is live.
    const deletedAt = value.alive ? null : value.created ? (value.deleted_at ?? value.at) : value.at
    return [
      ...values,
      value.at,
      deletedAt,
      value.seq > 0 ? value.seq : null,
      stampsColumn(entity, value),
    ]
  }
  const set = all
    .filter((column) => !isKey(column))
    .map((column) =>
      column === "seq"
        ? `seq = NULLIF(MAX(COALESCE(excluded.seq, 0), COALESCE(${table}.seq, 0)), 0)`
        : `${column} = excluded.${column}`,
    )
    .join(", ")
  const statements: SqlStatement[] = []
  for (let i = 0; i < entries.length; i += ROWS_PER_WRITE) {
    const chunk = entries.slice(i, i + ROWS_PER_WRITE)
    const tuple = `(${all.map(() => "?").join(", ")})`
    statements.push({
      // tenant-exempt: the local store is one user per browser profile
      // (src/data/corpus-schema.ts).
      sql:
        `INSERT INTO ${table} (${all.join(", ")}) VALUES ${chunk.map(() => tuple).join(", ")} ` +
        `ON CONFLICT (${key.join(", ")}) DO UPDATE SET ${set}`,
      params: chunk.flatMap(rowOf),
    })
  }
  if (entity === "block") statements.push(...blockValueStatements(entries))
  return statements
}

/** The `block_values` rows of a block's registers, as the replica keeps
 * them: one per key, unset keys as tombstones (a NULL value with a stamp). */
export function blockValuesOf(id: string, value: AnyEntity): BlockValueRow[] {
  const out: BlockValueRow[] = []
  for (const [name, stamp] of Object.entries(value.stamps)) {
    if (!isPropsRegister(name) || stamp === undefined) continue
    const held = value.fields[name]
    out.push({
      block_id: id,
      key: propNameOf(name),
      value: held === null || held === undefined ? null : JSON.stringify(held),
      hlc: stamp,
      ...(value.seq > 0 ? { seq: value.seq } : {}),
      updated_at: value.at,
    })
  }
  return out
}

/** Keys per statement: six columns each, well under the parameter bound. */
const KEYS_PER_WRITE = 1_000

function blockValueStatements(
  entries: readonly (readonly [id: string, value: AnyEntity])[],
): SqlStatement[] {
  const rows = entries.flatMap(([id, value]) => blockValuesOf(id, value))
  const statements: SqlStatement[] = []
  for (let i = 0; i < rows.length; i += KEYS_PER_WRITE) {
    const chunk = rows.slice(i, i + KEYS_PER_WRITE)
    statements.push({
      // tenant-exempt: the local store is one user per browser profile.
      sql:
        "INSERT INTO block_values (block_id, key, value, hlc, seq, updated_at) VALUES " +
        chunk.map(() => "(?, ?, ?, ?, ?, ?)").join(", ") +
        " ON CONFLICT (block_id, key) DO UPDATE SET value = excluded.value, " +
        "hlc = excluded.hlc, seq = NULLIF(MAX(COALESCE(excluded.seq, 0), " +
        "COALESCE(block_values.seq, 0)), 0), updated_at = excluded.updated_at",
      params: chunk.flatMap((row) => [
        row.block_id,
        row.key,
        row.value,
        row.hlc,
        row.seq ?? null,
        row.updated_at,
      ]),
    })
  }
  return statements
}

/**
 * The stamps a row takes by the rule for an old event (`eventStamp`): every
 * field and `alive` at the row's `updated_at`, counter 0, `seq:<seq>`. That
 * is the stamp the row's own last event derives when it has none, so that
 * event applied again changes nothing (docs/event-only-sync.md, The
 * migration). A block's props keys read at the `props` stamp (`entityOfRow`).
 */
export function derivedStamps(
  entity: Entity,
  row: { updated_at: number; seq?: number | null },
): string {
  const stamp = eventStamp({ at: row.updated_at, seq: row.seq ?? 0 } as RuminateEvent)
  const stamps: Record<string, string> = {}
  for (const field of CACHE_TABLES[entity].fields) stamps[field] = stamp
  stamps.alive = stamp
  return JSON.stringify(stamps)
}

/**
 * The one-time stamp fill, in SQL: every row with no `stamps` takes
 * `derivedStamps`. The stamp is spelled as `eventStamp` spells it (15-digit
 * ms, counter `0000`, `seq:` and a 15-digit seq); a test pins the two
 * together. One statement per table, so the fill is one transaction.
 */
export function fillStampsStatements(): SqlStatement[] {
  return (Object.keys(CACHE_TABLES) as Entity[]).map((entity) => {
    const { table, fields } = CACHE_TABLES[entity]
    const stamp =
      "printf('%015d-0000-seq:%015d', MIN(MAX(CAST(updated_at AS INTEGER), 0), 999999999999999), " +
      "COALESCE(seq, 0))"
    const pairs = [...fields, "alive"].map((field) => `'${field}', ${stamp}`).join(", ")
    return {
      // tenant-exempt: the local store is one user per browser profile.
      sql:
        `UPDATE ${table} SET stamps = json_object(${pairs}) ` +
        "WHERE stamps IS NULL /* includes-deleted: a tombstone is in the fold too */",
    }
  })
}
