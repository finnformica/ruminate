/**
 * What gets embedded — the one decision the semantic half of search stands or
 * falls on (docs/semantic-search.md).
 *
 * This corpus is an OUTLINER. Production holds 634 blocks in 25,847
 * characters: a mean of 41 characters, about eight words, the longest 175. An
 * eight-word fragment embedded on its own carries very little, and the
 * experiment that measured it (`scripts/chunking-experiment.ts`) says so
 * plainly — over a 521-block fixture of the same shape, a paraphrased query
 * found its block in the top five 54% of the time from the bare text, 61% with
 * the note's title in front of it, and **85% when the unit embedded was a
 * heading with its section under it**.
 *
 * So the unit is a SECTION: a heading plus everything under it until the next
 * heading, in the order the note reads. Three properties follow, and each is
 * load-bearing:
 *
 * 1. **A section has enough words to mean something.** "Cold retard overnight
 *    gives the open crumb" retrieves for "how do I get big holes in the
 *    crumb"; "Do not cut it hot" does not, and it is in the same section.
 * 2. **A section is what the workflow asks for.** The thing an agent wants is
 *    "the subtree that gives context on this problem" (docs/mcp-search.md) —
 *    which is a section, not a bullet.
 * 3. **It carries no ancestor path.** A chunk is a heading and its own text,
 *    plus the note's title; it is NOT a breadcrumb. This is a graph, a block
 *    is reachable by many paths, and there is no single "the" path to embed.
 *    The note title is safe because `notes_id` is one stable value set once,
 *    at creation — a fact about the row, not a fact about a route to it.
 *
 * The chunker is a pure function over the note's OWN document-order walk
 * (`indexNoteBlocks`, block-search.ts) — the same walk the block results are
 * drawn from — so a chunk is a run of the rows the person would see, never a
 * second reading of the outline.
 */
import { searchTypeValues } from "../blocks/registry"
import type { BlockType } from "../blocks/types"
import type { NoteId } from "../schema"
import type { BlockHit } from "./block-search"

/** The heading types, from the registry's own `type:` vocabulary — so
 * `type:heading` in a query and a chunk boundary here mean the same thing. */
const HEADINGS: ReadonlySet<BlockType> = new Set(searchTypeValues().heading ?? [])

/**
 * The longest chunk, in characters.
 *
 * A note with no headings is one section, and one section must not become the
 * whole note: a 25,000-character chunk retrieves for everything and pinpoints
 * nothing, which is the failure at the other end of the same axis as embedding
 * eight words. Overflow starts a new chunk at the next block, so a long
 * section is several chunks rather than a truncated one — nothing is dropped.
 */
const MAX_CHUNK_CHARS = 1500

/**
 * The most chunks one note is split into.
 *
 * This is not a size limit, it is the DELETE window. A note is re-indexed by
 * upserting chunks `0…n-1` and deleting `n…MAX_CHUNKS-1`, which is what makes
 * a shrinking note leave no stale vectors behind without storing how many
 * chunks it used to have (worker/search/sync.ts). A note that would exceed it
 * keeps its tail in the last chunk — longer than `MAX_CHUNK_CHARS`, and still
 * indexed. At 1,500 characters a chunk, 64 chunks is 96,000 characters: four
 * times the entire production corpus, in one note.
 */
export const MAX_CHUNKS_PER_NOTE = 64

/**
 * One embeddable unit. `ordinal` is its position in the note, and with the
 * note id it is the vector's whole identity — the index stores no text and no
 * metadata, because everything else is derivable from the graph at query time
 * through the scoped accessors (worker/mcp/graph-access.ts). An index that
 * held block text would be a second copy of the corpus to keep in step, and a
 * second place a note-scope check could be got wrong.
 */
export interface SectionChunk {
  noteId: NoteId
  ordinal: number
  /** The blocks this chunk covers, in document order. Never empty. */
  blockIds: string[]
  /** What is actually embedded. */
  text: string
}

/**
 * Split one note's document-order hits into section chunks.
 *
 * `hits` is `indexNoteBlocks(note, snapshot).hits` — the note's blocks in the
 * order the note reads. A new chunk starts at every heading, and at whatever
 * block overflows `MAX_CHUNK_CHARS`. The note's title leads every chunk, so a
 * query naming the note ("what did I decide about the house move") reaches its
 * sections without the title having to be repeated in the blocks themselves.
 *
 * A note with no blocks yields no chunks — there is nothing to embed, and a
 * vector of a bare title would match every query about that title equally.
 */
export function sectionChunks(noteTitle: string, hits: readonly BlockHit[]): SectionChunk[] {
  if (hits.length === 0) return []

  const chunks: SectionChunk[] = []
  let lines: string[] = []
  let blockIds: string[] = []
  let length = 0

  const flush = () => {
    if (blockIds.length === 0) return
    chunks.push({
      noteId: hits[0].noteId,
      ordinal: chunks.length,
      blockIds,
      text: [noteTitle, ...lines].filter(Boolean).join("\n"),
    })
    lines = []
    blockIds = []
    length = 0
  }

  for (const hit of hits) {
    const breaks = HEADINGS.has(hit.type) || length + hit.text.length > MAX_CHUNK_CHARS
    // The last chunk swallows the tail rather than losing it — see
    // MAX_CHUNKS_PER_NOTE.
    if (breaks && chunks.length < MAX_CHUNKS_PER_NOTE - 1) flush()
    lines.push(hit.text)
    blockIds.push(hit.blockId)
    length += hit.text.length + 1
  }
  flush()

  return chunks
}

/** The vector id for a chunk. Note-scoped because a block id can be PINNED and
 * so appear in two notes (`blockKey`, block-search.ts) — and because the note
 * is the unit the indexer re-indexes and deletes by. */
export const chunkId = (noteId: NoteId, ordinal: number): string => `${noteId}#${ordinal}`

/** The note and ordinal a vector id names, or null if it is not one of ours
 * (a stale id from an older scheme, say — dropped rather than guessed at). */
export function parseChunkId(id: string): { noteId: NoteId; ordinal: number } | null {
  const at = id.lastIndexOf("#")
  if (at <= 0) return null
  const ordinal = Number(id.slice(at + 1))
  if (!Number.isInteger(ordinal) || ordinal < 0) return null
  return { noteId: id.slice(0, at), ordinal }
}
