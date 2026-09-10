import { useAtomValue } from "jotai"
import React from "react"
import { defaultCollapsedKeys } from "../blocks/default-collapsed"
import type { BlockDoc } from "../blocks/types"
import { hasOccurrence, idOfKey, occurrenceKeys } from "../blocks/view"
import { expandedLevelsAtom } from "../global-state"

/**
 * Collapse state for one note: per-device ephemera, not synced data
 * (docs/graph-schema-v2.md dropped the view_state table). Folds key by
 * occurrence (`src/blocks/view.ts`): a block that shows up twice in a note is
 * two rows, folded independently.
 *
 * A note the reader has never folded or unfolded is not stored at all: it
 * opens as the policy says (`defaultCollapsedKeys` at the reader's chosen
 * depth, Settings → Editor) every time, so changing that setting changes
 * every such note, and nothing accumulates for notes merely read. The first
 * fold the reader makes takes the note over: from then on its collapsed set
 * — collapsed means folded, everything else is open, one meaning per row —
 * is theirs, stored in localStorage and never re-seeded. Blocks added later
 * start expanded, and nothing rearranges behind them as the note grows.
 *
 * Storage is bounded: entries are pruned to the rows the note still has on
 * every write, and the least recently written notes fall off past
 * `MAX_STORED_NOTES`. Settings offers a reset that forgets every fold on the
 * device.
 */

/** Never mutated — every update builds a fresh set. */
const NOTHING_COLLAPSED: Set<string> = new Set()

const STORAGE_PREFIX = "collapse:"
const storageKey = (noteId: string) => `${STORAGE_PREFIX}${noteId}`

/** How many notes' folds a device keeps; the least recently written go first. */
export const MAX_STORED_NOTES = 500

/** The stored shape: the collapsed keys and when they were last written. */
interface StoredFolds {
  v: 2
  collapsed: string[]
  t: number
}

const asStrings = (x: unknown): string[] =>
  Array.isArray(x) ? x.filter((id): id is string => typeof id === "string") : []

/**
 * A stored entry as occurrence keys. Keys contain `/`; an entry without one
 * is a block id from before folds keyed by occurrence, and resolves to every
 * occurrence of that block — the fold people already had, wherever the block
 * shows up.
 */
function keysOfEntries(entries: string[], doc: BlockDoc): string[] {
  const all = occurrenceKeys(doc)
  const keys: string[] = []
  for (const entry of entries) {
    if (entry.includes("/")) keys.push(entry)
    else for (const key of all) if (idOfKey(key) === entry) keys.push(key)
  }
  return keys
}

/**
 * Tolerant read — the collapsed set the reader left on a note, or null when
 * nothing usable is stored (a note never folded on this device, cleared
 * storage, malformed JSON) and the caller should seed from the policy.
 *
 * Older shapes are read too, each as the reader's own folds: a bare array
 * (the previous model, which also stored policy seeds — those come back as
 * folds, the safe reading), and the two-layer `{ expanded, collapsed }`
 * override record before it, resolved against the document as
 * `(policy − expanded) ∪ collapsed`.
 */
export function readCollapsedKeys(noteId: string | undefined, doc: BlockDoc): Set<string> | null {
  if (!noteId || typeof localStorage === "undefined") return null
  try {
    const raw = localStorage.getItem(storageKey(noteId))
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (Array.isArray(parsed)) return new Set(keysOfEntries(asStrings(parsed), doc))
    if (parsed && typeof parsed === "object") {
      if ((parsed as { v?: unknown }).v === 2) {
        return new Set(keysOfEntries(asStrings((parsed as StoredFolds).collapsed), doc))
      }
      const legacy = parsed as { expanded?: unknown; collapsed?: unknown }
      const collapsed = new Set(defaultCollapsedKeys(doc))
      for (const key of keysOfEntries(asStrings(legacy.expanded), doc)) collapsed.delete(key)
      for (const key of keysOfEntries(asStrings(legacy.collapsed), doc)) collapsed.add(key)
      return collapsed
    }
    return null
  } catch {
    return null
  }
}

/** The last-written time of a stored entry (older shapes count as oldest). */
function storedTime(raw: string | null): number {
  if (!raw) return 0
  try {
    const parsed: unknown = JSON.parse(raw)
    const t = (parsed as { t?: unknown } | null)?.t
    return typeof t === "number" ? t : 0
  } catch {
    return 0
  }
}

/** Every note id with folds stored on this device. */
function storedNoteIds(): string[] {
  const ids: string[] = []
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i)
    if (key?.startsWith(STORAGE_PREFIX)) ids.push(key.slice(STORAGE_PREFIX.length))
  }
  return ids
}

/** Drop the least recently written entries beyond the cap. */
function pruneStoredNotes(keep: string) {
  const ids = storedNoteIds()
  if (ids.length <= MAX_STORED_NOTES) return
  const byAge = ids
    .filter((id) => id !== keep)
    .map((id) => ({ id, t: storedTime(localStorage.getItem(storageKey(id))) }))
    .sort((a, b) => a.t - b.t)
  for (const { id } of byAge.slice(0, ids.length - MAX_STORED_NOTES)) {
    localStorage.removeItem(storageKey(id))
  }
}

/**
 * Persist a note's collapsed set, dropping occurrences the document no longer
 * has so dead keys don't accumulate. An empty set is still written: it
 * records "the reader unfolded everything here", which must survive a reload
 * rather than invite a re-seed.
 */
export function writeCollapsedKeys(noteId: string, collapsed: ReadonlySet<string>, doc: BlockDoc) {
  if (typeof localStorage === "undefined") return
  try {
    const entry: StoredFolds = {
      v: 2,
      collapsed: [...collapsed].filter((key) => hasOccurrence(doc, key)),
      t: Date.now(),
    }
    localStorage.setItem(storageKey(noteId), JSON.stringify(entry))
    pruneStoredNotes(noteId)
  } catch {
    // Storage full/unavailable — collapse state is ephemeral by design.
  }
}

/** Forget every fold stored on this device; notes open as the policy says. */
export function clearStoredFolds(): number {
  if (typeof localStorage === "undefined") return 0
  const ids = storedNoteIds()
  for (const id of ids) localStorage.removeItem(storageKey(id))
  return ids.length
}

/**
 * Is there anything worth seeding from yet? The note store opens
 * asynchronously, so a note is briefly nothing but the editor's starter blank
 * on a cold load; seeding from that would show the real content, one tick
 * away, fully unfolded.
 */
function hasContent(doc: BlockDoc): boolean {
  return Object.values(doc.blocks).some((b) => b.text !== "" || b.children.length > 0)
}

interface CollapseState {
  /** The note this set belongs to — switching notes re-resolves. */
  noteId: string | undefined
  /** The policy depth the set was seeded at (re-seeds when the setting moves). */
  levels: number
  /** Whether the set is the reader's own (stored) rather than the policy's. */
  touched: boolean
  /** Whether there was content to resolve from yet. */
  seeded: boolean
  collapsed: Set<string>
}

/** The reader's stored folds for a note, else the policy's seed once there is
 * a document to seed from. Pure apart from the storage read. */
function resolve(noteId: string | undefined, doc: BlockDoc, levels: number): CollapseState {
  const stored = readCollapsedKeys(noteId, doc)
  if (stored) return { noteId, levels, touched: true, seeded: true, collapsed: stored }
  if (!hasContent(doc)) {
    return { noteId, levels, touched: false, seeded: false, collapsed: NOTHING_COLLAPSED }
  }
  return {
    noteId,
    levels,
    touched: false,
    seeded: true,
    collapsed: new Set(defaultCollapsedKeys(doc, levels)),
  }
}

/**
 * Collapse state for one note: the set of collapsed occurrence keys plus a
 * toggle.
 *
 * The set is resolved once per open — the reader's stored folds, else the
 * policy's seed — and after that only the reader's toggles move it, so
 * blocks created or nested while editing never snap shut. The first toggle
 * makes the set the reader's and starts persisting it; until then a change
 * to the depth setting re-seeds the note.
 */
export function useCollapseState(noteId: string | undefined, doc: BlockDoc) {
  const levels = useAtomValue(expandedLevelsAtom)
  const [state, setState] = React.useState<CollapseState>(() => resolve(noteId, doc, levels))

  // Resolve during render, not in an effect, so a seeded note never paints
  // fully unfolded first. Triggers: a different note, the arrival of content
  // for a note that was still empty when it mounted (see `hasContent`), and
  // a new depth setting on a note the reader has not touched. Each settles
  // in one extra render — the resolved state fails the condition it just
  // satisfied.
  if (
    state.noteId !== noteId ||
    (!state.seeded && hasContent(doc)) ||
    (!state.touched && state.levels !== levels)
  ) {
    setState(resolve(noteId, doc, levels))
  }

  // Pruning needs the live document, but the write must not fire on every
  // keystroke — it is keyed on the state object, which only a resolve or a
  // toggle replaces. Only the reader's own folds are written.
  const docRef = React.useRef(doc)
  docRef.current = doc
  React.useEffect(() => {
    if (state.touched && state.noteId)
      writeCollapsedKeys(state.noteId, state.collapsed, docRef.current)
  }, [state])

  const toggleCollapse = React.useCallback((key: string) => {
    setState((prev) => {
      const collapsed = new Set(prev.collapsed)
      if (!collapsed.delete(key)) collapsed.add(key)
      return { ...prev, touched: true, seeded: true, collapsed }
    })
  }, [])

  return { collapsed: state.collapsed, toggleCollapse }
}
