import React from "react"
import { defaultCollapsedIds } from "../blocks/default-collapsed"
import type { BlockDoc } from "../blocks/types"

/**
 * Collapse state for one note: per-device ephemera, not synced data
 * (docs/graph-schema-v2.md dropped the view_state table). The resting state
 * comes from the default-expansion policy (`defaultCollapsedIds`: headings
 * always expanded, two levels below, deeper collapsed); the user's toggles
 * are stored in localStorage as per-note OVERRIDES on top of that default,
 * keyed by block id — so a device losing its localStorage merely falls back
 * to sensible defaults.
 */

export interface CollapseOverrides {
  /** Ids expanded although the default collapses them. */
  expanded: string[]
  /** Ids collapsed although the default expands them. */
  collapsed: string[]
}

const EMPTY_OVERRIDES: CollapseOverrides = { expanded: [], collapsed: [] }

const storageKey = (noteId: string) => `collapse:${noteId}`

/** Tolerant read — malformed or missing storage degrades to no overrides. */
export function readCollapseOverrides(noteId: string | undefined): CollapseOverrides {
  if (!noteId || typeof localStorage === "undefined") return EMPTY_OVERRIDES
  try {
    const raw = localStorage.getItem(storageKey(noteId))
    if (!raw) return EMPTY_OVERRIDES
    const parsed: unknown = JSON.parse(raw)
    const asIds = (x: unknown): string[] =>
      Array.isArray(x) ? x.filter((id): id is string => typeof id === "string") : []
    const record = parsed as { expanded?: unknown; collapsed?: unknown } | null
    return { expanded: asIds(record?.expanded), collapsed: asIds(record?.collapsed) }
  } catch {
    return EMPTY_OVERRIDES
  }
}

function writeCollapseOverrides(noteId: string, overrides: CollapseOverrides) {
  if (typeof localStorage === "undefined") return
  try {
    if (overrides.expanded.length === 0 && overrides.collapsed.length === 0) {
      localStorage.removeItem(storageKey(noteId))
    } else {
      localStorage.setItem(storageKey(noteId), JSON.stringify(overrides))
    }
  } catch {
    // Storage full/unavailable — collapse state is ephemeral by design.
  }
}

/** The effective collapsed set: defaults, minus expansions, plus collapses. */
export function applyCollapseOverrides(
  defaults: ReadonlySet<string>,
  overrides: CollapseOverrides,
): Set<string> {
  const collapsed = new Set(defaults)
  for (const id of overrides.expanded) collapsed.delete(id)
  for (const id of overrides.collapsed) collapsed.add(id)
  return collapsed
}

/**
 * Flip one block's state, expressed relative to the defaults.
 *
 * Every toggle first drops any existing opinion about the id, then records a
 * new one only when it differs from the default. That keeps an id out of both
 * lists at once — which was reachable (collapse a block the defaults left
 * open, then let the document grow until the default policy collapses it too)
 * and left the block permanently stuck: `applyCollapseOverrides` adds the
 * collapsed list last, so it outvoted the expansion on every click. Dropping
 * redundant overrides also lets a block return to following the default.
 */
export function toggleCollapseOverride(
  defaults: ReadonlySet<string>,
  overrides: CollapseOverrides,
  id: string,
): CollapseOverrides {
  const wantCollapsed = !applyCollapseOverrides(defaults, overrides).has(id)
  const expanded = overrides.expanded.filter((x) => x !== id)
  const collapsed = overrides.collapsed.filter((x) => x !== id)
  if (wantCollapsed === defaults.has(id)) return { expanded, collapsed }
  return wantCollapsed
    ? { expanded, collapsed: [...collapsed, id] }
    : { expanded: [...expanded, id], collapsed }
}

/**
 * Collapse state for one note: the set of collapsed block ids plus a toggle.
 *
 * Defaults are computed once per mount from the initial document (the note
 * page remounts per note), so blocks created or nested while editing never
 * snap shut under the user; overrides persist to localStorage immediately.
 */
export function useCollapseState(noteId: string | undefined, doc: BlockDoc) {
  const [defaults] = React.useState<ReadonlySet<string>>(() => new Set(defaultCollapsedIds(doc)))
  const [overrides, setOverrides] = React.useState<CollapseOverrides>(() =>
    readCollapseOverrides(noteId),
  )

  const collapsed = React.useMemo(
    () => applyCollapseOverrides(defaults, overrides),
    [defaults, overrides],
  )

  const toggleCollapse = React.useCallback(
    (id: string) => {
      setOverrides((prev) => {
        const next = toggleCollapseOverride(defaults, prev, id)
        if (noteId) writeCollapseOverrides(noteId, next)
        return next
      })
    },
    [defaults, noteId],
  )

  return { collapsed, toggleCollapse }
}
