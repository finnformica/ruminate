import { Searcher, type FullOptions } from "fast-fuzzy"
import { getBlockType, stripMarker } from "../blocks/block-type"
import { parse } from "../blocks/parse"
import type { Note, NoteId } from "../schema"
import type { Filter, Query, Sort } from "./search"
import { compareNotes, testNoteFilters } from "./search-notes"

/**
 * Block-granular search: resolve a query to individual BLOCKS instead of
 * notes. This is the data-layer engine behind the `type:` qualifier
 * (`type:todo` = every unchecked checkbox in the corpus) and the future
 * block-results UI. Everything runs client-side over the parsed docs derived
 * from the files atom — see `blockIndexAtom` / `searchBlocksAtom` in
 * global-state.ts for the derived-atom wiring.
 *
 * Query semantics (all composable with the existing `parseQuery` vocabulary):
 * - `type:` filters with block-type values (the table below) match the block
 *   itself; every other qualifier (`tag:`, `date:`, frontmatter, `has:`/`no:`,
 *   …) filters by the containing note, exactly as note search does.
 * - Fuzzy text matches the block's own marker-free text (fast-fuzzy, same
 *   threshold as note search); with fuzzy text present, results rank by fuzzy
 *   relevance, otherwise document order grouped by note (in the note order the
 *   index was built from — `sortedNotesAtom`).
 * - `-` exclusion and comma lists work on `type:` like any other qualifier.
 */

/**
 * The canonical type of a block, for search. Derived from the block's marker
 * (`getBlockType`) plus code-fence tracking — a block that opens/closes a
 * fence, or sits inside one, is `code` regardless of its marker (a `- [ ]`
 * inside a fence is code, not a todo — the same rule as the graph ingest).
 */
export type BlockSearchType =
  | "todo"
  | "done"
  | "h1"
  | "h2"
  | "h3"
  | "h4"
  | "h5"
  | "h6"
  | "bullet"
  | "ordered"
  | "quote"
  | "code"
  | "text"

/**
 * The `type:` query vocabulary → the canonical block types each value matches.
 *
 * | value           | matches                                    |
 * | --------------- | ------------------------------------------ |
 * | `todo`          | unchecked checkbox                         |
 * | `done`          | checked checkbox                           |
 * | `task`          | any checkbox, checked or not               |
 * | `heading`       | any heading level                          |
 * | `h1`…`h6`       | that heading level (marker `#`…`######`)   |
 * | `list`          | bullet or ordered list item                |
 * | `bullet` / `ul` | bullet list item                           |
 * | `ordered`/ `ol` | ordered list item                          |
 * | `quote`         | quote                                      |
 * | `code`          | code-fence delimiter or line inside one    |
 * | `text`          | plain paragraph                            |
 *
 * A `type:` value outside this table is NOT block vocabulary: on its own the
 * filter stays a note-type filter (`type:daily`, `type:template` — see
 * search-notes.ts), unchanged from before. Mixed into a block-scoped comma
 * list (`type:todo,zzz`) an unknown value simply matches no blocks.
 */
const BLOCK_TYPE_VALUES: Record<string, readonly BlockSearchType[]> = {
  todo: ["todo"],
  done: ["done"],
  task: ["todo", "done"],
  heading: ["h1", "h2", "h3", "h4", "h5", "h6"],
  h1: ["h1"],
  h2: ["h2"],
  h3: ["h3"],
  h4: ["h4"],
  h5: ["h5"],
  h6: ["h6"],
  list: ["bullet", "ordered"],
  bullet: ["bullet"],
  ul: ["bullet"],
  ordered: ["ordered"],
  ol: ["ordered"],
  quote: ["quote"],
  code: ["code"],
  text: ["text"],
}

/** Is this a `type:` filter carrying at least one block-type value? Such a
 * filter matches blocks; any other filter (including `type:daily`) keeps its
 * note-level meaning. */
export function isBlockTypeFilter(filter: Filter): boolean {
  return filter.key === "type" && filter.values.some((value) => value in BLOCK_TYPE_VALUES)
}

/** Does this query resolve to blocks? (At least one block-scoped `type:`.) */
export function hasBlockTypeFilter(filters: Filter[]): boolean {
  return filters.some(isBlockTypeFilter)
}

/** One ancestor block on a hit's breadcrumb trail. */
export interface BlockAncestor {
  id: string
  /** Marker-free display text. */
  text: string
}

/** One direct child block carried on a hit for downstream context. */
export interface BlockChild {
  id: string
  /** Marker-free display text (verbatim for code lines, like a hit's own). */
  text: string
  type: BlockSearchType
}

/** How many direct children a hit carries at most. A matched section with
 * more still reports the full `childCount`, so a UI can say "…and N more". */
export const MAX_HIT_CHILDREN = 20

/**
 * One block-level search result. Carries everything a results row needs to
 * render and navigate without re-deriving: the target is the note route with
 * the `?block=` zoom param (`/notes/$noteId?block=$blockId`), the breadcrumb
 * is `ancestors`, `children` is the downstream context (searching for a
 * section shows what's inside it), and `note` is the containing note's full
 * metadata.
 */
export interface BlockHit {
  blockId: string
  noteId: NoteId
  /** The block's own text with its leading marker removed. */
  text: string
  type: BlockSearchType
  /** Ancestor blocks, outermost first (ids + display texts, for breadcrumbs). */
  ancestors: BlockAncestor[]
  /**
   * The block's direct children in order, one level deep, capped at
   * `MAX_HIT_CHILDREN` (see `childCount` for the true total). Context only —
   * the hit is the matching block, and result lists must not count children
   * as matches of their own.
   */
  children: BlockChild[]
  /** The block's true number of direct children (may exceed `children`). */
  childCount: number
  /** The containing note — metadata for note-level qualifiers and rendering. */
  note: Note
}

/** Classify a block, given the document's fence state where it sits. */
function blockSearchType(content: string, inFence: boolean): BlockSearchType {
  if (inFence || content.trimStart().startsWith("```")) return "code"
  const type = getBlockType(content)
  switch (type.kind) {
    case "heading":
      return `h${type.level}` as BlockSearchType
    case "todo":
      return type.checked ? "done" : "todo"
    case "quote":
      return "quote"
    case "bullet":
      return "bullet"
    case "ordered":
      return "ordered"
    default:
      return "text"
  }
}

/**
 * Parse one note into its block hits, in document order (the depth-first walk
 * the serializer emits — which is also how the fence state must be tracked).
 * This is the expensive per-note step the indexer memoizes.
 */
export function indexNoteBlocks(note: Note): BlockHit[] {
  const doc = parse(note.content)
  const hits: BlockHit[] = []
  const hitById = new Map<string, BlockHit>()
  let fenceOpen = false

  const walk = (ids: string[], ancestors: BlockAncestor[]) => {
    for (const id of ids) {
      const block = doc.blocks[id]
      if (!block) continue
      const inFence = fenceOpen
      if (block.content.trimStart().startsWith("```")) fenceOpen = !fenceOpen
      const type = blockSearchType(block.content, inFence)
      // Inside a fence the marker is code, not markup — keep the line verbatim.
      const text = type === "code" ? block.content : stripMarker(block.content)
      const hit: BlockHit = {
        blockId: id,
        noteId: note.id,
        text,
        type,
        ancestors,
        children: [],
        childCount: 0,
        note,
      }
      hits.push(hit)
      hitById.set(id, hit)
      walk(block.children, [...ancestors, { id, text }])
    }
  }
  walk(doc.rootBlockIds, [])

  // Second pass — downstream context. Children are visited after their parent
  // in the walk, so their text/type only exist once the walk is done.
  for (const hit of hits) {
    const childIds = doc.blocks[hit.blockId]?.children ?? []
    hit.childCount = childIds.length
    for (const childId of childIds.slice(0, MAX_HIT_CHILDREN)) {
      const child = hitById.get(childId)
      if (child) hit.children.push({ id: childId, text: child.text, type: child.type })
    }
  }

  return hits
}

/** The corpus-wide block index. `searcher` is built lazily on first access so
 * corpus changes never pay for fuzzy indexing that no query needs. */
export interface BlockIndex {
  /** Every block hit, in document order grouped by note (input note order). */
  hits: BlockHit[]
  readonly searcher: Searcher<BlockHit, FullOptions<BlockHit>>
}

/**
 * A memoizing index builder: call the returned function with the current note
 * list and only notes whose content changed are re-parsed. A note whose
 * content is unchanged but whose Note object was recreated (every corpus
 * change re-derives all Note objects) keeps its parsed blocks and just gets
 * the fresh `note` reference stitched in, so note-level qualifiers (tags,
 * backlinks) never go stale. Notes that disappear are evicted.
 */
export function createBlockIndexer(indexNote: (note: Note) => BlockHit[] = indexNoteBlocks) {
  const cache = new Map<NoteId, { content: string; note: Note; hits: BlockHit[] }>()

  return function buildIndex(notes: Note[]): BlockIndex {
    const seen = new Set<NoteId>()
    const all: BlockHit[] = []

    for (const note of notes) {
      seen.add(note.id)
      let cached = cache.get(note.id)
      if (!cached || cached.content !== note.content) {
        cached = { content: note.content, note, hits: indexNote(note) }
        cache.set(note.id, cached)
      } else if (cached.note !== note) {
        cached = {
          content: cached.content,
          note,
          hits: cached.hits.map((hit) => ({ ...hit, note })),
        }
        cache.set(note.id, cached)
      }
      for (const hit of cached.hits) all.push(hit)
    }

    for (const id of cache.keys()) {
      if (!seen.has(id)) cache.delete(id)
    }

    let searcher: Searcher<BlockHit, FullOptions<BlockHit>> | null = null
    return {
      hits: all,
      get searcher() {
        searcher ??= new Searcher(all, { keySelector: (hit) => hit.text, threshold: 0.8 })
        return searcher
      },
    }
  }
}

function testBlockTypeFilter(filter: Filter, hit: BlockHit): boolean {
  const match = filter.values.some((value) => BLOCK_TYPE_VALUES[value]?.includes(hit.type) ?? false)
  return filter.exclude ? !match : match
}

const collator = new Intl.Collator(undefined, {
  sensitivity: "base",
  numeric: true,
  ignorePunctuation: true,
})

function compareBlockHits(a: BlockHit, b: BlockHit, sorts: Sort[]): number {
  for (const sort of sorts) {
    let result = 0
    switch (sort.key) {
      case "text":
        result = collator.compare(a.text, b.text)
        break
      case "updated":
      case "updated_at":
        // Per-block updated_at lives in the SQL store, which is async — not
        // cheaply reachable from these synchronous atoms — so blocks sort by
        // their note's updated_at (null treated as infinitely old).
        result = (a.note.updatedAt ?? -Infinity) - (b.note.updatedAt ?? -Infinity)
        break
      default: {
        // Any other key is a note-level sort, delegated to the note comparator
        // (which applies direction itself).
        const noteResult = compareNotes(a.note, b.note, [sort])
        if (noteResult !== 0) return noteResult
        continue
      }
    }
    if (result !== 0) return sort.direction === "desc" ? -result : result
  }
  return 0
}

/**
 * Run a parsed query against the block index. Qualifiers AND together:
 * block-scoped `type:` filters test the block, everything else tests the
 * containing note. Fuzzy text ranks by relevance over block text; without it,
 * hits keep index order (document order grouped by note). `sort:` keys:
 * `text` (block text), `updated`/`updated_at` (note fallback, see above), and
 * any note-level key (`title`, frontmatter, …) applied via the containing
 * note.
 */
export function searchBlocks(query: Query, index: BlockIndex): BlockHit[] {
  const blockFilters = query.filters.filter(isBlockTypeFilter)
  const noteFilters = query.filters.filter((filter) => !isBlockTypeFilter(filter))

  const candidates = query.fuzzy ? index.searcher.search(query.fuzzy) : index.hits
  const results = candidates.filter(
    (hit) =>
      blockFilters.every((filter) => testBlockTypeFilter(filter, hit)) &&
      testNoteFilters(noteFilters, hit.note),
  )

  return query.sorts.length
    ? [...results].sort((a, b) => compareBlockHits(a, b, query.sorts))
    : results
}

/**
 * The notes containing a list of block hits, deduped in first-hit order —
 * what the notes list renders when a query carries a block-scoped `type:`
 * (per-note hits stay available by grouping on `noteId`).
 */
export function notesFromBlockHits(hits: BlockHit[]): Note[] {
  const seen = new Set<NoteId>()
  const notes: Note[] = []
  for (const hit of hits) {
    if (seen.has(hit.noteId)) continue
    seen.add(hit.noteId)
    notes.push(hit.note)
  }
  return notes
}
