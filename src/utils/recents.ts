import type { Note, NoteId } from "../schema"

/**
 * **Recents** — what the ⌘K palette offers with nothing typed, and what the
 * notes page lists above its Views: the places most used lately, at most
 * `RECENT_LIMIT` of them, ranked by FRECENCY — how often, weighted by how
 * recently.
 *
 * A place is a DESTINATION: a note, or a block focused on within one — so
 * unfolding Personal and focusing on Fashion counts Fashion, not Personal,
 * and the Recent row opens straight onto it. A destination is visited when
 * it is opened (from the Views page, the palette, a link, or by focusing on
 * it in the editor), edited, or a block in it folded or unfolded, on this
 * device; and a note is visited, too, when it is edited anywhere else (the
 * graph's `updatedAt`, which every device sees). Never by selecting,
 * focusing or arrowing through it: reading a note is not visiting it.
 *
 * The score is one number per destination that halves every
 * `RECENT_HALF_LIFE_MS`: a visit decays what was there and adds one. Touches
 * within `VISIT_WINDOW_MS` of the last are the same visit — an afternoon's
 * editing is one visit, not a thousand — so what rises is what is come back
 * to. The list is bounded: at most `RECENT_KEEP` destinations, a timestamp
 * and a score each, under one storage key that overwrites itself, never a
 * log that grows. A destination is written at most once per
 * `TOUCH_COALESCE_MS`, so a selection walking through a note writes once,
 * not per row.
 */

/** One destination and its standing: where it opens, when it was last
 * visited, and its score as of then. `id` is the note's own id for a note,
 * the block's for a block. */
export interface RecentVisit {
  id: string
  noteId: NoteId
  at: number
  score: number
}

/** A destination — what a Recent row opens. */
export interface RecentDestination {
  id: string
  noteId: NoteId
}

/** How many destinations Recent lists. */
export const RECENT_LIMIT = 5

/** How many destinations are kept, so a place visited often but not lately
 * still has a score to come back to. */
export const RECENT_KEEP = 50

/** How long a score takes to halve. */
export const RECENT_HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000

/** How long after a visit a further touch is still the same visit. */
export const VISIT_WINDOW_MS = 30 * 60 * 1000

/** How long a destination keeps its timestamp before a further touch writes
 * again. */
export const TOUCH_COALESCE_MS = 1000

/** How long after this device last visited a note an edit to it is still
 * this device's own (`updatedAt` lands a moment after the touch). */
const OWN_EDIT_SLACK_MS = 60 * 1000

/** The storage key the visits live under — the one key, overwritten. */
export const RECENT_STORAGE_KEY = "recent-visits"

/** Where the list lived when it held notes only, a timestamp each: read
 * once to carry it over, then removed. */
const LEGACY_STORAGE_KEY = "recent-notes"

/** What a score of `score` as of `at` has decayed to by `now`. */
function decayed(score: number, at: number, now: number): number {
  return score * Math.pow(2, -Math.max(0, now - at) / RECENT_HALF_LIFE_MS)
}

/**
 * The visits after touching `destination` at `now`. Within `VISIT_WINDOW_MS`
 * of its last visit the touch only moves the timestamp on; after it, the
 * score decays and gains one. The list is cut to `RECENT_KEEP`, the lowest
 * scores going. Returns the SAME list when nothing would change — the
 * destination was touched within `TOUCH_COALESCE_MS` — so the caller writes
 * nothing.
 */
export function touchRecent(
  visits: readonly RecentVisit[],
  destination: RecentDestination,
  now: number,
): readonly RecentVisit[] {
  const { id, noteId } = destination
  const held = visits.find((visit) => visit.id === id)
  if (held && held.noteId === noteId && now - held.at < TOUCH_COALESCE_MS) return visits
  const score = held
    ? decayed(held.score, held.at, now) + (now - held.at < VISIT_WINDOW_MS ? 0 : 1)
    : 1
  const next = [{ id, noteId, at: now, score }, ...visits.filter((visit) => visit.id !== id)]
  if (next.length <= RECENT_KEEP) return next
  return next
    .map((visit) => ({ visit, standing: decayed(visit.score, visit.at, now) }))
    .sort((a, b) => b.standing - a.standing || b.visit.at - a.visit.at)
    .slice(0, RECENT_KEEP)
    .map(({ visit }) => visit)
}

/**
 * The Recent list: the visits merged with every note's `updatedAt`, ranked
 * by score as of `now` (the latest visit breaking a tie), each destination
 * once, the top `limit`. A note's `updatedAt` counts as one visit when it is
 * later than anything this device did in that note — an edit made elsewhere;
 * an edit made here is already a visit. A destination that no longer exists
 * — its note gone, or (for a block) the block — is simply not there.
 */
export function rankRecents(
  visits: readonly RecentVisit[],
  notes: readonly Note[],
  hasBlock: (id: string) => boolean,
  now: number,
  limit = RECENT_LIMIT,
): RecentDestination[] {
  const noteIds = new Set(notes.map((note) => note.id))
  const ranked = new Map<string, { destination: RecentDestination; score: number; at: number }>()
  const lastHere = new Map<NoteId, number>()
  for (const visit of visits) {
    if (!noteIds.has(visit.noteId)) continue
    if (visit.id !== visit.noteId && !hasBlock(visit.id)) continue
    lastHere.set(visit.noteId, Math.max(lastHere.get(visit.noteId) ?? 0, visit.at))
    ranked.set(visit.id, {
      destination: { id: visit.id, noteId: visit.noteId },
      score: decayed(visit.score, visit.at, now),
      at: visit.at,
    })
  }
  for (const note of notes) {
    if (note.updatedAt === null) continue
    const here = lastHere.get(note.id)
    if (here !== undefined && note.updatedAt <= here + OWN_EDIT_SLACK_MS) continue
    const held = ranked.get(note.id)
    const score = decayed(1, note.updatedAt, now)
    ranked.set(note.id, {
      destination: { id: note.id, noteId: note.id },
      score: (held?.score ?? 0) + score,
      at: Math.max(held?.at ?? 0, note.updatedAt),
    })
  }
  return [...ranked.values()]
    .sort((a, b) => b.score - a.score || b.at - a.at)
    .slice(0, limit)
    .map(({ destination }) => destination)
}

/** A storage the visits can live in (`localStorage`, or a stand-in). */
export interface RecentStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

const isVisit = (visit: unknown): visit is RecentVisit =>
  typeof visit === "object" &&
  visit !== null &&
  typeof (visit as RecentVisit).id === "string" &&
  typeof (visit as RecentVisit).noteId === "string" &&
  typeof (visit as RecentVisit).at === "number" &&
  typeof (visit as RecentVisit).score === "number"

/** The notes-only list the visits replaced, as visits: each note once, a
 * score of one as of its last touch. */
function legacyVisits(raw: string): RecentVisit[] {
  const parsed: unknown = JSON.parse(raw)
  if (!Array.isArray(parsed)) return []
  return parsed.flatMap((touch: unknown) => {
    const { id, at } = (touch ?? {}) as { id?: unknown; at?: unknown }
    return typeof id === "string" && typeof at === "number"
      ? [{ id, noteId: id, at, score: 1 }]
      : []
  })
}

/** The visits saved on this device — none when there are none, or when
 * what is there is not a list of visits (a stray edit). The notes-only list
 * an older build saved is carried over the first time. */
export function loadRecentVisits(storage: RecentStorage | null | undefined): RecentVisit[] {
  try {
    const raw = storage?.getItem(RECENT_STORAGE_KEY)
    if (!raw) {
      const legacy = storage?.getItem(LEGACY_STORAGE_KEY)
      return legacy ? legacyVisits(legacy).slice(0, RECENT_KEEP) : []
    }
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isVisit).slice(0, RECENT_KEEP)
  } catch {
    return []
  }
}

/** Save the visits — the one key, overwritten whole (and the notes-only
 * key an older build wrote, gone). */
export function saveRecentVisits(
  storage: RecentStorage | null | undefined,
  visits: readonly RecentVisit[],
): void {
  try {
    storage?.setItem(RECENT_STORAGE_KEY, JSON.stringify(visits.slice(0, RECENT_KEEP)))
    storage?.removeItem(LEGACY_STORAGE_KEY)
  } catch {
    // Storage full, or refused (a private window): the list lives on in
    // memory for the session.
  }
}
