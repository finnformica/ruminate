import { isHeading } from "./markers"
import type { BlockDoc } from "./types"
import { keyOf } from "./view"

/**
 * The default-expansion policy (docs/graph-schema-v2.md): headings are always
 * expanded, and below any heading (or the page root) the outline starts with
 * `n = 2` levels visible — a block two levels down that has children starts
 * collapsed. This is a seed, not a standing rule: it fills in a note's
 * collapsed set the first time that note is opened on a device, and from then
 * on only the reader's own folds move it (see `src/data/view-state.ts`).
 * There is no synced collapse state.
 */
const EXPANDED_LEVELS = 2

/** Occurrence keys collapsed by default for this document. Pure; O(rows). */
export function defaultCollapsedKeys(doc: BlockDoc): string[] {
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
        if (level >= EXPANDED_LEVELS && block.children.length > 0) collapsed.push(key)
        walk(block.children, key, level + 1)
      }
      path.delete(id)
    }
  }
  walk(doc.rootBlockIds, null, 1)

  return collapsed
}
