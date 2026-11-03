import { cacheRowKey, type CacheRow } from "./cache-rows"
import { canonicalJson } from "./key-events"

/**
 * The fold check (docs/events-log-cache.md, "The client"): the cache is the
 * fold by stamp of the device's log, key by key. In the background, after a
 * batch, the runtime compares the fold of the touched entities' events
 * (`NoteStore.foldOfLog`) with their cache rows (`NoteStore.cacheRowsOf`),
 * and reports where they differ with `console.error`. The replica's own
 * check is `GET /api/replica/verify`.
 */

/** A row's value as compared: JSON with its keys sorted, or null for an
 * unset key. */
const canonValue = (value: string | null): string | null =>
  value === null ? null : canonicalJson(JSON.parse(value) as unknown)

/** The key of a row in the check's result: `block blk_1 text`. */
const foldCheckKey = (row: CacheRow) => `${row.entity} ${row.entity_id} ${row.key}`

/**
 * Where the fold and the cache differ, one line per register:
 * `block blk_1 text: value`, `link a|b|child deleted: only in the cache`.
 * A value is compared as JSON, a stamp as is; `seq` and `updated_at` are
 * not compared (`seq` moves on the cache when a push is answered, outside
 * the runtime's queue; `updated_at` is the writer's clock).
 */
export function cacheDifferences(
  fold: ReadonlyMap<string, CacheRow>,
  cache: readonly CacheRow[],
): string[] {
  const held = new Map(cache.map((row) => [cacheRowKey(row.entity, row.entity_id, row.key), row]))
  const out: string[] = []
  for (const [key, want] of fold) {
    const have = held.get(key)
    if (have === undefined) {
      out.push(`${foldCheckKey(want)}: only in the log`)
      continue
    }
    const fields: string[] = []
    if (canonValue(want.value) !== canonValue(have.value)) fields.push("value")
    if (want.hlc !== have.hlc) fields.push("hlc")
    if (fields.length > 0) out.push(`${foldCheckKey(want)}: ${fields.join(", ")}`)
    held.delete(key)
  }
  for (const row of held.values()) out.push(`${foldCheckKey(row)}: only in the cache`)
  return out
}
