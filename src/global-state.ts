import { Searcher } from "fast-fuzzy"
import { atom } from "jotai"
import { atomWithStorage } from "jotai/utils"
import { GitHubUser, Note, NoteId, Width, githubUserSchema } from "./schema"
import {
  loadRecentVisits,
  saveRecentVisits,
  touchRecent,
  type RecentDestination,
  type RecentVisit,
} from "./utils/recents"
import { DEFAULT_NEW_BLOCK_MARKER } from "./blocks/markers"
import { DEFAULT_EXPANDED_LEVELS, clampExpandedLevels } from "./blocks/default-collapsed"
import { databaseGraphAtom, databaseModeStatusAtom } from "./data/database-mode"
import { isNoteType, rootChildIds, type GraphSnapshot } from "./data/graph"
import { asBlockType, type BlockType } from "./blocks/types"
import { orderedNoteIds } from "./data/note-order"
import {
  mergeSnapshots,
  receivedSharesAtom,
  sharedGraphAtom,
  sharedOriginAtom,
} from "./data/shared-mode"
import type { ReceivedShareSummary } from "./data/shares"
import { createNotesBuilder } from "./data/note-meta"
import { sampleGraph } from "./data/sample-graph"
import { pinnedIdsOf } from "./data/pins"
import { DEFAULT_ROOT_TAP, ROOT_TAPS, type RootTap } from "./data/root-frame"
import { GITHUB_USER_STORAGE_KEY, clearSession, seedSession } from "./utils/github-session"
import { createBlockIndexer, searchBlocks, type BlockHit } from "./utils/block-search"
import { parseQuery, type Query } from "./utils/search"

// -----------------------------------------------------------------------------
// Auth
// -----------------------------------------------------------------------------

/**
 * The GitHub identity: resolved once at boot, then changed only by sign-in
 * and sign-out. GitHub is identity only — the note corpus itself lives in the
 * database (docs/graph-storage.md): the local SQL store is the runtime store
 * and D1 behind the Worker is the authoritative cross-device copy, mounted by
 * `useDatabaseMode` whenever a user is signed in. Signed out, the sample
 * notes render instead.
 *
 * `undefined` is "still resolving" — the moment between the store mounting
 * and the stored session being read, which is synchronous, so nothing renders
 * in it; `null` is signed out.
 */
const githubUserStateAtom = atom<GitHubUser | null | undefined>(undefined)

/** Resolve the identity when the atom is first mounted: the OAuth redirect's
 * URL params win, then the stored session, else signed out. A resolved user
 * is remembered exactly as a sign-in is, so the live token session is seeded
 * on every boot. */
githubUserStateAtom.onMount = (set) => {
  const user = resolveStoredUser()
  if (user) rememberUser(user)
  else forgetUser()
  set(user)
}

/** Persist the user for the next boot and seed the live token session the
 * Worker API auth and refresh run on. */
function rememberUser(user: GitHubUser) {
  localStorage.setItem(GITHUB_USER_STORAGE_KEY, JSON.stringify(user))
  seedSession(user)
}

/** Forget the stored user and the live session. */
function forgetUser() {
  localStorage.removeItem(GITHUB_USER_STORAGE_KEY)
  clearSession()
}

/**
 * The identity to boot with. The OAuth callback hands the user over as URL
 * params (consumed and scrubbed from the address bar here); otherwise the
 * last sign-in is read back from localStorage. Anything unreadable — no
 * session, a stale shape — is signed out.
 */
function resolveStoredUser(): GitHubUser | null {
  const searchParams = new URLSearchParams(window.location.search)
  const token = searchParams.get("user_token")
  const id = searchParams.get("user_id")
  const login = searchParams.get("user_login")
  const name = searchParams.get("user_name")
  const email = searchParams.get("user_email")
  // Only treat these as set when actually present and finite (a missing
  // param is null → Number(null) is 0, which would look like "expired").
  const toEpoch = (raw: string | null) => {
    const n = raw != null ? Number(raw) : NaN
    return Number.isFinite(n) ? n : undefined
  }
  const accessExpires = toEpoch(searchParams.get("access_expires"))
  const refreshExpires = toEpoch(searchParams.get("refresh_expires"))

  if (token && login && name && email) {
    const idNumberRaw = id ? Number(id) : undefined
    const idNumber = Number.isFinite(idNumberRaw) ? idNumberRaw : undefined

    // Remove the auth metadata from the URL without a full reload
    // (window.location.replace would reload and race the localStorage
    // write below). replaceState keeps the SPA state intact.
    for (const key of [
      "user_token",
      "user_id",
      "user_login",
      "user_name",
      "user_email",
      "access_expires",
      "refresh_expires",
    ]) {
      searchParams.delete(key)
    }
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${searchParams.toString() ? `?${searchParams.toString()}` : ""}`,
    )

    return {
      token,
      id: idNumber,
      login,
      name,
      email,
      accessTokenExpiresAt: accessExpires,
      refreshTokenExpiresAt: refreshExpires,
    }
  }

  try {
    const stored = JSON.parse(localStorage.getItem(GITHUB_USER_STORAGE_KEY) ?? "null")
    return githubUserSchema.parse(stored)
  } catch {
    return null
  }
}

/** Sign in with a resolved GitHub user. */
export const signInAtom = atom(null, (_get, set, githubUser: GitHubUser) => {
  rememberUser(githubUser)
  set(githubUserStateAtom, githubUser)
})

/** Sign out. */
export const signOutAtom = atom(null, (_get, set) => {
  forgetUser()
  set(githubUserStateAtom, null)
})

export const githubUserAtom = atom((get) => get(githubUserStateAtom) ?? null)

/** Where the identity stands, for the dev bar. */
export const authStateAtom = atom((get) => {
  const user = get(githubUserStateAtom)
  return user === undefined ? "resolvingUser" : user === null ? "signedOut" : "signedIn"
})

/**
 * Signed in — the database-backed note corpus is the active experience: the
 * local SQL store serves the notes and D1 syncs them across devices
 * (docs/graph-storage.md). Signed out, the sample notes render instead. This
 * is also the "notes are ready" gate: the store serves local contents
 * immediately, so there is no loading screen to wait behind.
 */
export const isDatabaseModeAtom = atom((get) => get(githubUserAtom) !== null)

/**
 * The signed-out graph: the hard-coded sample blocks (`src/data/sample-graph.ts`),
 * held in memory. Edits made signed out apply to it and are gone on reload.
 */
export const sampleGraphAtom = atom<GraphSnapshot>(sampleGraph())

/**
 * The live graph — every node and child link, indexed for walking. Signed in
 * it is the local SQL store's rows (`src/data/database-mode.ts`) together
 * with the slices other people have shared with the user
 * (`src/data/shared-mode.ts`), so a shared note reads exactly like an own
 * one; signed out it is the sample graph. The editor walks its note out of
 * this rather than parsing markdown; every change is a batch of ops applied
 * to it (`src/data/ops.ts`), routed by origin at the write seam
 * (`src/data/store.ts`).
 */
export const graphSnapshotAtom = atom((get) =>
  get(isDatabaseModeAtom)
    ? mergeSnapshots(get(databaseGraphAtom), get(sharedGraphAtom))
    : get(sampleGraphAtom),
)

export const isSignedOutAtom = atom((get) => get(githubUserStateAtom) === null)

// -----------------------------------------------------------------------------
// Notes
// -----------------------------------------------------------------------------

// The builder's per-note memo lives in the module closure: on each graph
// change only notes whose reachable rows changed are re-derived; the rest
// keep their `Note` object.
const buildNotes = createNotesBuilder()

/** Every note node as a `Note` (src/data/note-meta.ts), read off the graph. */
export const notesAtom = atom((get) => buildNotes(get(graphSnapshotAtom)))

/**
 * Date (or week) id → the notes that reference it via date-valued
 * properties (e.g. a birthday or due date). Powers the calendar dots and the
 * day page's list of notes with the date (`DateMentions`).
 */
export const dateMentionsAtom = atom((get) => {
  const notes = get(notesAtom)
  const index: Map<NoteId, NoteId[]> = new Map()

  for (const note of notes.values()) {
    if (note.dates.length === 0) continue
    const uniqueDates = new Set(note.dates)
    for (const date of uniqueDates) {
      if (date === note.id) continue
      const mentions = index.get(date)
      if (mentions) {
        mentions.push(note.id)
      } else {
        index.set(date, [note.id])
      }
    }
  }

  return index
})

/**
 * Are the notes still on their way? True while the identity is being resolved
 * at boot, while the signed-in store is opening, and on a device with nothing
 * local yet, while the first pull is in flight — the moments the page and the
 * sidebar show skeletons instead of an empty corpus that is about to fill
 * (docs/design-principles.md, "Loading"). Never true signed out (the sample
 * notes are always there), after a first pull has landed, or once the store
 * has failed — those states say what they are.
 */
export const isBootingAtom = atom((get) => {
  if (get(githubUserStateAtom) === undefined) return true
  if (!get(isDatabaseModeAtom)) return false
  const status = get(databaseModeStatusAtom)
  if (status.status === "off" || status.status === "opening") return true
  return (
    status.pull === "pulling" &&
    status.lastPullAt === null &&
    !status.emptyOffline &&
    get(notesAtom).size === 0
  )
})

/** A–Z by the name on the row, with the opaque id breaking an exact tie so
 * the order is total (two notes can share a display name). */
const byDisplayName = (a: Note, b: Note) => {
  const byName = a.displayName.localeCompare(b.displayName)
  return byName !== 0 ? byName : a.id.localeCompare(b.id)
}

/** Most recently updated first; a note with no timestamp at all sorts to the
 * bottom, by name among its fellows: the order the board picker lists
 * boards in (`board-picker.tsx`). */
export const byUpdatedAt = (a: Note, b: Note) => {
  if (a.updatedAt !== null && b.updatedAt !== null) {
    if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt
  } else if (a.updatedAt !== null) {
    return -1
  } else if (b.updatedAt !== null) {
    return 1
  }
  return byDisplayName(a, b)
}

/** The notes page's order (`src/data/note-order.ts`): the ids the corpus
 * root holds, live ones only, in sort-key order. */
const noteOrderAtom = atom((get) => orderedNoteIds(get(graphSnapshotAtom)))

/**
 * Every note, in the notes page's order (docs/removing-views.md): the notes
 * the corpus root holds, in the order they were dragged into, then the notes
 * it does not, A–Z. The one order everything that lists notes uses (search,
 * the calendar, the block index), so no two surfaces disagree.
 */
export const sortedNotesAtom = atom((get) => {
  const notes = [...get(notesAtom).values()]
  const placed = get(noteOrderAtom)
  const rank = new Map(placed.map((id, index) => [id, index]))

  return notes.sort((a, b) => {
    // The manual band leads the notes with no position of their own; among
    // the placed, the dragged order decides.
    const aRank = rank.get(a.id)
    const bRank = rank.get(b.id)
    if (aRank !== undefined && bRank !== undefined) return aRank - bRank
    if (aRank !== undefined) return -1
    if (bRank !== undefined) return 1
    return byDisplayName(a, b)
  })
})

/** The user's OWN notes, every one, in `sortedNotesAtom` order. Shared
 * notes are in the graph too (search, hover cards and the editor read them
 * like any other) but are listed under Shared. */
export const ownSortedNotesAtom = atom((get) => {
  const origin = get(sharedOriginAtom)
  const notes = get(sortedNotesAtom)
  return origin.size === 0 ? notes : notes.filter((note) => !origin.has(note.id))
})

/**
 * The sidebar's **Notes** list (docs/removing-views.md): the rows of the
 * notes page, the Root frame (`rootChildIds`), as notes — the same notes in
 * the same order, so the two never disagree. Shared notes are left out, as
 * the notes page leaves them out: they are listed under Shared.
 */
export const rootNotesAtom = atom((get): Note[] => {
  const notes = get(notesAtom)
  if (notes.size === 0) return NO_NOTES
  const origin = get(sharedOriginAtom)
  const exclude = origin.size === 0 ? undefined : new Set(origin.keys())
  return rootChildIds(get(graphSnapshotAtom), exclude).flatMap((id) => {
    const note = notes.get(id)
    return note ? [note] : []
  })
})

const NO_NOTES: Note[] = []

/** The notes shared with the user, each with the share it came through, in
 * `sortedNotesAtom` order — one list, whoever shared them (the sidebar's
 * **Shared** section). */
export const sharedNotesAtom = atom((get) => {
  const origin = get(sharedOriginAtom)
  if (origin.size === 0) return [] as { note: Note; share: ReceivedShareSummary }[]
  const shares = new Map(get(receivedSharesAtom).map((share) => [share.id, share]))
  return get(sortedNotesAtom).flatMap((note) => {
    const share = shares.get(origin.get(note.id) ?? "")
    return share ? [{ note, share }] : []
  })
})

/** One row of the Pinned list: a note, or a block (`src/data/pins.ts`). */
export type PinnedEntry =
  | { kind: "note"; id: NoteId; noteId: NoteId; note: Note }
  | { kind: "block"; id: string; noteId: NoteId; block: PinnedBlock }

/**
 * **The Pinned list** (docs/removing-views.md): the user's own notes and
 * blocks that carry a pin (`pinned_at`), oldest pin first — what the
 * sidebar draws under **Pinned**, and the palette's Pinned group holds with
 * nothing typed. A pin is a prop of the node, so a node in a note someone
 * shared is never here: those are listed under Shared. A pinned node the
 * graph no longer reaches from a note is left out rather than drawn as a row
 * that opens nothing.
 */
export const pinnedEntriesAtom = atom((get): PinnedEntry[] => {
  const graph = get(graphSnapshotAtom)
  const ids = pinnedIdsOf(graph)
  if (ids.length === 0) return NO_PINS
  const origin = get(sharedOriginAtom)
  const notes = get(notesAtom)
  const blocks = new Map(get(pinnedBlocksAtom).map((block) => [block.id, block]))
  const entries: PinnedEntry[] = []
  for (const id of ids) {
    const note = notes.get(id)
    if (note) {
      if (!origin.has(id)) entries.push({ kind: "note", id, noteId: id, note })
      continue
    }
    const block = blocks.get(id)
    if (block && !origin.has(block.noteId)) {
      entries.push({ kind: "block", id, noteId: block.noteId, block })
    }
  }
  return entries
})

const NO_PINS: PinnedEntry[] = []

/** The Pinned list as roots the results editor can walk: a note opens
 * itself, a block opens its note focused on it. */
export const pinnedRootsAtom = atom((get) =>
  get(pinnedEntriesAtom).map(({ id, noteId }) => ({ id, noteId })),
)

export const noteSearcherAtom = atom((get) => {
  const sortedNotes = get(sortedNotesAtom)
  return new Searcher(sortedNotes, {
    // `note.id` is deliberately NOT a fuzzy key: minted ids are opaque
    // (docs/graph-storage.md), so matching them would only add noise —
    // every note would half-match a query containing "blk". The `id:` filter
    // still matches ids exactly (src/utils/search-notes.ts).
    keySelector: (note) => [note.title, note.displayName, note.text],
    threshold: 0.8,
  })
})

/**
 * The notes by TITLE only, for a results list: a note whose title matches
 * the text is a row among the matching blocks (`useSearchResults`), ranked
 * on the same 0–1 scale as the blocks, since both are fast-fuzzy at the one
 * threshold. A note whose body matched is not — its matching blocks are.
 */
export const noteTitleSearcherAtom = atom((get) => {
  const sortedNotes = get(sortedNotesAtom)
  return new Searcher(sortedNotes, {
    keySelector: (note) => [note.title, note.displayName],
    threshold: 0.8,
  })
})

// -----------------------------------------------------------------------------
// Blocks
// -----------------------------------------------------------------------------

// The indexer's per-note memo lives in the module closure: on each graph
// change only notes whose `Note` changed are re-walked (the rest reuse their
// block entries), which keeps the derived atom cheap at corpus scale.
const buildBlockIndex = createBlockIndexer()

/**
 * Every block in the corpus as a search hit (id, marker-free text, type,
 * ancestry, containing note), in document order grouped by note (notes in
 * `sortedNotesAtom` order). The index's fuzzy searcher is built lazily on
 * first block-text search, so pure `type:` queries never pay for it.
 */
export const blockIndexAtom = atom((get) =>
  buildBlockIndex(get(sortedNotesAtom), get(graphSnapshotAtom)),
)

/**
 * Block-granular search (`src/utils/block-search.ts`): resolves a query to
 * block hits — `type:todo` is every unchecked checkbox in the corpus,
 * composable with the whole `parseQuery` vocabulary (note-level qualifiers
 * filter by the containing note, fuzzy text matches the block's own text).
 */
export const searchBlocksAtom = atom((get) => {
  const index = get(blockIndexAtom)
  return (query: string | Query) =>
    searchBlocks(typeof query === "string" ? parseQuery(query) : query, index)
})

/**
 * A pinned BLOCK (`src/data/pins.ts`), and the note to open it in: its row
 * in the Pinned list opens that note focused on the block.
 */
export interface PinnedBlock {
  id: string
  /** The note the block opens in, focused: the note it was written in
   * while that note still reaches it, else the first note (in
   * `sortedNotesAtom` order) that does — a block can be held in several —
   * else, for a block no note reaches (one in a note's Unassigned basket),
   * the note it was written in, where the basket is. */
  noteId: NoteId
  /** The block's own text, marker-free. */
  text: string
  /** The block's type — what the sidebar's row draws the glyph of. */
  type: BlockType
  /** The note it opens in. */
  note: Note
}

const NO_PINNED_BLOCKS: PinnedBlock[] = []

/**
 * The pinned blocks, each with the note it opens in, in no order of their
 * own (`pinnedEntriesAtom` puts them in pin order). Blocks no note reaches
 * open in the note they were written in, where its basket is.
 */
const pinnedBlocksAtom = atom((get) => {
  const graph = get(graphSnapshotAtom)
  const pinnedIds = new Set<string>()
  for (const id of pinnedIdsOf(graph)) {
    const node = graph.nodes.get(id)
    if (node && !isNoteType(node.type)) pinnedIds.add(id)
  }
  if (pinnedIds.size === 0) return NO_PINNED_BLOCKS

  // Where each opens: its first hit in index order, unless a later hit is in
  // the note it was written in. A Map keeps a key's first position, so the
  // list stays in index order either way.
  const homes = new Map<string, BlockHit>()
  for (const hit of get(blockIndexAtom).hits) {
    if (!pinnedIds.has(hit.blockId)) continue
    const written = graph.nodes.get(hit.blockId)?.notes_id ?? null
    const held = homes.get(hit.blockId)
    if (!held || (hit.noteId === written && held.noteId !== written)) homes.set(hit.blockId, hit)
  }
  const blocks: PinnedBlock[] = []
  for (const [id, hit] of homes) {
    blocks.push({
      id,
      noteId: hit.noteId,
      text: hit.text,
      type: hit.type,
      note: hit.note,
    })
  }
  const notes = get(notesAtom)
  for (const id of pinnedIds) {
    if (homes.has(id)) continue
    const node = graph.nodes.get(id)
    const note = node?.notes_id ? notes.get(node.notes_id) : undefined
    if (!node || !note) continue
    blocks.push({
      id,
      noteId: note.id,
      text: node.text,
      type: asBlockType(node.type),
      note,
    })
  }
  return blocks
})

// -----------------------------------------------------------------------------
// UI state
// -----------------------------------------------------------------------------

/**
 * The user-selectable accent color. Each value maps to a Radix ramp remapped
 * onto the `--accent-*` token family via `[data-accent]` blocks in
 * src/styles/variables.css. "cyan" is the default and needs no attribute.
 */
export type AccentColor = "cyan" | "neutral" | "green" | "violet" | "amber"

export const accentAtom = atomWithStorage<AccentColor>("accent", "cyan")

/**
 * The colour scheme: light, dark, or the device's own ("system"). Resolved
 * and stamped on <html> as `data-theme` by `useColorScheme`
 * (src/hooks/color-scheme.ts), which every stylesheet keys off; index.html
 * does the same inline before first paint.
 */
export type Theme = "system" | "light" | "dark"

export const themeAtom = atomWithStorage<Theme>("theme", "system")

export const sidebarAtom = atomWithStorage<"expanded" | "collapsed">("sidebar", "expanded")

/**
 * A stored flag, read now rather than when the atom mounts: the layout is
 * built for the help panel's real state from its first render, since the
 * app-layout opens the panel with motion when this changes, and a reload
 * is not a change.
 */
function storedFlag(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(key)
    return raw === null ? fallback : JSON.parse(raw) === true
  } catch {
    return fallback
  }
}

export const isHelpPanelOpenAtom = atomWithStorage<boolean>(
  "help-panel",
  storedFlag("help-panel", false),
)

/**
 * Move the keyboard to the other pane of a split view (`g p`,
 * docs/split-view.md). The note page sets it while two panes are on screen;
 * null otherwise, and the chord does nothing.
 */
export const otherPaneAtom = atom<(() => void) | null>(null)

/**
 * The places VISITED on this device — a note, or a block focused on in one
 * — each with a timestamp and a frecency score, at most `RECENT_KEEP`
 * (`src/utils/recents.ts`), under the one storage key, overwritten whole.
 * Read once at load; written through `touchRecentAtom`, which coalesces (a
 * destination is written at most once a second) and writes only when the
 * list changed. The palette ranks these, with the graph's `updatedAt`, into
 * its **Recent** list (`useRecentRoots`).
 */
export const recentVisitsAtom = atom<readonly RecentVisit[]>(
  loadRecentVisits(typeof localStorage === "undefined" ? null : localStorage),
)

export const touchRecentAtom = atom(
  null,
  (get, set, destination: RecentDestination, now: number = Date.now()) => {
    const visits = get(recentVisitsAtom)
    const next = touchRecent(visits, destination, now)
    if (next === visits) return
    set(recentVisitsAtom, next)
    saveRecentVisits(typeof localStorage === "undefined" ? null : localStorage, next)
  },
)

export const calendarLayoutAtom = atomWithStorage<"week" | "month">("calendar-layout", "week")

/** How a day's changes are listed on the calendar (`DayChanges`): by the
 * note they were made in, or in the order they were made. */
export const calendarChangesViewAtom = atomWithStorage<"notes" | "timeline">(
  "calendar-changes-view",
  "notes",
)

/**
 * The markdown a new block starts with when Enter creates one in the block
 * editor (from anything but a list item, which continues its own list), and
 * what Enter on an empty list item leaves it as. `"- "` by default; `""` makes
 * Enter produce plain paragraphs. Read by
 * `BlockEditor` and handed to the command layer via `CommandInput`.
 */
export const newBlockMarkerAtom = atomWithStorage<string>(
  "new-block-marker",
  DEFAULT_NEW_BLOCK_MARKER,
)

/**
 * Settings this device may still hold from a build that had them, and no
 * build reads now: "Show links" (`link-directions`), which pivots replaced
 * (docs/graph-walk.md, GW-18). Forgotten once at boot.
 */
const RETIRED_SETTINGS = ["link-directions"]

export function forgetRetiredSettings(storage: Pick<Storage, "removeItem"> | undefined) {
  try {
    for (const key of RETIRED_SETTINGS) storage?.removeItem(key)
  } catch {
    // Storage refused (a private window): nothing to forget.
  }
}

/**
 * How many levels a note opens with beneath a heading or its top, until the
 * reader folds or unfolds something themselves (Settings → Editor; see
 * `defaultCollapsedKeys`). Stored on this device.
 */
const storedExpandedLevelsAtom = atomWithStorage<number>("expanded-levels", DEFAULT_EXPANDED_LEVELS)
export const expandedLevelsAtom = atom(
  (get) => clampExpandedLevels(get(storedExpandedLevelsAtom)),
  (_get, set, value: number) => set(storedExpandedLevelsAtom, clampExpandedLevels(value)),
)

/**
 * How wide a note's text column is: `fixed` (700px, centred) or `full` (the
 * pane's width). Settings → Editor, for the whole app; a pane in a split can
 * override it for itself (`src/data/panes.ts`, `withPaneWidth`), kept only
 * while that pane lives. Stored on this device.
 */
export const pageWidthAtom = atomWithStorage<Width>("page-width", "fixed")

/**
 * What a tap on a note of the notes page does (`RootTap`,
 * `src/data/root-frame.ts`): open it on a phone, everywhere, or never.
 * Settings → Editor. Stored on this device; a value this build does not
 * know reads as the default.
 */
const storedRootTapAtom = atomWithStorage<RootTap>("root-tap", DEFAULT_ROOT_TAP)
export const rootTapAtom = atom(
  (get) => {
    const stored = get(storedRootTapAtom)
    return ROOT_TAPS.includes(stored) ? stored : DEFAULT_ROOT_TAP
  },
  (_get, set, value: RootTap) => set(storedRootTapAtom, value),
)
