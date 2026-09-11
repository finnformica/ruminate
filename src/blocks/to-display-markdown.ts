import { isListItem } from "./markers"
import { defOf } from "./registry"
import { parse } from "./parse"
import { blockLines } from "./serialize"
import type { Block, BlockDoc } from "./types"

/**
 * Convert block-format markdown (the canonical `<id>.md` shape, or a copied
 * selection in that shape) into plain display markdown for rendering and for
 * the clipboard's `text/plain` flavor.
 *
 * The stored format annotates every block with an `id:: blk_…` line and writes
 * todos as a bare `[ ] task` marker — neither of which is valid markdown, so a
 * naive render shows the `id::` lines and unticked `[ ]` text. Parsing drops the
 * id lines (they become block ids), and here we re-emit clean markdown: todos
 * become GFM task-list items (`- [ ]` — a box without its list marker renders
 * nowhere), nesting is preserved via indentation, and a blank line goes only
 * between blocks that markdown would otherwise merge.
 */
function displayLines(block: Block, olPosition: number): string[] {
  // A type with its own display spelling (a todo needs GFM's list bullet in
  // front of its box) says so; everything else is its export lines.
  return defOf(block.type).displayLines?.(block, olPosition) ?? blockLines(block, olPosition)
}

export function toDisplayMarkdown(content: string): string {
  return displayMarkdownOf(parse(content))
}

/** A block whose display lines are a markdown paragraph — and so would run
 * into the paragraph before them, or lazily continue a quote or a list item,
 * unless a blank line keeps them apart. */
const paragraphLike = (type: Block["type"]): boolean =>
  type === "text" || type === "page" || type === "image"

/**
 * Does markdown need a blank line between these two consecutive lines of
 * output? Only where they would otherwise merge: a paragraph after a
 * paragraph, a quote or a list item (its text continues the one before, as
 * "lazy continuation"), and a quote after a quote. A heading, a list item, a
 * fence or a quote after a paragraph interrupts on its own, so the blank line
 * would only be noise — the copy stays as tight as the outline it came from.
 */
function needsBlankLine(prev: Block, next: Block): boolean {
  if (paragraphLike(next.type)) return prev.type !== "code" && !isHeading(prev.type)
  if (next.type === "quote") return prev.type === "quote"
  return false
}

const isHeading = (type: Block["type"]): boolean => type === "h1" || type === "h2" || type === "h3"

/** Display markdown of a typed doc (see `toDisplayMarkdown`). */
function displayMarkdownOf(doc: BlockDoc): string {
  const lines: string[] = []
  let previous: Block | null = null

  // `listDepth` is the number of list items the block sits inside: every
  // block indents to its list depth, prose included, so a heading or a
  // paragraph under a bullet stays under it (two spaces in is the item's own
  // content column, which markdown reads as part of the item). Prose under
  // prose has no markdown shape of its own and follows as a sibling at the
  // parent's depth — indenting it further would only merge it into the
  // paragraph above, or read as code.
  const path = new Set<string>()
  const walk = (ids: string[], listDepth: number) => {
    let olRun = 0
    for (const id of ids) {
      const block = doc.blocks[id]
      if (!block) continue
      const listItem = isListItem(block.type)
      olRun = block.type === "ol" ? olRun + 1 : 0
      if (previous && needsBlankLine(previous, block)) lines.push("")
      const indent = "  ".repeat(listDepth)
      for (const line of displayLines(block, olRun)) lines.push(indent + line)
      previous = block
      // A loop is written where it closes and no further.
      if (path.has(id)) continue
      path.add(id)
      walk(block.children, listItem ? listDepth + 1 : listDepth)
      path.delete(id)
    }
  }

  walk(doc.rootBlockIds, 0)
  return lines.join("\n")
}
