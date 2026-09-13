import type { Note, NoteId } from "../schema"

/**
 * **Recent notes** — what the ⌘K palette offers with nothing typed: the
 * notes most recently TOUCHED, at most `RECENT_LIMIT`. A note is touched
 * when it is edited or created (the graph's `updatedAt`, which every device
 * sees) and when it is interacted with — opened, a block in it focused or
 * selected, folded or unfolded (a small list kept on this device,
 * `RecentTouch[]`). The two are merged, most recent first, deduped.
 *
 * The interaction list is deliberately tiny: one entry per note, at most
 * `RECENT_LIMIT` of them, a timestamp each — a few dozen bytes under one
 * storage key that overwrites itself, never a log that grows. A note
 * already at the top is bumped at most once per `TOUCH_COALESCE_MS`, so a
 * selection walking through a note writes once, not per row.
 */

/** One touch: the note, and when. */
export interface RecentTouch {
  id: NoteId
  at: number
}

/** How many notes Recent lists, and how many touches are kept. */
export const RECENT_LIMIT = 5

/** How long a note at the top of the list keeps its timestamp before a
 * further touch bumps it again. */
export const TOUCH_COALESCE_MS = 1000

/** The storage key the touches live under — the one key, overwritten. */
export const RECENT_STORAGE_KEY = "recent-notes"

/**
 * The touches after touching `id` at `now`: the note moves to the front
 * with the new timestamp, and the list is cut to `RECENT_LIMIT`. Returns
 * the SAME list when nothing would change — the note is already first and
 * was touched within `TOUCH_COALESCE_MS` — so the caller writes nothing.
 */
export function touchRecent(
  touches: readonly RecentTouch[],
  id: NoteId,
  now: number,
): readonly RecentTouch[] {
  const first = touches[0]
  if (first && first.id === id && now - first.at < TOUCH_COALESCE_MS) return touches
  return [{ id, at: now }, ...touches.filter((touch) => touch.id !== id)].slice(0, RECENT_LIMIT)
}

/**
 * The recent notes: the touches merged with every note's `updatedAt`, most
 * recent first, each note once, the top `limit` — as `Note`s, so a touch
 * of a note that no longer exists is simply not there.
 */
export function recentNotes(
  touches: readonly RecentTouch[],
  notes: readonly Note[],
  limit = RECENT_LIMIT,
): Note[] {
  const byId = new Map(notes.map((note) => [note.id, note]))
  const latest = new Map<NoteId, number>()
  for (const note of notes) {
    if (note.updatedAt !== null) latest.set(note.id, note.updatedAt)
  }
  for (const touch of touches) {
    if (!byId.has(touch.id)) continue
    latest.set(touch.id, Math.max(latest.get(touch.id) ?? 0, touch.at))
  }
  return [...latest.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id]) => byId.get(id)!)
}

/** A storage the touches can live in (`localStorage`, or a stand-in). */
export interface TouchStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** The touches saved on this device — none when there are none, or when
 * what is there is not a list of touches (an old shape, a stray edit). */
export function loadRecentTouches(storage: TouchStorage | null | undefined): RecentTouch[] {
  try {
    const raw = storage?.getItem(RECENT_STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter(
        (touch): touch is RecentTouch =>
          typeof touch === "object" &&
          touch !== null &&
          typeof (touch as RecentTouch).id === "string" &&
          typeof (touch as RecentTouch).at === "number",
      )
      .slice(0, RECENT_LIMIT)
  } catch {
    return []
  }
}

/** Save the touches — the one key, overwritten whole. */
export function saveRecentTouches(
  storage: TouchStorage | null | undefined,
  touches: readonly RecentTouch[],
): void {
  try {
    storage?.setItem(RECENT_STORAGE_KEY, JSON.stringify(touches.slice(0, RECENT_LIMIT)))
  } catch {
    // Storage full, or refused (a private window): the list lives on in
    // memory for the session.
  }
}
