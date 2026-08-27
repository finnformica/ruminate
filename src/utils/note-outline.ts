import { Searcher } from "fast-fuzzy"
import { getBlockType, stripMarker } from "../blocks/block-type"
import type { BlockDoc } from "../blocks/types"

/** One heading in a note's live outline (see `noteOutlineAtom`). */
export interface OutlineItem {
  /** The heading's block id — jump target for the outline palette. */
  id: string
  /** Heading text with its `#` marker stripped. */
  text: string
  /**
   * Count of ancestor *heading* blocks above this one in the block tree — not
   * raw tree depth. The outline should read as heading nesting: a heading
   * tucked under a bullet is still a top-level entry unless another heading
   * sits above it in the tree.
   */
  depth: number
}

/**
 * A message from the command palette's outline mode to the block editor:
 * - `preview` — highlight + scroll a block live behind the open dialog.
 * - `commit` — Enter: keep the selection there and close.
 * - `cancel` — Escape/close without commit: restore the selection and scroll
 *   captured at the first preview.
 *
 * The `nonce` makes repeat messages for the same block re-fire — the old
 * `?heading=` text param couldn't re-trigger on an unchanged value.
 */
export type BlockRevealRequest =
  | { type: "preview"; id: string; nonce: number }
  | { type: "commit"; id: string; nonce: number }
  | { type: "cancel"; nonce: number }

/**
 * Collect a doc's heading blocks in document order, with `depth` counted as
 * the number of ancestor headings (see `OutlineItem`). Built from the live
 * `BlockDoc` rather than the note's markdown, because the on-disk heading
 * regex (`getHeadings`) is anchored at column 0 and misses nested (indented)
 * headings entirely. Headings with no text are skipped — they'd render as
 * blank rows in the palette.
 */
export function buildOutline(doc: BlockDoc): OutlineItem[] {
  const items: OutlineItem[] = []
  const walk = (ids: string[], depth: number) => {
    for (const id of ids) {
      const block = doc.blocks[id]
      if (!block) continue
      const isHeading = getBlockType(block.content).kind === "heading"
      if (isHeading) {
        const text = stripMarker(block.content).trim()
        if (text !== "") items.push({ id, text, depth })
      }
      walk(block.children, depth + (isHeading ? 1 : 0))
    }
  }
  walk(doc.rootBlockIds, 0)
  return items
}

/** Ancestor-heading chain of `items[index]` (outermost first), by depth walk:
 * the nearest earlier item one level shallower, then its ancestor, and so on.
 * Because `depth` counts heading ancestors, this reconstructs the actual
 * heading chain from the flat list. */
function outlinePath(items: OutlineItem[], index: number): string[] {
  const path: string[] = []
  let depth = items[index]?.depth ?? 0
  for (let i = index - 1; i >= 0 && depth > 0; i--) {
    if (items[i].depth < depth) {
      path.unshift(items[i].text)
      depth = items[i].depth
    }
  }
  return path
}

/**
 * Filter the outline for the palette. An empty query returns every heading in
 * document order; otherwise headings are fuzzy-ranked, matching the heading
 * text AND its ancestor path (so "setup api" finds "API" under "Setup"). Each
 * result carries its ancestor chain for display ("Parent › Sub").
 */
export function filterOutline(
  items: OutlineItem[],
  query: string,
): (OutlineItem & { path: string[] })[] {
  const withPath = items.map((item, index) => ({ ...item, path: outlinePath(items, index) }))
  const trimmed = query.trim()
  if (trimmed === "") return withPath
  const searcher = new Searcher(withPath, {
    keySelector: (item) => [item.text, [...item.path, item.text].join(" › ")],
    threshold: 0.7,
  })
  return searcher.search(trimmed)
}
