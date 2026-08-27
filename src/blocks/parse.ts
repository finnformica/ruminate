import { blockId } from "./id"
import type { Block, BlockDoc } from "./types"

/** A node in the intermediate tree, before ids are finalized. */
interface ParsedNode {
  content: string
  /** Id read from an `id::` line, if present. */
  fileId?: string
  children: ParsedNode[]
}

const ID_RE = /^\s*id::\s+(.+)$/

// A GFM task-list item (`- [ ] task`, `* [x] done`). Copy emits todos in this
// form (see to-display-markdown.ts); parsing normalizes it back to the app's
// bare `[ ] task` marker so the round-trip preserves the block type.
const GFM_TODO_RE = /^[-*]\s+(?=\[[ xX]?\]\s)/

/**
 * Parse markdown into a BlockDoc.
 *
 * - Frontmatter (a leading `---` … `---` block) is preserved verbatim.
 * - Every non-blank, non-`id::` line is a block; its content is written
 *   verbatim (a bullet keeps its `- `, a heading its `# `, a paragraph nothing)
 *   and nesting comes from indentation — two spaces per level in the canonical
 *   serialized form, with tab-indented and 4-space outlines (common in pasted
 *   content from other tools) normalized to the same levels (see
 *   `inferIndentUnit`).
 * - An `id::` line immediately after a block attaches its id to that block;
 *   blocks without one are minted a fresh id (so plain/imported markdown gains
 *   stable ids on the next save).
 */
export function parse(markdown: string): BlockDoc {
  // Normalize line endings so Windows/GitHub CRLF never leaks into content/ids.
  const { frontmatter, body } = splitFrontmatter(markdown.replace(/\r\n/g, "\n"))
  const lines = body.split("\n")
  // Drop the single trailing empty line produced by the final newline.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()

  const unit = inferIndentUnit(lines)

  const roots: ParsedNode[] = []
  // Stack of open nodes with their indentation depth, nearest-last.
  const stack: { depth: number; node: ParsedNode }[] = []

  const insert = (depth: number, node: ParsedNode) => {
    while (stack.length > 0 && stack[stack.length - 1].depth >= depth) stack.pop()
    if (stack.length === 0) roots.push(node)
    else stack[stack.length - 1].node.children.push(node)
    stack.push({ depth, node })
  }

  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (line.trim() === "") {
      i += 1
      continue
    }

    // Leading whitespace → nesting level: each tab is one level; runs of
    // spaces divide by the inferred per-document unit (2 or 4).
    let cut = 0
    let tabs = 0
    let spaces = 0
    while (cut < line.length && (line[cut] === " " || line[cut] === "\t")) {
      if (line[cut] === "\t") tabs += 1
      else spaces += 1
      cut += 1
    }
    const level = tabs + Math.floor(spaces / unit)

    const idMatch = ID_RE.exec(line)
    if (idMatch) {
      // Reached an `id::` line directly — the block's content line was empty.
      // The id sits one level deeper than its (empty) content line.
      const depth = Math.max(0, level - 1)
      insert(depth, { content: "", children: [], fileId: idMatch[1].trim() })
      i += 1
      continue
    }

    const content = line.slice(cut).replace(GFM_TODO_RE, "")
    const depth = level
    const node: ParsedNode = { content, children: [] }

    // An `id::` line immediately after belongs to this block.
    const next = i + 1 < lines.length ? lines[i + 1] : undefined
    const nextId = next !== undefined ? ID_RE.exec(next) : null
    if (nextId) {
      node.fileId = nextId[1].trim()
      i += 2
    } else {
      i += 1
    }

    insert(depth, node)
  }

  const blocks: Record<string, Block> = {}
  // Ids already assigned in this document. A duplicate `id::` — e.g. from
  // copy-pasting a block, id line and all, in an external editor — would
  // otherwise overwrite the earlier block in `blocks` and make its parent
  // reference the same id twice, silently losing a block. Regenerate on
  // collision so every block keeps a distinct id; the fresh id persists on the
  // next save. (Also covers the rare case of a freshly minted id colliding.)
  const usedIds = new Set<string>()
  const flatten = (node: ParsedNode): string => {
    let id = node.fileId ?? blockId()
    while (usedIds.has(id)) id = blockId()
    usedIds.add(id)
    const block: Block = { id, content: node.content, children: [] }
    blocks[id] = block
    block.children = node.children.map(flatten)
    return id
  }
  const rootBlockIds = roots.map(flatten)

  return { frontmatter, rootBlockIds, blocks }
}

/**
 * The number of spaces per indentation level in this document. The serializer
 * always emits two, but pasted outlines from other tools often use four (or
 * tabs — each tab is always one level). Infer four only when every
 * space-indented line is a multiple of four with at least one exactly four;
 * otherwise two. Serialized documents always infer two — every root block's
 * `id::` line sits at two spaces — so parse(serialize(doc)) stays byte-stable.
 */
function inferIndentUnit(lines: string[]): number {
  let sawFour = false
  for (const line of lines) {
    if (line.trim() === "") continue
    let spaces = 0
    for (let i = 0; i < line.length && (line[i] === " " || line[i] === "\t"); i += 1) {
      if (line[i] === " ") spaces += 1
    }
    if (spaces === 0) continue
    if (spaces % 4 !== 0) return 2
    if (spaces === 4) sawFour = true
  }
  return sawFour ? 4 : 2
}

/** Split a leading YAML frontmatter block from the body, keeping it verbatim. */
function splitFrontmatter(markdown: string): {
  frontmatter: string | null
  body: string
} {
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!match) return { frontmatter: null, body: markdown }
  return { frontmatter: match[1], body: match[2] }
}
