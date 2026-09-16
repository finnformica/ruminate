import type { BlockDoc } from "./types"
import { keyOf, type ExpandedRule } from "./view"

/**
 * The depth rule (docs/graph-schema-v2.md, "Default expansion"): an
 * occurrence is open while it is fewer than `levels` levels below the top
 * of the view — a note's roots are level 1, so two levels means the roots
 * and their children show and a parent two down starts folded, whatever its
 * type (headings count like any other block). The number is a preference
 * (Settings → Editor, `expandedLevelsAtom`; two by default).
 *
 * This is a standing rule, not a seed: it decides every occurrence the
 * reader has not folded or unfolded themselves, in every note, every time —
 * so moving the setting moves every such row, a row the reader opened stays
 * open, and a lazy walk (`walkGraph`) has an answer for a row it has only
 * just reached. The reader's own folds sit over it (`src/data/view-state.ts`).
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

/** The depth rule alone: open above `levels`, closed from it down. */
export function expandedByDepth(levels: number = DEFAULT_EXPANDED_LEVELS): ExpandedRule {
  const open = clampExpandedLevels(levels)
  return (_key, level) => level < open
}

/**
 * The occurrence keys a rule closes in an eagerly walked doc — the folds a
 * view that holds its whole doc (the basket, a standalone editor) draws,
 * exactly the set a lazy walk of the same doc would report. Leaves are never
 * closed. `startLevel` is the level of the roots (1 for a note's). Pure;
 * O(rows).
 */
export function collapsedKeysOf(doc: BlockDoc, expanded: ExpandedRule, startLevel = 1): string[] {
  const collapsed: string[] = []
  const path = new Set<string>()
  const walk = (ids: string[], parentKey: string | null, level: number) => {
    for (const id of ids) {
      const block = doc.blocks[id]
      if (!block || path.has(id) || block.children.length === 0) continue
      const key = keyOf(parentKey, id)
      if (!expanded(key, level)) {
        collapsed.push(key)
        continue
      }
      path.add(id)
      walk(block.children, key, level + 1)
      path.delete(id)
    }
  }
  walk(doc.rootBlockIds, null, startLevel)
  return collapsed
}
