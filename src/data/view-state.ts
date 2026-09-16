import { useAtomValue } from "jotai"
import React from "react"
import { expandedByDepth } from "../blocks/default-collapsed"
import { idOfKey, type ExpandedRule } from "../blocks/view"
import { expandedLevelsAtom } from "../global-state"

/**
 * Fold state for one note: per-device ephemera, not synced data
 * (docs/graph-schema-v2.md dropped the view_state table). Folds key by
 * occurrence (`src/blocks/view.ts`): a block that shows up twice in a note is
 * two rows, folded independently.
 *
 * Two layers, one answer. The depth setting (`expandedByDepth`, Settings →
 * Editor) is a standing rule that decides every row the reader has not
 * touched. Over it sit the reader's own folds — the rows they closed AND the
 * rows they opened, each remembered explicitly, so a row they opened stays
 * open when the setting moves and a row they closed stays closed when the
 * note grows around it. A row with no entry follows the rule, which is what
 * lets the walk be lazy (`walkGraph`): a row reached for the first time has
 * an answer without a document to seed from.
 *
 * Storage is bounded: entries are per note (`collapse:<noteId>`), only notes
 * the reader has folded or unfolded are stored, and the least recently
 * written fall off past `MAX_STORED_NOTES`. Settings offers a reset that
 * forgets every fold on the device. Nothing is pruned against the document:
 * a lazy doc does not hold the rows beneath a fold, and a fold on a row that
 * has since gone is inert.
 */

const STORAGE_PREFIX = "collapse:"
const storageKey = (noteId: string) => `${STORAGE_PREFIX}${noteId}`

/** How many notes' folds a device keeps; the least recently written go first. */
export const MAX_STORED_NOTES = 500

/** The reader's explicit folds on one note. Never mutated — every update
 * builds fresh sets. */
export interface Folds {
  /** Occurrence keys the reader opened (over a rule that would close them). */
  open: ReadonlySet<string>
  /** Occurrence keys the reader closed. */
  closed: ReadonlySet<string>
}

const NO_FOLDS: Folds = { open: new Set(), closed: new Set() }

/** The stored shape: both lists and when they were last written. */
interface StoredFolds {
  v: 3
  open: string[]
  closed: string[]
  t: number
}

const asStrings = (x: unknown): string[] =>
  Array.isArray(x) ? x.filter((id): id is string => typeof id === "string") : []

/**
 * Tolerant read — the folds the reader left on a note, or null when nothing
 * usable is stored (a note never folded on this device, cleared storage,
 * malformed JSON).
 *
 * Older shapes are read too, each as the reader's own folds: the `v: 2`
 * collapsed set and the bare array before it (which also stored policy
 * seeds — those come back as folds, the safe reading), and the two-layer
 * `{ expanded, collapsed }` record before that, which was this shape all
 * along. An entry without a `/` is a block id from before folds keyed by
 * occurrence, and applies to every occurrence of that block (`foldRule`).
 */
export function readFolds(noteId: string | undefined): Folds | null {
  if (!noteId || typeof localStorage === "undefined") return null
  try {
    const raw = localStorage.getItem(storageKey(noteId))
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (Array.isArray(parsed)) return { open: new Set(), closed: new Set(asStrings(parsed)) }
    if (parsed && typeof parsed === "object") {
      const record = parsed as { v?: unknown; open?: unknown; closed?: unknown }
      if (record.v === 3) {
        return { open: new Set(asStrings(record.open)), closed: new Set(asStrings(record.closed)) }
      }
      const legacy = parsed as { expanded?: unknown; collapsed?: unknown }
      const open = new Set(asStrings(legacy.expanded))
      const closed = new Set(asStrings(legacy.collapsed))
      // The old record could name a row in both directions (a stuck fold):
      // the reader's last word is a guess, so let the rule decide it.
      for (const key of [...open]) {
        if (!closed.has(key)) continue
        open.delete(key)
        closed.delete(key)
      }
      return { open, closed }
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

/** Persist a note's folds. Empty lists are still written: they record that
 * the reader's last toggle put a row back where the rule has it. */
export function writeFolds(noteId: string, folds: Folds) {
  if (typeof localStorage === "undefined") return
  try {
    const entry: StoredFolds = {
      v: 3,
      open: [...folds.open],
      closed: [...folds.closed],
      t: Date.now(),
    }
    localStorage.setItem(storageKey(noteId), JSON.stringify(entry))
    pruneStoredNotes(noteId)
  } catch {
    // Storage full/unavailable — fold state is ephemeral by design.
  }
}

/**
 * The rule a view descends by: the reader's explicit folds over the depth
 * rule. A key's own entry wins; failing that an entry naming its block id
 * (a fold from before occurrence keys) applies to every occurrence; failing
 * both, the depth rule decides.
 */
export function foldRule(folds: Folds, byDepth: ExpandedRule): ExpandedRule {
  return (key, level) => {
    if (folds.closed.has(key)) return false
    if (folds.open.has(key)) return true
    const id = idOfKey(key)
    if (id !== key) {
      if (folds.closed.has(id)) return false
      if (folds.open.has(id)) return true
    }
    return byDepth(key, level)
  }
}

/** `folds` with `key` set open or closed — and any bare-id entry for its
 * block dropped, so the reader's toggle is never outvoted by an old record. */
export function withFold(folds: Folds, key: string, open: boolean): Folds {
  const id = idOfKey(key)
  const next = {
    open: new Set(folds.open),
    closed: new Set(folds.closed),
  }
  next.open.delete(key)
  next.closed.delete(key)
  next.open.delete(id)
  next.closed.delete(id)
  if (open) next.open.add(key)
  else next.closed.add(key)
  return next
}

/**
 * Fold state for one note: the rule its view is walked by, and the way to
 * move a row. `setFold(key, open)` records the reader's decision for that
 * row (and persists it, when there is a note to persist under); the owner of
 * the view — which knows what is folded right now — turns a toggle into
 * one. Without a note id (Storybook / standalone) nothing is stored.
 */
export function useFoldRule(noteId: string | undefined) {
  const levels = useAtomValue(expandedLevelsAtom)
  const [state, setState] = React.useState<{ noteId: string | undefined; folds: Folds }>(() => ({
    noteId,
    folds: readFolds(noteId) ?? NO_FOLDS,
  }))
  // Re-read during render on a different note, so the new note never paints
  // with the old note's folds. Settles in one extra render.
  if (state.noteId !== noteId) setState({ noteId, folds: readFolds(noteId) ?? NO_FOLDS })

  const expanded = React.useMemo(
    () => foldRule(state.folds, expandedByDepth(levels)),
    [state.folds, levels],
  )

  const setFold = React.useCallback((key: string, open: boolean) => {
    setState((prev) => {
      const folds = withFold(prev.folds, key, open)
      if (prev.noteId) writeFolds(prev.noteId, folds)
      return { ...prev, folds }
    })
  }, [])

  return { expanded, setFold, folds: state.folds }
}
