import { useAtomValue } from "jotai"
import React from "react"
import { expandedByDepth } from "../blocks/default-collapsed"
import { idOfKey, isWithin, type ExpandedRule } from "../blocks/view"
import { BOARD_TYPE } from "./graph"
import { expandedLevelsAtom } from "../global-state"

/**
 * Fold state for one view: view state, not synced data (docs/graph-schema-v2.md
 * dropped the view_state table). Folds key by occurrence (`src/blocks/view.ts`):
 * a block that shows up twice in a note is two rows, folded independently.
 *
 * Folds belong to a frame (docs/graph-walk.md, section 5): each frame of each
 * pane holds its own in the URL (`src/data/panes.ts`), so a pushed frame
 * starts with none and a pop restores them. A frame narrowed by a filter or a
 * sort keeps its narrowed folds apart, and clears them when the narrowing
 * changes, so a fold made while narrowed never closes a row of the note.
 *
 * Two layers, one answer. A standing rule decides every row the reader has
 * not touched: for a note, the depth rule at the frame's depth
 * (`expandedByDepth`, Settings → Editor, recorded on the frame so a fold means
 * the same on every device); for a narrowed view, everything open — the
 * reader asked for the matches, and a match behind a fold would be a riddle.
 * Over it sit the reader's own folds: the rows they closed AND the rows they
 * opened, as differences from the rule. A fold equal to the rule is not kept.
 * A row with no entry follows the rule, which is what lets the walk be lazy
 * (`walkGraph`): a row reached for the first time has an answer without a
 * document to seed from.
 *
 * Folds were once kept on the device, per note, in localStorage
 * (`collapse:<noteId>`). The first open of a note seeds its base frame from
 * that entry once, and the entry goes (`takeStoredFolds`).
 */

const STORAGE_PREFIX = "collapse:"

/** The reader's explicit folds on one note. Never mutated — every update
 * builds fresh sets. */
export interface Folds {
  /** Occurrence keys the reader opened (over a rule that would close them). */
  open: ReadonlySet<string>
  /** Occurrence keys the reader closed. */
  closed: ReadonlySet<string>
}

const NO_FOLDS: Folds = { open: new Set(), closed: new Set() }

const asStrings = (x: unknown): string[] =>
  Array.isArray(x) ? x.filter((id): id is string => typeof id === "string") : []

/**
 * Tolerant read of a stored entry — the folds the reader left on a note, or
 * null when nothing usable is stored (a note never folded on this device,
 * cleared storage, malformed JSON).
 *
 * Older shapes are read too, each as the reader's own folds: the `v: 2`
 * collapsed set and the bare array before it (which also stored policy
 * seeds — those come back as folds, the safe reading), and the two-layer
 * `{ expanded, collapsed }` record before that, which was this shape all
 * along. An entry without a `/` is a block id from before folds keyed by
 * occurrence, and applies to every occurrence of that block (`foldRule`).
 */
function readFolds(raw: string | null): Folds | null {
  try {
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

/**
 * The folds a note once kept on this device, taken once: read, and the entry
 * removed, so the seed of a note's base frame runs one time only. Null when
 * nothing usable is stored. A narrowed view's old entries are not read.
 */
export function takeStoredFolds(noteId: string): Folds | null {
  if (typeof localStorage === "undefined") return null
  try {
    const key = `${STORAGE_PREFIX}${noteId}`
    const raw = localStorage.getItem(key)
    if (raw === null) return null
    localStorage.removeItem(key)
    const folds = readFolds(raw)
    return folds && folds.open.size + folds.closed.size > 0 ? folds : null
  } catch {
    return null
  }
}

/**
 * Folds the caller holds: a frame keeps its own in the URL
 * (src/data/panes.ts). Given, `useFoldRule` reads and writes these; without
 * them it keeps its own for as long as it is mounted.
 */
export interface HeldFolds {
  folds: Folds
  onChange: (folds: Folds) => void
}

/**
 * The rule a view descends by: the reader's explicit folds over the depth
 * rule. A key's own entry wins; failing that an entry naming its block id
 * (a fold from before occurrence keys) applies to every occurrence; failing
 * both, a board's row is closed — its card stands for what is beneath it
 * (docs/boards.md, "A board in a note"), and its outline is a chevron away
 * — and the depth rule decides the rest.
 */
export function foldRule(folds: Folds, byDepth: ExpandedRule): ExpandedRule {
  return (key, level, type) => {
    if (folds.closed.has(key)) return false
    if (folds.open.has(key)) return true
    const id = idOfKey(key)
    if (id !== key) {
      if (folds.closed.has(id)) return false
      if (folds.open.has(id)) return true
    }
    if (type === BOARD_TYPE) return false
    return byDepth(key, level, type)
  }
}

/** `folds` with `key` set open or closed — and any bare-id entry for its
 * block dropped, so the reader's toggle is never outvoted by an old record.
 * When the standing rule already puts the row there (`byDefault`), the fold
 * is a difference of nothing, and is not kept. */
export function withFold(folds: Folds, key: string, open: boolean, byDefault?: boolean): Folds {
  const id = idOfKey(key)
  const next = {
    open: new Set(folds.open),
    closed: new Set(folds.closed),
  }
  next.open.delete(key)
  next.closed.delete(key)
  next.open.delete(id)
  next.closed.delete(id)
  if (byDefault === open) return next
  if (open) next.open.add(key)
  else next.closed.add(key)
  return next
}

/**
 * `folds` after a structural move took the row at `from` to `to` (an indent,
 * an outdent): the row's own fold and every fold beneath it move with it, so
 * a closed row stays closed and its closed descendants stay closed. Other
 * paths do not change (docs/graph-walk.md, Appendix D, fix 3).
 */
export function rekeyFolds(folds: Folds, from: string, to: string): Folds {
  if (from === to) return folds
  const move = (keys: ReadonlySet<string>) =>
    new Set([...keys].map((key) => (isWithin(key, from) ? to + key.slice(from.length) : key)))
  return { open: move(folds.open), closed: move(folds.closed) }
}

/** The standing rule of a narrowed view: every row open. */
const EVERYTHING_OPEN: ExpandedRule = () => true

/**
 * Fold state for one view: the rule its rows are drawn by, and the way to
 * move a row. `setFold(key, open)` records the reader's decision for that
 * row, in the folds the caller holds (`owned`, a frame's) or in this hook's
 * own; the owner of the view — which knows what is folded right now — turns
 * a toggle into one.
 *
 * The standing rule beneath the reader's folds is the depth rule at `depth`
 * (the frame's; absent, the device's setting) for a note, and everything
 * open for a narrowed view (see the top of this file): the one place that
 * says what a view starts as. `held` names blocks the rule holds open over
 * the depth rule — the calendar's rows with a change beneath them
 * (`components/day-changes.tsx`) — as a default only: the reader's own fold
 * on one of them still closes it.
 */
export function useFoldRule({
  narrowed = false,
  held,
  owned,
  depth,
}: {
  narrowed?: boolean
  held?: ReadonlySet<string>
  owned?: HeldFolds
  depth?: number
} = {}) {
  const setting = useAtomValue(expandedLevelsAtom)
  const levels = depth ?? setting
  const [own, setOwn] = React.useState<Folds>(NO_FOLDS)
  const folds = owned ? owned.folds : own
  // The level and type the walk asked of each row, so a toggle can tell
  // whether it puts the row where the standing rule has it.
  const asked = React.useRef(new Map<string, { level: number; type?: string }>())
  const standing = React.useMemo<ExpandedRule>(() => {
    const byDepth = narrowed ? EVERYTHING_OPEN : expandedByDepth(levels)
    return (key, level, type) =>
      type === BOARD_TYPE ? false : (held?.has(idOfKey(key)) ?? false) || byDepth(key, level, type)
  }, [narrowed, levels, held])
  const expanded = React.useMemo<ExpandedRule>(() => {
    const rule = foldRule(folds, standing)
    return (key, level, type) => {
      asked.current.set(key, { level, type })
      return rule(key, level, type)
    }
  }, [folds, standing])

  // Read through refs, so two toggles in one event build on each other and
  // `setFold` keeps one identity.
  const ownedRef = React.useRef(owned)
  ownedRef.current = owned
  const standingRef = React.useRef(standing)
  standingRef.current = standing
  const setFold = React.useCallback((key: string, open: boolean) => {
    const at = asked.current.get(key)
    const byDefault = at ? standingRef.current(key, at.level, at.type) : undefined
    const held = ownedRef.current
    if (held) {
      const next = withFold(held.folds, key, open, byDefault)
      held.folds = next
      held.onChange(next)
      return
    }
    setOwn((prev) => withFold(prev, key, open, byDefault))
  }, [])
  /** Rows that a structural move took to new keys: their folds go too. */
  const moveFolds = React.useCallback((moved: readonly [from: string, to: string][]) => {
    const apply = (folds: Folds) =>
      moved.reduce((next, [from, to]) => rekeyFolds(next, from, to), folds)
    const held = ownedRef.current
    if (held) {
      const next = apply(held.folds)
      held.folds = next
      held.onChange(next)
      return
    }
    setOwn(apply)
  }, [])

  return { expanded, setFold, moveFolds, folds }
}
