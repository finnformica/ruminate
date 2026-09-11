import { blockId } from "./id"
import { pagePropsFromText } from "../data/frontmatter-props"
import { classifyLine } from "./markers"
import type { Block, BlockDoc, BlockType } from "./types"

/**
 * **Import.** Parse markdown into typed blocks.
 *
 * - Frontmatter (a leading `---` … `---` block) is preserved verbatim.
 * - Every non-blank, non-`id::` line is a block: its leading marker decides
 *   the type and is dropped from the text (`classifyLine`, which also folds
 *   near-miss spellings such as `[] x` or `* x` into their typed form). A
 *   bullet that carries another marker (`- # Heading`, `- [ ] task`, `- >
 *   quote`) is that marker's block — the bullet was only the container. And
 *   nesting comes from indentation — two spaces per level in the canonical
 *   serialized form, with tab-indented and 4-space outlines (common in pasted
 *   content from other tools) normalized to the same levels (see
 *   `inferIndentUnit`).
 * - A code fence (```` ``` ````, with an optional language after it) is one
 *   `code` block: the lines up to the closing fence are its text, verbatim —
 *   nothing inside is a marker, and a `- [ ]` in a fence is code — and the
 *   language is its `props.language`. An unclosed fence runs to the end of
 *   the text (CommonMark's rule).
 * - An `id::` line immediately after a block attaches its id to that block;
 *   blocks without one are minted a fresh id (so plain/imported markdown gains
 *   stable ids on the next save).
 *
 * This is the only place markdown becomes blocks. The editor never calls it
 * on its own state — only on foreign text (paste, the sample
 * notes) — so a duplicated `id::` here really is two blocks, and re-minting
 * the second (below) is the right reading.
 */

/** A node in the intermediate tree, before ids and types are finalized. */
interface ParsedNode {
  line: string
  /** Id read from an `id::` line, if present. */
  fileId?: string
  /** A fenced code block: its language (may be empty) and verbatim lines. */
  code?: { language: string; lines: string[] }
  children: ParsedNode[]
}

/** The opening of a code fence, with its info string (the language). */
const FENCE_OPEN_RE = /^```[ \t]*(\S*)/
/** A closing fence: three backticks and nothing else but whitespace. */
const FENCE_CLOSE_RE = /^```[ \t]*$/

const ID_RE = /^\s*id::\s+(.+)$/

// A bullet carrying another block's marker: a GFM task-list item (`- [ ] task`,
// `* [x] done` — the form copy emits, see to-display-markdown.ts), and the
// outliner shape where every line is a bullet and the real glyph follows it
// (`- # Heading`, `- > quote`, `- \`\`\``). The inner marker is the block's
// type; the bullet is the container it came in. Parsing drops the bullet so
// the glyph is kept as the type rather than lost as literal text.
const BULLET_WRAPPED_MARKER_RE = /^[-*+]\s+(?=(?:\[[ xX]?\]\s|#{1,6}\s|>\s|```))/

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
      insert(depth, { line: "", children: [], fileId: idMatch[1].trim() })
      i += 1
      continue
    }

    const content = line.slice(cut).replace(BULLET_WRAPPED_MARKER_RE, "")
    const node: ParsedNode = { line: content, children: [] }

    // A code fence: everything up to the closing fence is the block's text,
    // read verbatim (the fence's own indent stripped from each line where it
    // is present). Unclosed, it runs to the end.
    const fence = FENCE_OPEN_RE.exec(content)
    if (fence) {
      const indent = line.slice(0, cut)
      const inner: string[] = []
      let j = i + 1
      while (j < lines.length && !FENCE_CLOSE_RE.test(lines[j].trim())) {
        inner.push(lines[j].startsWith(indent) ? lines[j].slice(indent.length) : lines[j].trim())
        j += 1
      }
      node.line = ""
      node.code = { language: fence[1], lines: inner }
      // Past the closing fence (if there was one).
      i = Math.min(j + 1, lines.length)
      const after = i < lines.length ? ID_RE.exec(lines[i]) : null
      if (after) {
        node.fileId = after[1].trim()
        i += 1
      }
      insert(level, node)
      continue
    }

    // An `id::` line immediately after belongs to this block.
    const next = i + 1 < lines.length ? lines[i + 1] : undefined
    const nextId = next !== undefined ? ID_RE.exec(next) : null
    if (nextId) {
      node.fileId = nextId[1].trim()
      i += 2
    } else {
      i += 1
    }

    insert(level, node)
  }

  const blocks: Record<string, Block> = {}
  // Ids already assigned in this document. A duplicate `id::` — e.g. from
  // copy-pasting a block, id line and all, in an external editor — would
  // otherwise overwrite the earlier block in `blocks` and make its parent
  // reference the same id twice, silently losing a block. Regenerate on
  // collision so every block keeps a distinct id; the fresh id persists on the
  // next save. (Also covers the rare case of a freshly minted id colliding.)
  const usedIds = new Set<string>()

  const flatten = (nodes: ParsedNode[]): string[] => {
    const ids: string[] = []
    // Ordered runs are per parent: consecutive `ol` siblings number from 1.
    let olRun = 0
    for (const node of nodes) {
      let id = node.fileId ?? blockId()
      while (usedIds.has(id)) id = blockId()
      usedIds.add(id)
      let block: Block
      if (node.code) {
        block = { id, type: "code", text: node.code.lines.join("\n"), children: [] }
        if (node.code.language !== "") block.props = { language: node.code.language }
        olRun = 0
      } else {
        const { type, text } = classifyLine(node.line, olRun + 1, false)
        olRun = type === "ol" ? olRun + 1 : 0
        block = { id, type, text, children: [] }
      }
      blocks[id] = block
      block.children = flatten(node.children)
      ids.push(id)
    }
    return ids
  }
  const rootBlockIds = flatten(roots)

  return { props: pagePropsFromText(frontmatter), rootBlockIds, blocks }
}

/** A typed block from one line of markdown, outside any document — what the
 * clipboard and the "new block" preference use to read a marker. */
export function parseLine(line: string): { type: BlockType; text: string } {
  return classifyLine(line, 1, false)
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
