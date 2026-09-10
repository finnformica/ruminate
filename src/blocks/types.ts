/**
 * The block model for Ruminate's editor — a slice of the graph
 * (docs/graph-schema-v2.md), not a markdown document.
 *
 * A block is a row: a `type` from the type registry, marker-free `text`, and
 * optional `props`. Containment lives in each block's ordered `children`. The
 * same block can be reached from several parents (in the graph, and — once
 * the view builder hands the editor a DAG — in one doc); the map holds it
 * once and each parent's `children` names it.
 *
 * Markdown is an interchange format at the edges only: `parse` turns pasted
 * or imported markdown into typed blocks (import), `serialize` turns blocks
 * back into the canonical `<id>.md` shape (export). Nothing between the
 * store and the screen carries a marker: what a block looks like is drawn
 * from its `type` (`src/components/block-editor/block-marker.tsx`).
 */

/**
 * The type registry (docs/graph-schema-v2.md). Stored as-is; the serializer
 * is a pure type → marker map. `page` is a note's root node — its `text` is
 * the title and its `props` the frontmatter — and appears in a doc only when
 * a view is built with a page among its blocks.
 */
export type BlockType =
  "text" | "h1" | "h2" | "h3" | "todo" | "done" | "ul" | "ol" | "quote" | "code" | "page"

export const BLOCK_TYPES: readonly BlockType[] = [
  "text",
  "h1",
  "h2",
  "h3",
  "todo",
  "done",
  "ul",
  "ol",
  "quote",
  "code",
  "page",
]

const BLOCK_TYPE_SET: ReadonlySet<string> = new Set(BLOCK_TYPES)

/** Is `value` a type the registry knows? Unknown stored types (a newer
 * client's) render as plain text, marker-free — forward compatibility. */
export function isBlockType(value: string): value is BlockType {
  return BLOCK_TYPE_SET.has(value)
}

/** The registry type for a stored `nodes.type`, `text` for anything unknown. */
export function asBlockType(value: string): BlockType {
  return isBlockType(value) ? value : "text"
}

export type BlockProps = Record<string, unknown>

export interface Block {
  id: string
  type: BlockType
  /** Marker-free content. Inline markdown (bold, links, code spans) is
   * content and renders as such; a leading marker never is. */
  text: string
  /** Pages: frontmatter entries; code: `{ language }`. Absent for most. */
  props?: BlockProps | null
  /** Ordered ids of child blocks. */
  children: string[]
}

export interface BlockDoc {
  /**
   * The raw text *between* the `---` frontmatter fences (verbatim), or null.
   * An import/export concern: a doc built from the graph carries the page's
   * props as its frontmatter text so that `serialize` emits exactly what the
   * rollup emits.
   */
  frontmatter: string | null
  /** Top-level block ids, in order. */
  rootBlockIds: string[]
  /** Every block in the doc, keyed by id — each once, however many parents. */
  blocks: Record<string, Block>
}
