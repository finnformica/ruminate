import { getBlockType } from "./block-type"
import { parse } from "./parse"

/**
 * Convert a note's on-disk block format into plain display markdown for
 * rendering (previews).
 *
 * The stored format annotates every block with an `id:: blk_…` line and writes
 * todos as a bare `[ ] task` marker — neither of which is valid markdown, so a
 * naive render shows the `id::` lines and unticked `[ ]` text. Parsing drops the
 * id lines (they become block ids), and here we re-emit clean markdown: todos
 * become GFM task-list items, list nesting is preserved via indentation, and
 * prose blocks are separated by blank lines so they don't run together.
 */
function blockLine(content: string): string {
  // Todos are stored as `[ ] text`; GFM needs a list bullet in front.
  return getBlockType(content).kind === "todo" ? `- ${content}` : content
}

export function toDisplayMarkdown(content: string): string {
  const doc = parse(content)
  const lines: string[] = []

  if (doc.frontmatter !== null) {
    lines.push("---", doc.frontmatter, "---")
  }

  const walk = (id: string, depth: number) => {
    const block = doc.blocks[id]
    if (!block) return
    const kind = getBlockType(block.content).kind
    const isListItem = kind === "bullet" || kind === "todo" || kind === "ordered"
    // Indent list items so nesting renders; keep prose at the margin so headings
    // and paragraphs render as themselves rather than as indented code.
    const indent = isListItem ? "  ".repeat(depth) : ""
    lines.push(indent + blockLine(block.content))
    // A blank line after prose keeps consecutive paragraphs/headings distinct;
    // list items stay tight.
    if (!isListItem) lines.push("")
    block.children.forEach((childId) => walk(childId, isListItem ? depth + 1 : depth))
  }

  doc.rootBlockIds.forEach((id) => walk(id, 0))
  return lines.join("\n")
}
