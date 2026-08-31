import React from "react"
import { defaultCollapsedIds } from "../blocks/default-collapsed"
import type { BlockDoc } from "../blocks/types"

/**
 * Collapse state for one note: per-device ephemera, not synced data
 * (docs/graph-schema-v2.md dropped the view_state table). Storage is a single
 * set of collapsed block ids per note in localStorage — collapsed means
 * folded, everything else is open — so a block can never hold two opinions at
 * once.
 *
 * The default-expansion policy (`defaultCollapsedIds`: headings always
 * expanded, two levels below, deeper collapsed) SEEDS that set the first time
 * a note is opened here and is never consulted again. After that, folding
 * belongs to the reader: blocks added later start expanded, and nothing
 * rearranges behind you as a note grows. A device that loses its localStorage
 * simply re-seeds on the next open.
 */

/** Never mutated — every update builds a fresh set. */
const NOTHING_COLLAPSED: Set<string> = new Set()

const storageKey = (noteId: string) => `collapse:${noteId}`

const asIds = (x: unknown): string[] =>
  Array.isArray(x) ? x.filter((id): id is string => typeof id === "string") : []

/**
 * Tolerant read — the stored collapsed set for a note, or null when there is
 * nothing usable stored (a note never opened on this device, cleared storage,
 * malformed JSON) and the caller should seed from the policy instead.
 *
 * Entries left by the old two-layer model (`{ expanded, collapsed }` overrides
 * layered on the policy) are resolved into the new shape against the document
 * — `(policy − expanded) ∪ collapsed` — rather than dropped, so upgrading
 * keeps the folds people already had.
 */
export function readCollapsedIds(noteId: string | undefined, doc: BlockDoc): Set<string> | null {
  if (!noteId || typeof localStorage === "undefined") return null
  try {
    const raw = localStorage.getItem(storageKey(noteId))
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (Array.isArray(parsed)) return new Set(asIds(parsed))
    if (parsed && typeof parsed === "object") {
      const legacy = parsed as { expanded?: unknown; collapsed?: unknown }
      const collapsed = new Set(defaultCollapsedIds(doc))
      for (const id of asIds(legacy.expanded)) collapsed.delete(id)
      for (const id of asIds(legacy.collapsed)) collapsed.add(id)
      return collapsed
    }
    return null
  } catch {
    return null
  }
}

/**
 * Persist a note's collapsed set, dropping ids the document no longer has so
 * dead ids don't accumulate. An empty set is still written: the entry existing
 * is what records "this note has been seeded here", so unfolding everything
 * survives a reload instead of inviting a re-seed.
 */
export function writeCollapsedIds(noteId: string, collapsed: ReadonlySet<string>, doc: BlockDoc) {
  if (typeof localStorage === "undefined") return
  try {
    localStorage.setItem(
      storageKey(noteId),
      JSON.stringify([...collapsed].filter((id) => doc.blocks[id])),
    )
  } catch {
    // Storage full/unavailable — collapse state is ephemeral by design.
  }
}

/**
 * Is there anything worth seeding from yet? The note store opens
 * asynchronously, so a note is briefly nothing but the editor's starter blank
 * on a cold load; seeding from that would persist an empty set for a note
 * whose content is one tick away, and the real content would then never get
 * its first impression.
 */
function hasContent(doc: BlockDoc): boolean {
  return Object.values(doc.blocks).some((b) => b.content !== "" || b.children.length > 0)
}

interface CollapseState {
  /** The note this set belongs to — switching notes re-resolves. */
  noteId: string | undefined
  /** Whether storage has been read (or the policy seeded) for that note. */
  seeded: boolean
  collapsed: Set<string>
}

/** Read the stored set for a note, or seed it from the policy once there is a
 * document to seed from. Pure apart from the storage read; the write is the
 * hook's effect below. */
function resolve(noteId: string | undefined, doc: BlockDoc): CollapseState {
  const stored = readCollapsedIds(noteId, doc)
  if (stored) return { noteId, seeded: true, collapsed: stored }
  if (!hasContent(doc)) return { noteId, seeded: false, collapsed: NOTHING_COLLAPSED }
  return { noteId, seeded: true, collapsed: new Set(defaultCollapsedIds(doc)) }
}

/**
 * Collapse state for one note: the set of collapsed block ids plus a toggle.
 *
 * The set is resolved once — from localStorage, else seeded from the policy —
 * and after that only the user's toggles move it, so blocks created or nested
 * while editing never snap shut under the user. Every change is persisted.
 */
export function useCollapseState(noteId: string | undefined, doc: BlockDoc) {
  const [state, setState] = React.useState<CollapseState>(() => resolve(noteId, doc))

  // Resolve during render, not in an effect, so a seeded note never paints
  // fully unfolded first. Two triggers: a different note, and the arrival of
  // content for a note that was still empty when it mounted (see
  // `hasContent`). Both settle in one extra render — the resolved state fails
  // the condition it just satisfied.
  if (state.noteId !== noteId || (!state.seeded && hasContent(doc))) {
    setState(resolve(noteId, doc))
  }

  // Pruning needs the live document, but the write must not fire on every
  // keystroke — it is keyed on the state object, which only a resolve or a
  // toggle replaces.
  const docRef = React.useRef(doc)
  docRef.current = doc
  React.useEffect(() => {
    if (state.seeded && state.noteId)
      writeCollapsedIds(state.noteId, state.collapsed, docRef.current)
  }, [state])

  const toggleCollapse = React.useCallback((id: string) => {
    setState((prev) => {
      const collapsed = new Set(prev.collapsed)
      if (!collapsed.delete(id)) collapsed.add(id)
      return { ...prev, seeded: true, collapsed }
    })
  }, [])

  return { collapsed: state.collapsed, toggleCollapse }
}
