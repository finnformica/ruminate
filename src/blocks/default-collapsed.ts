import { isHeading } from "./markers"
import type { BlockDoc } from "./types"
import { keyOf } from "./view"

/**
 * The default-expansion policy (docs/graph-schema-v2.md): headings are always
 * expanded, and below any heading (or the page root) the outline starts with
 * `levels` levels visible — a block that many levels down that has children
 * starts collapsed. The number is a preference (Settings → Editor,
 * `expandedLevelsAtom`; two by default). This is a seed, not a standing rule:
 * it is what a note opens as until the reader folds or unfolds something,
 * and from then on only their own folds are remembered (see
 * `src/data/view-state.ts`). There is no synced collapse state.
 */
export const DEFAULT_EXPANDED_LEVELS = 2
export const MIN_EXPANDED_LEVELS = 1
export const MAX_EXPANDED_LEVELS = 10

/** A stored preference read back into the range the slider offers. */
export function clampExpandedLevels(value: unknown): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : NaN
  if (Number.isNaN(n)) return DEFAULT_EXPANDED_LEVELS
  return Math.min(MAX_EXPANDED_LEVELS, Math.max(MIN_EXPANDED_LEVELS, n))
}

/** Occurrence keys collapsed by default for this document. Pure; O(rows). */
export function defaultCollapsedKeys(doc: BlockDoc, levels = DEFAULT_EXPANDED_LEVELS): string[] {
  const expanded = clampExpandedLevels(levels)
  const collapsed: string[] = []

  // `level` = distance below the nearest heading ancestor (or the page root):
  // direct children are level 1. A heading resets the count for its subtree.
  const path = new Set<string>()
  const walk = (ids: string[], parentKey: string | null, level: number) => {
    for (const id of ids) {
      const block = doc.blocks[id]
      if (!block || path.has(id)) continue
      const key = keyOf(parentKey, id)
      path.add(id)
      if (isHeading(block.type)) {
        walk(block.children, key, 1)
      } else {
        if (level >= expanded && block.children.length > 0) collapsed.push(key)
        walk(block.children, key, level + 1)
      }
      path.delete(id)
    }
  }
  walk(doc.rootBlockIds, null, 1)

  return collapsed
}
