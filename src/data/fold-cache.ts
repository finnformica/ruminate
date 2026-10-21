import { eventStamp, type Entity, type RuminateEvent, type StampedEntity } from "./events"
import type { SqlStatement, SqlValue } from "./sql-driver"

/**
 * The client's `nodes`, `link` and `views` as a cache of the fold
 * (docs/event-only-sync.md, "The cache"). The log is the truth; each row is
 * the fold of one entity's events (`foldByStamp`), every field with its
 * stamp in the row's `stamps` column, a JSON object with one key per field
 * and `alive`, as on the server (migrations/0025).
 *
 * The store reads the rows a batch names, applies the batch to them by
 * stamp, and writes them back in the same transaction as the append
 * (`sql-note-store.ts`). This module is the mapping both ways.
 *
 * - **A field** is in the entity only when its stamp is in `stamps`. A
 *   column's value without a stamp is a filler, not a value.
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
    fields: ["root_id", "filter", "sort", "pinned", "sort_key"],
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

/** The fold's entity a cache row holds. */
export function entityOfRow(entity: Entity, row: Record<string, SqlValue>): AnyEntity {
  const stamps = parseStamps(row.stamps)
  const fields: Record<string, unknown> = {}
  for (const field of CACHE_TABLES[entity].fields) {
    if (!(field in stamps)) continue
    const value = row[field]
    fields[field] = field === "pinned" ? Boolean(value) : value
  }
  const created = "alive" in stamps
  const deletedAt = row.deleted_at === null ? null : Number(row.deleted_at)
  return {
    fields,
    stamps,
    alive: created && deletedAt === null,
    deleted_at: created ? deletedAt : null,
    created,
    stamp: Object.values(stamps).reduce((a, b) => (b > a ? b : a), ""),
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

/**
 * Write entities back as their cache rows: one multi-row upsert per
 * `ROWS_PER_WRITE` rows, so a pulled page of 2,000 events is a few
 * statements, not one per entity. `seq` never goes backwards — a push
 * answered meanwhile (`markEventsPushed`, outside the runtime's queue) may
 * have raised it — and stays NULL until an event is placed, so a row never
 * placed has no `seq`, as the read-outs agree (the first ES-4 difference).
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
      return column in value.fields ? toSql(value.fields[column]) : (FILLER[column] ?? null)
    })
    // A tombstone, or an entity no create has reached: neither is live.
    const deletedAt = value.alive ? null : value.created ? (value.deleted_at ?? value.at) : value.at
    return [
      ...values,
      value.at,
      deletedAt,
      value.seq > 0 ? value.seq : null,
      JSON.stringify(value.stamps),
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
  return statements
}

/**
 * The stamps a row takes by the rule for an old event (`eventStamp`): every
 * field and `alive` at the row's `updated_at`, counter 0, `seq:<seq>`. That
 * is the stamp the row's own last event derives when it has none, so that
 * event applied again changes nothing (docs/event-only-sync.md, The
 * migration).
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
