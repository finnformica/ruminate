import { isListItem, markerFor } from "./markers"
import { parse } from "./parse"
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
 * become GFM task-list items, list nesting is preserved via indentation, and
 * prose blocks are separated by blank lines so they don't run together.
 */
function displayLine(block: Block, olPosition: number): string {
  const marker = markerFor(block.type, olPosition)
  // Todos are stored as `[ ] text`; GFM needs a list bullet in front.
  return (block.type === "todo" || block.type === "done" ? "- " : "") + marker + block.text
}

export function toDisplayMarkdown(content: string): string {
  return displayMarkdownOf(parse(content))
}

/** Display markdown of a typed doc (see `toDisplayMarkdown`). */
function displayMarkdownOf(doc: BlockDoc): string {
  const lines: string[] = []

  if (doc.frontmatter !== null) {
    lines.push("---", doc.frontmatter, "---")
  }

  const walk = (ids: string[], depth: number) => {
    let olRun = 0
    for (const id of ids) {
      const block = doc.blocks[id]
      if (!block) continue
      const listItem = isListItem(block.type)
      olRun = block.type === "ol" ? olRun + 1 : 0
      // Indent list items so nesting renders; keep prose at the margin so headings
      // and paragraphs render as themselves rather than as indented code.
      const indent = listItem ? "  ".repeat(depth) : ""
      lines.push(indent + displayLine(block, olRun))
      // A blank line after prose keeps consecutive paragraphs/headings distinct;
      // list items stay tight.
      if (!listItem) lines.push("")
      walk(block.children, listItem ? depth + 1 : depth)
    }
  }

  walk(doc.rootBlockIds, 0)
  return lines.join("\n")
}
