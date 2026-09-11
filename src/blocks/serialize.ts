import { markerFor } from "./markers"
import { defOf } from "./registry"
import type { Block, BlockDoc } from "./types"

/**
 * **Export.** Serialize typed blocks to markdown — the canonical `<id>.md`
 * form, the *same bytes* the store's rollup produces for a page (the rollup
 * IS this function over a doc built from the graph, `src/data/graph.ts`).
 * Only the blocks: a page's props (its metadata) are never written out.
 *
 *   # A heading
 *     id:: blk_abc
 *   - A bullet
 *     id:: blk_def
 *   A plain paragraph
 *     id:: blk_ghi
 *
 * Each block's marker comes from its type (`markerFor`: ordered items are
 * renumbered by run position, headings always carry one `#`), followed by an
 * `id::` line indented two spaces further. Nesting is two spaces of indent
 * per depth. A type that writes its own lines (a code fence, an image's
 * `![caption](url)`) does so through its registry entry; a multi-line text
 * keeps its continuation lines at the block's indent. A block reached
 * from two parents is written out in both places — that is the feature. A
 * loop is written where it closes and no further: the block already on the
 * path above is emitted once more, as a leaf (markdown is a tree; `parse`
 * reads that second `id::` as a collision and re-mints it, so a loop does not
 * survive a markdown round trip — the graph, not the markdown, holds it).
 */

/** Walk depth cap — belt-and-braces so even a corrupted doc can never hang
 * the export. Mirrors the rollup's historic cap. */
const MAX_SERIALIZE_DEPTH = 64

/**
 * A block's own content lines, unindented: the marker plus its text, with a
 * multi-line text's continuation lines after; a code block as a fence
 * carrying its language. What `serialize` writes before the `id::` line, and
 * what copy writes for a selection.
 */
export function blockLines(block: Block, olPosition = 1): string[] {
  const own = defOf(block.type).toLines
  if (own) return own(block, olPosition)
  const [first, ...rest] = block.text.split("\n")
  // The content line (empty text → just the marker, so depth is preserved).
  return [`${markerFor(block.type, olPosition)}${first}`, ...rest]
}

export function serialize(doc: BlockDoc): string {
  const lines: string[] = []
  const path = new Set<string>()

  const emitBlock = (id: string, depth: number, olPosition: number) => {
    const block: Block | undefined = doc.blocks[id]
    if (!block) return
    const indent = "  ".repeat(depth)

    for (const line of blockLines(block, olPosition)) lines.push(`${indent}${line}`)
    lines.push(`${indent}  id:: ${block.id}`)

    if (path.has(id) || depth + 1 >= MAX_SERIALIZE_DEPTH) return
    path.add(id)
    emitChildren(block.children, depth + 1)
    path.delete(id)
  }

  const emitChildren = (ids: string[], depth: number) => {
    let olRun = 0
    for (const id of ids) {
      olRun = doc.blocks[id]?.type === "ol" ? olRun + 1 : 0
      emitBlock(id, depth, olRun)
    }
  }

  emitChildren(doc.rootBlockIds, 0)

  return lines.join("\n") + "\n"
}
