// The habits a reminder names (docs/reminders.md): the series of the
// reader's trackers (docs/trackers.md) with nothing logged today.
//
// Two reads, both through the cache of the log (`events_log_cache`,
// docs/events-log-cache.md) and both bounded by the question, not by the
// corpus:
//
// 1. **The series** (`SERIES_SQL`): the live trackers, on the `type`
//    index, then one hop down to their live children that carry a `kind`.
//    Cost: the trackers and their direct children.
// 2. **Today's entries** (`ENTRIES_SQL`): the live blocks whose text begins
//    with today, on the partial index `events_log_cache_day_text`
//    (migrations/0033), then one hop up to the parent each hangs under.
//    Cost: the day's entries, not the history.
//
// Which of them is logged is `isLogged` of src/data/tracker.ts, the same
// question the tracker page's heatmap asks: a ticked to-do, or a number
// above zero.

import {
  addDays,
  entryOf,
  isLogged,
  seriesOf,
  type DayString,
  type SeriesKind,
} from "../../src/data/tracker"
import type { TenantDb } from "../tenancy-db"

/** A series of one of the reader's trackers, as the reminder names it. */
export interface Habit {
  id: string
  name: string
  kind: SeriesKind
  trackerId: string
  trackerName: string
  /** The series's place under its tracker. */
  sortKey: string
}

/** A live block under some parent whose text begins with a day. */
export interface DayEntryRow {
  parentId: string
  id: string
  type: string
  text: string
}

/** The series of every live tracker, one hop down from each. */
const SERIES_SQL =
  "SELECT t.entity_id AS tracker_id, json_extract(tn.value, '$') AS tracker_name, " +
  "json_extract(d.value, '$') AS series_id, json_extract(o.value, '$') AS sort_key, " +
  "json_extract(k.value, '$') AS kind, json_extract(n.value, '$') AS name " +
  "FROM events_log_cache t " +
  "CROSS JOIN events_log_cache td ON td.user_id = :tenant AND td.entity = 'block' " +
  "AND td.entity_id = t.entity_id AND td.key = 'deleted' AND td.value = 'null' " +
  "CROSS JOIN events_log_cache s ON s.user_id = :tenant AND s.key = 'source_id' " +
  "AND s.value = json_quote(t.entity_id) AND s.entity_id GLOB '*|child' " +
  "CROSS JOIN events_log_cache ld ON ld.user_id = :tenant AND ld.entity = 'link' " +
  "AND ld.entity_id = s.entity_id AND ld.key = 'deleted' AND ld.value = 'null' " +
  "CROSS JOIN events_log_cache d ON d.user_id = :tenant AND d.entity = 'link' " +
  "AND d.entity_id = s.entity_id AND d.key = 'destination_id' " +
  "CROSS JOIN events_log_cache o ON o.user_id = :tenant AND o.entity = 'link' " +
  "AND o.entity_id = s.entity_id AND o.key = 'sort_key' " +
  "CROSS JOIN events_log_cache fd ON fd.user_id = :tenant AND fd.entity = 'block' " +
  "AND fd.entity_id = json_extract(d.value, '$') AND fd.key = 'deleted' AND fd.value = 'null' " +
  "CROSS JOIN events_log_cache k ON k.user_id = :tenant AND k.entity = 'block' " +
  "AND k.entity_id = fd.entity_id AND k.key = 'props.kind' " +
  "LEFT JOIN events_log_cache n ON n.user_id = :tenant AND n.entity = 'block' " +
  "AND n.entity_id = fd.entity_id AND n.key = 'text' " +
  "LEFT JOIN events_log_cache tn ON tn.user_id = :tenant AND tn.entity = 'block' " +
  "AND tn.entity_id = t.entity_id AND tn.key = 'text' " +
  "WHERE t.user_id = :tenant AND t.key = 'type' AND t.value = '\"tracker\"'"

/**
 * The live blocks whose text begins with a day in [?1, ?2), each with the
 * parent it hangs under. The `substr … GLOB` term repeats the partial
 * index's own (migrations/0033) word for word: SQLite uses a partial index
 * only when the query states its condition. Today's bounds are the only
 * range on `value`, so the seek reads the day's entries alone.
 */
const ENTRIES_SQL =
  "SELECT json_extract(p.value, '$') AS parent_id, x.entity_id AS id, " +
  "json_extract(y.value, '$') AS type, json_extract(x.value, '$') AS text " +
  "FROM events_log_cache x " +
  "CROSS JOIN events_log_cache xd ON xd.user_id = :tenant AND xd.entity = 'block' " +
  "AND xd.entity_id = x.entity_id AND xd.key = 'deleted' AND xd.value = 'null' " +
  "CROSS JOIN events_log_cache y ON y.user_id = :tenant AND y.entity = 'block' " +
  "AND y.entity_id = x.entity_id AND y.key = 'type' " +
  "CROSS JOIN events_log_cache s ON s.user_id = :tenant AND s.key = 'destination_id' " +
  "AND s.value = json_quote(x.entity_id) AND s.entity_id GLOB '*|child' " +
  "CROSS JOIN events_log_cache ld ON ld.user_id = :tenant AND ld.entity = 'link' " +
  "AND ld.entity_id = s.entity_id AND ld.key = 'deleted' AND ld.value = 'null' " +
  "CROSS JOIN events_log_cache p ON p.user_id = :tenant AND p.entity = 'link' " +
  "AND p.entity_id = s.entity_id AND p.key = 'source_id' " +
  "WHERE x.user_id = :tenant AND x.key = 'text' " +
  "AND substr(x.value, 1, 5) GLOB '\"[0-9][0-9][0-9][0-9]' " +
  "AND x.value >= ?1 AND x.value < ?2"

const text = (value: unknown): string => (typeof value === "string" ? value : "")

/** The series of the reader's live trackers, by tracker name and then in
 * each tracker's own order. */
export async function readHabits(tenant: TenantDb): Promise<Habit[]> {
  const rows = await tenant.exec(SERIES_SQL)
  const habits: Habit[] = []
  for (const row of rows) {
    if (row.kind !== "check" && row.kind !== "number") continue
    habits.push({
      id: text(row.series_id),
      name: text(row.name),
      kind: row.kind,
      trackerId: text(row.tracker_id),
      trackerName: text(row.tracker_name),
      sortKey: text(row.sort_key),
    })
  }
  return habits.sort(
    (a, b) =>
      a.trackerName.localeCompare(b.trackerName) ||
      a.trackerId.localeCompare(b.trackerId) ||
      (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0),
  )
}

/** The live blocks whose text begins with `day`, each with its parent. */
export async function readDayEntries(tenant: TenantDb, day: DayString): Promise<DayEntryRow[]> {
  // The text is stored as JSON: `"2026-11-02 · 5 km"`. Every text of the day
  // sorts from `"2026-11-02` up to, not including, `"2026-11-03`.
  const rows = await tenant.exec(ENTRIES_SQL, [`"${day}`, `"${addDays(day, 1)}`])
  return rows.map((row) => ({
    parentId: text(row.parent_id),
    id: text(row.id),
    type: text(row.type),
    text: text(row.text),
  }))
}

/**
 * The habits with nothing logged on `day`: no entry of the day under the
 * series, or only an open to-do, or only a zero. The same reading the
 * tracker page makes (`entryOf`, `isLogged`). Two entries of one day (two
 * devices offline) count as logged when either is.
 */
export function missingHabits(
  habits: readonly Habit[],
  rows: readonly DayEntryRow[],
  day: DayString,
): Habit[] {
  return habits.filter((habit) => {
    const series = seriesOf({
      id: habit.id,
      text: habit.name,
      props: JSON.stringify({ kind: habit.kind }),
    })
    if (series === null) return false
    const logged = rows.some((row) => {
      if (row.parentId !== habit.id) return false
      const entry = entryOf({ id: row.id, type: row.type, text: row.text, props: null }, habit.kind)
      return (
        entry !== null &&
        entry.date === day &&
        isLogged({ series, entries: new Map([[day, entry]]) }, day)
      )
    })
    return !logged
  })
}

/** Read the reader's habits and today's entries, and say which are missing. */
export async function checkHabits(
  tenant: TenantDb,
  day: DayString,
): Promise<{ habits: Habit[]; missing: Habit[] }> {
  const habits = await readHabits(tenant)
  if (habits.length === 0) return { habits, missing: [] }
  const missing = missingHabits(habits, await readDayEntries(tenant, day), day)
  return { habits, missing }
}
