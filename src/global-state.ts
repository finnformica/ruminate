import { Searcher } from "fast-fuzzy"
import { atom } from "jotai"
import { atomWithStorage } from "jotai/utils"
import { GitHubUser, Note, NoteId, githubUserSchema } from "./schema"
import {
  loadRecentTouches,
  saveRecentTouches,
  touchRecent,
  type RecentTouch,
} from "./utils/recent-notes"
import { DEFAULT_NEW_BLOCK_MARKER } from "./blocks/markers"
import { DEFAULT_EXPANDED_LEVELS, clampExpandedLevels } from "./blocks/default-collapsed"
import { databaseGraphAtom, databaseModeStatusAtom } from "./data/database-mode"
import { NOTE_TYPE, parseProps, type GraphSnapshot } from "./data/graph"
import {
  mergeSnapshots,
  receivedSharesAtom,
  sharedGraphAtom,
  sharedOriginAtom,
} from "./data/shared-mode"
import type { ReceivedShareSummary } from "./data/shares"
import { createNotesBuilder } from "./data/note-meta"
import { sampleGraph } from "./data/sample-graph"
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
 * date/week hover cards.
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

export const sortedNotesAtom = atom((get) => {
  const notes = get(notesAtom)

  // Sort notes by updatedAt in descending order (most recent first)
  return [...notes.values()].sort((a, b) => {
    // Pinned notes first
    if (a.pinned && !b.pinned) return -1
    if (!a.pinned && b.pinned) return 1

    // Then by updatedAt descending (most recent first)
    // Notes without updatedAt (null) sort to bottom
    if (a.updatedAt !== null && b.updatedAt !== null) {
      if (a.updatedAt !== b.updatedAt) {
        return b.updatedAt - a.updatedAt
      }
    } else if (a.updatedAt !== null) {
      return -1 // a has timestamp, b doesn't -> a first
    } else if (b.updatedAt !== null) {
      return 1 // b has timestamp, a doesn't -> b first
    }

    // Last resort, for notes with no timestamp at all: order by name, which is
    // at least meaningful to a human. (Ids used to carry a hint — a numeric id
    // was a creation timestamp — but minted ids are opaque, so ordering by
    // them would be arbitrary as well as unstable across a rename.)
    const byName = a.displayName.localeCompare(b.displayName)
    return byName !== 0 ? byName : a.id.localeCompare(b.id)
  })
})

/** The user's OWN notes, in `sortedNotesAtom` order — what the sidebar lists
 * under Notes. Shared notes are in the graph too (search, hover cards and
 * the editor read them like any other) but are listed under Shared. */
export const ownSortedNotesAtom = atom((get) => {
  const origin = get(sharedOriginAtom)
  const notes = get(sortedNotesAtom)
  return origin.size === 0 ? notes : notes.filter((note) => !origin.has(note.id))
})

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

/** The pinned notes, in `sortedNotesAtom`'s order (they lead it): the
 * palette's **Pinned** group with nothing typed. */
export const pinnedNotesAtom = atom((get) => {
  const sortedNotes = get(sortedNotesAtom)
  return sortedNotes.filter((note) => note.pinned)
})

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
 * A pinned BLOCK (docs/metadata.md): a block with `pinned` in its props,
 * and the note to open it in. Pinning a note puts it at the top of the
 * sidebar's notes; pinning a block puts the block in the sidebar's
 * **Pinned** list (and the palette's Pinned group), from where it opens
 * zoomed into — a focused view of that one block and what is beneath it.
 */
export interface PinnedBlock {
  id: string
  /** The note the block opens in, zoomed: the note it was written in
   * while that note still reaches it, else the first note (in
   * `sortedNotesAtom` order) that does — a block can be held in several —
   * else, for a block no note reaches (one in a note's Unassigned basket),
   * the note it was written in, where the basket is. */
  noteId: NoteId
  /** The block's own text, marker-free. */
  text: string
  /** The note it opens in. */
  note: Note
}

const NO_PINNED_BLOCKS: PinnedBlock[] = []

/**
 * The pinned blocks, in the block index's order (the notes'
 * `sortedNotesAtom` order, document order within a note) — the user's own
 * only: a block in a note someone shared with them carries the owner's pin,
 * not theirs. Blocks no note reaches come last.
 */
export const pinnedBlocksAtom = atom((get) => {
  const graph = get(graphSnapshotAtom)
  const origin = get(sharedOriginAtom)
  // The cheap pass: a pinned block's props JSON names the key, so nothing
  // else is parsed.
  const pinnedIds = new Set<string>()
  for (const node of graph.nodes.values()) {
    if (node.type === NOTE_TYPE || node.props === null || !node.props.includes('"pinned"')) continue
    if (origin.has(node.id)) continue
    if (parseProps(node.props)?.pinned === true) pinnedIds.add(node.id)
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
    blocks.push({ id, noteId: hit.noteId, text: hit.text, note: hit.note })
  }
  const notes = get(notesAtom)
  for (const id of pinnedIds) {
    if (homes.has(id)) continue
    const node = graph.nodes.get(id)
    const note = node?.notes_id ? notes.get(node.notes_id) : undefined
    if (!node || !note) continue
    blocks.push({ id, noteId: note.id, text: node.text, note })
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

export const isHelpPanelOpenAtom = atomWithStorage<boolean>("help-panel", false)

/**
 * The notes recently TOUCHED on this device — opened, a block in them
 * focused, selected, folded or edited — at most five, a timestamp each
 * (`src/utils/recent-notes.ts`), under the one storage key, overwritten
 * whole. Read once at load; written through `touchNoteAtom`, which
 * coalesces (a note already first is bumped at most once a second) and
 * writes only when the list changed. The palette merges these with the
 * graph's `updatedAt` for its **Recent** list (`recentNotes`).
 */
export const recentTouchesAtom = atom<readonly RecentTouch[]>(
  loadRecentTouches(typeof localStorage === "undefined" ? null : localStorage),
)

export const touchNoteAtom = atom(null, (get, set, noteId: NoteId, now: number = Date.now()) => {
  const touches = get(recentTouchesAtom)
  const next = touchRecent(touches, noteId, now)
  if (next === touches) return
  set(recentTouchesAtom, next)
  saveRecentTouches(typeof localStorage === "undefined" ? null : localStorage, next)
})

export const calendarLayoutAtom = atomWithStorage<"week" | "month">("calendar-layout", "week")

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
 * How many levels a note opens with beneath a heading or its top, until the
 * reader folds or unfolds something themselves (Settings → Editor; see
 * `defaultCollapsedKeys`). Stored on this device.
 */
const storedExpandedLevelsAtom = atomWithStorage<number>("expanded-levels", DEFAULT_EXPANDED_LEVELS)
export const expandedLevelsAtom = atom(
  (get) => clampExpandedLevels(get(storedExpandedLevelsAtom)),
  (_get, set, value: number) => set(storedExpandedLevelsAtom, clampExpandedLevels(value)),
)
