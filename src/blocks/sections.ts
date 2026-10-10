import { defOf } from "./registry"
import type { Block, BlockDoc } from "./types"

/**
 * **Sectioning a paste.** Foreign content (a meeting summary, a document,
 * an AI answer) marks its sections with headings and leaves the content
 * beside them, where an outline wants it beneath: a heading that has
 * nothing indented under it takes what follows it as its children, up to
 * the next heading of the same or a higher level (a smaller number of `#`).
 *
 * - A heading the source already gave children keeps them and takes nothing
 *   more: the paste's own structure is never overridden. It still ends any
 *   open section of its level or deeper, as a peer would.
 * - A deeper heading inside a section is part of it, and opens its own
 *   section within it (`###` under `##`); a skipped level is no different.
 * - Content before the first heading stays where it was.
 * - A thematic break (`---`, `***`, `___` on a line of its own) ends every
 *   open section, and stays as it was written.
 * - Every sibling list is sectioned on its own, so a heading inside a list
 *   only ever gathers its own siblings.
 *
 * `levels` is the level each heading was written at (`parseWithLevels`);
 * a heading missing from it reads its level from its type (`h1`…`h3`).
 * `closed` names headings that must not open a section — the row being
 * pasted into, whose text is the reader's own. Pure: returns a new doc.
 */
export function sectionUnderHeadings(
  doc: BlockDoc,
  levels: ReadonlyMap<string, number> = new Map(),
  closed: ReadonlySet<string> = new Set(),
): BlockDoc {
  const blocks: Record<string, Block> = {}
  for (const [id, block] of Object.entries(doc.blocks)) blocks[id] = { ...block }

  const levelOf = (block: Block): number | null => {
    if (defOf(block.type).family !== "heading") return null
    return levels.get(block.id) ?? TYPE_LEVEL[block.type] ?? 1
  }

  const sectionList = (ids: string[]): string[] => {
    // Each block's own children first, as the source wrote them, so "has
    // nothing indented under it" is about the paste and not about what
    // this pass has gathered.
    const hadChildren = new Set<string>()
    for (const id of ids) {
      const block = blocks[id]
      if (!block || block.children.length === 0) continue
      hadChildren.add(id)
      block.children = sectionList(block.children)
    }
    const list: string[] = []
    const open: { block: Block; level: number }[] = []
    for (const id of ids) {
      const block = blocks[id]
      if (!block) {
        list.push(id)
        continue
      }
      const level = levelOf(block)
      if (level !== null) {
        while (open.length > 0 && open[open.length - 1].level >= level) open.pop()
      } else if (block.type === "text" && THEMATIC_BREAK_RE.test(block.text.trim())) {
        open.length = 0
      }
      const parent = open[open.length - 1]
      if (parent) parent.block.children = [...parent.block.children, id]
      else list.push(id)
      if (level !== null && !hadChildren.has(id) && !closed.has(id)) open.push({ block, level })
    }
    return list
  }

  const rootBlockIds = sectionList(doc.rootBlockIds)
  return { ...doc, rootBlockIds, blocks }
}

const TYPE_LEVEL: Partial<Record<Block["type"], number>> = { h1: 1, h2: 2, h3: 3 }

const THEMATIC_BREAK_RE = /^(?:-{3,}|\*{3,}|_{3,})$/

/** The ids from `rootId` down to the last block of its subtree in reading
 * order (the last child, its last child, …): where the text after a paste's
 * caret lands once sectioning has nested it. */
export function lastBlockPath(doc: BlockDoc, rootId: string): string[] {
  const path = [rootId]
  const seen = new Set(path)
  let block = doc.blocks[rootId]
  while (block && block.children.length > 0) {
    const last = block.children[block.children.length - 1]
    if (seen.has(last)) break
    path.push(last)
    seen.add(last)
    block = doc.blocks[last]
  }
  return path
}
