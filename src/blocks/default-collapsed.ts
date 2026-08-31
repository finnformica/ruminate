import { getBlockType } from "./block-type"
import type { BlockDoc } from "./types"

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

/** Block ids collapsed by default for this document. Pure; O(blocks). */
export function defaultCollapsedIds(doc: BlockDoc): string[] {
  const collapsed: string[] = []

  // `level` = distance below the nearest heading ancestor (or the page root):
  // direct children are level 1. A heading resets the count for its subtree.
  const walk = (ids: string[], level: number) => {
    for (const id of ids) {
      const block = doc.blocks[id]
      if (!block) continue
      if (getBlockType(block.content).kind === "heading") {
        walk(block.children, 1)
        continue
      }
      if (level >= EXPANDED_LEVELS && block.children.length > 0) collapsed.push(id)
      walk(block.children, level + 1)
    }
  }
  walk(doc.rootBlockIds, 1)

  return collapsed
}
