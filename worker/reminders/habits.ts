// The habits a reminder names (docs/reminders.md): the series of the
// reader's trackers (docs/trackers.md) with nothing logged today.
//
// Two reads, both over the projections of the log (`nodes`, `link`, and a
// block's props as its `delta_mat_values` rows, docs/event-sourcing.md) and
// both bounded by the question, not by the corpus:
//
// 1. **The series** (`SERIES_SQL`): the live trackers, on
//    `nodes_tenant_type`, then one hop down on `link_tenant_source` to the
//    live children whose `kind` key is set. Cost: the trackers and their
//    direct children.
// 2. **Today's entries** (`ENTRIES_SQL`): the live blocks whose text begins
//    with today, on the partial index `nodes_tenant_day_text`
//    (migrations/0033), then one hop up on `link_tenant_destination` to the
//    parent each hangs under. Cost: the day's entries, not the history.
//
// When the cache of the log lands (PR #310), these reads move to
// `events_log_cache`.
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
  "SELECT t.id AS tracker_id, t.text AS tracker_name, s.id AS series_id, " +
  "l.sort_key AS sort_key, json_extract(k.value, '$') AS kind, s.text AS name " +
  "FROM nodes t " +
  "CROSS JOIN link l ON l.user_id = :tenant AND l.source_id = t.id AND l.kind = 'child' " +
  "AND l.deleted_at IS NULL " +
  "CROSS JOIN nodes s ON s.user_id = :tenant AND s.id = l.destination_id " +
  "AND s.deleted_at IS NULL " +
  "CROSS JOIN delta_mat_values k ON k.user_id = :tenant AND k.block_id = s.id " +
  "AND k.key = 'kind' " +
  "WHERE t.user_id = :tenant AND t.type = 'tracker' AND t.deleted_at IS NULL"

/**
 * The live blocks whose text begins with a day in [?1, ?2), each with the
 * parent it hangs under. The `deleted_at` and `substr … GLOB` terms repeat
 * the partial index's own (migrations/0033) word for word: SQLite uses a
 * partial index only when the query states its condition. Today's bounds
 * are the only range on `text`, so the seek reads the day's entries alone.
 */
const ENTRIES_SQL =
  "SELECT l.source_id AS parent_id, x.id AS id, x.type AS type, x.text AS text " +
  "FROM nodes x " +
  "CROSS JOIN link l ON l.user_id = :tenant AND l.destination_id = x.id " +
  "AND l.kind = 'child' AND l.deleted_at IS NULL " +
  "WHERE x.user_id = :tenant AND x.deleted_at IS NULL " +
  "AND substr(x.text, 1, 4) GLOB '[0-9][0-9][0-9][0-9]' " +
  "AND x.text >= ?1 AND x.text < ?2"

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
  // Every text of the day (`2026-11-02`, `2026-11-02 · 5 km`) sorts from
  // `2026-11-02` up to, not including, `2026-11-03`.
  const rows = await tenant.exec(ENTRIES_SQL, [day, addDays(day, 1)])
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
