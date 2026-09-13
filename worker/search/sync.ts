// Keeping the vector index in step with the corpus, off `seq` rather than off
// a write path (docs/semantic-search.md, docs/mcp-search.md).
//
// ## Why not embed on write
//
// Because MCP is not the only writer. The browser pushes its edits through the
// replica (`corpusPut`); an agent's edits go through `applyOpsToReplica`. An
// index hooked into either one would be quietly, permanently wrong about
// everything the other did — and "quietly" is the operative word, because a
// missing vector looks exactly like a block that did not match.
//
// ## The mechanism that already exists
//
// Migration 0005 gave every row a server-assigned, per-tenant `seq`, monotonic
// and assigned inside the same transaction as the write, precisely so that
// "what changed since?" is one exact query. The replica's incremental pull is
// built on it and has been in production since 2026-09-09. So:
//
//     read meta 'embed_cursor'
//       →  SELECT … WHERE seq > cursor      (two index seeks)
//       →  re-chunk the notes those rows touch
//       →  embed, upsert, delete the tail
//       →  store the new cursor
//
// Which covers EVERY writer by construction, needs no hook in any write path,
// and is restartable: a pass that dies before storing the cursor repeats
// itself, and every operation in it is idempotent (an upsert of the same chunk
// with the same text, a delete of an id that is already gone).
//
// Tombstones travel through it for free — a delete takes a `seq` like any
// other write — but only if the indexer ACTS on `deleted_at` rather than
// skipping it. It does: the changed-row queries are `includingDeleted` reads,
// and a note whose row is tombstoned has all of its vectors removed rather
// than merely not refreshed.
//
// ## The cost of a pass
//
// A pass that finds nothing changed costs two index seeks on
// `nodes_tenant_seq` / `link_tenant_seq` and nothing else — no snapshot, no
// embedding call, no Vectorize call.
//
// A pass that finds ANYTHING changed loads the tenant's whole live corpus
// once. That is deliberate and it is not a lapse in the bounded-read
// discipline of docs/mcp-server.md §4: "which notes does this changed block
// appear in?" is a question about the whole graph (a block can hang in several
// notes, and changing it changes what each of them shows), and the corpus is
// ~1,700 rows. The alternative — an upward walk per changed row — costs more
// than one corpus load as soon as a handful of rows move, which is what a save
// looks like.

import { NOTE_TYPE, type GraphSnapshot } from "../../src/data/graph"
import { noteIds, reachableFrom } from "../../src/data/ops"
import { noteFromNode } from "../../src/data/note-meta"
import { indexNoteBlocks } from "../../src/utils/block-search"
import { chunkId, sectionChunks, MAX_CHUNKS_PER_NOTE } from "../../src/utils/search-chunks"
import type { TenantDb } from "../tenancy-db"
import { loadSnapshot } from "../mcp/graph-access"
import type { Semantic } from "./engine"

/** The `meta` key holding how far the indexer has read. Per tenant, like every
 * other `meta` row (migration 0004). */
const CURSOR_KEY = "embed_cursor"

export interface SyncReport {
  /** Where the cursor started and where it ended. Equal = nothing to do. */
  from: number
  to: number
  /** Rows the `seq > cursor` queries returned. */
  changedRows: number
  /** Notes re-chunked (or, if they are gone, cleared). */
  notesIndexed: number
  notesRemoved: number
  chunksUpserted: number
  vectorsDeleted: number
}

/** The cursor, or 0 — an absent row means "nothing has ever been indexed",
 * which is the same thing as starting from the beginning. */
async function readCursor(tenant: TenantDb): Promise<number> {
  const rows = await tenant.exec("SELECT value FROM meta WHERE user_id = :tenant AND key = ?1", [
    CURSOR_KEY,
  ])
  const value = Number(rows[0]?.value ?? 0)
  return Number.isFinite(value) && value > 0 ? value : 0
}

async function writeCursor(tenant: TenantDb, seq: number): Promise<void> {
  await tenant.exec(
    "INSERT INTO meta (user_id, key, value) VALUES (:tenant, ?1, ?2) " +
      "ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value",
    [CURSOR_KEY, String(seq)],
  )
}

/**
 * Reset the cursor, so the next pass re-reads and re-embeds everything.
 *
 * The operator's lever, and the honest one: the model, the chunker or the
 * dimensions changing all mean every stored vector is stale in a way no
 * incremental pass can notice, because nothing about the ROWS changed.
 */
export async function resetCursor(tenant: TenantDb): Promise<void> {
  await writeCursor(tenant, 0)
}

interface Changed {
  /** Node ids and link endpoints the changed rows name. */
  touched: Set<string>
  /** `notes_id` values on changed node rows — the note a block was WRITTEN in,
   * which is how an Unassigned block still names its note. */
  notes: Set<string>
  rows: number
  maxSeq: number
}

/**
 * The rows past the cursor, as the two things the indexer needs from them.
 *
 * Both reads include tombstones, and that is the point rather than an
 * oversight: the row that says a block was deleted is the change being read,
 * and dropping it would leave its vectors in the index for ever.
 *
 * `maxSeq` is taken over the rows ACTUALLY returned, never from a separate
 * `SELECT MAX(seq)` — the same argument `cursorOf` makes in
 * replica-corpus.ts. A maximum read separately could observe a write that
 * landed after these queries ran, and the cursor would then skip it for ever.
 */
async function changedSince(tenant: TenantDb, cursor: number): Promise<Changed> {
  const all = tenant.includingDeleted()
  const [nodes, links] = await Promise.all([
    all.exec(
      "SELECT id, type, notes_id, seq FROM nodes WHERE user_id = :tenant AND seq > ?1 " +
        "/* includes-deleted: a tombstoned row IS the change — its vectors must go */",
      [cursor],
    ),
    all.exec(
      "SELECT source_id, destination_id, seq FROM link " +
        "WHERE user_id = :tenant AND seq > ?1 " +
        "/* includes-deleted: an unlinked block changes the notes that held it */",
      [cursor],
    ),
  ])

  const touched = new Set<string>()
  const notes = new Set<string>()
  let maxSeq = cursor
  for (const row of nodes) {
    touched.add(String(row.id))
    if (row.notes_id !== null && row.notes_id !== undefined) notes.add(String(row.notes_id))
    if (row.type === NOTE_TYPE) notes.add(String(row.id))
    if (Number(row.seq) > maxSeq) maxSeq = Number(row.seq)
  }
  for (const row of links) {
    touched.add(String(row.source_id))
    touched.add(String(row.destination_id))
    if (Number(row.seq) > maxSeq) maxSeq = Number(row.seq)
  }
  return { touched, notes, rows: nodes.length + links.length, maxSeq }
}

/**
 * Which notes have to be re-chunked, given what changed.
 *
 * Three sources, and the third is the one that is easy to miss:
 *
 * 1. a live note that REACHES a touched node — the note's outline changed;
 * 2. a live note that IS a touched node — its title or props changed;
 * 3. a note NAMED by a changed row that no longer exists in the live snapshot
 *    — it was deleted, and its vectors have to go with it. This one cannot be
 *    found by walking the graph, because the thing to find is not in the graph
 *    any more.
 */
function affectedNotes(snapshot: GraphSnapshot, changed: Changed): Set<string> {
  const affected = new Set<string>()
  for (const id of noteIds(snapshot)) {
    if (changed.touched.has(id)) {
      affected.add(id)
      continue
    }
    for (const reached of reachableFrom(snapshot, [id])) {
      if (changed.touched.has(reached)) {
        affected.add(id)
        break
      }
    }
  }
  for (const id of changed.notes) affected.add(id)
  return affected
}

/** Every vector id a note could have, live or stale. Deleting the whole window
 * is what lets a shrinking note leave nothing behind without the indexer
 * remembering how many chunks it used to have. */
const windowFor = (noteId: string, from: number): string[] =>
  Array.from({ length: MAX_CHUNKS_PER_NOTE - from }, (_, offset) => chunkId(noteId, from + offset))

/**
 * One incremental pass.
 *
 * Idempotent and restartable: run it twice and the second run finds nothing.
 * Run it after a crash and it repeats the work of the pass that died, because
 * the cursor only moves once everything before it is in the index.
 */
export async function syncVectors(tenant: TenantDb, semantic: Semantic): Promise<SyncReport> {
  const from = await readCursor(tenant)
  const changed = await changedSince(tenant, from)

  const report: SyncReport = {
    from,
    to: from,
    changedRows: changed.rows,
    notesIndexed: 0,
    notesRemoved: 0,
    chunksUpserted: 0,
    vectorsDeleted: 0,
  }
  if (changed.rows === 0) return report

  const snapshot = await loadSnapshot(tenant)
  const live = new Set(noteIds(snapshot))

  for (const noteId of affectedNotes(snapshot, changed)) {
    if (!live.has(noteId)) {
      // Gone. Clear the whole window rather than the chunks it used to have —
      // which the indexer does not know, and deliberately does not store.
      await semantic.store.remove(windowFor(noteId, 0))
      report.notesRemoved += 1
      report.vectorsDeleted += MAX_CHUNKS_PER_NOTE
      continue
    }

    const note = noteFromNode(noteId, snapshot)
    // `noteIds` said this is a live note, so `noteFromNode` answers — but it
    // is typed as nullable and a silent `!` is how that stops being true.
    if (!note) continue
    const { hits } = indexNoteBlocks(note, snapshot)
    const chunks = sectionChunks(note.displayName, hits)

    if (chunks.length > 0) {
      const vectors = await semantic.embedder.embed(chunks.map((chunk) => chunk.text))
      await semantic.store.upsert(
        chunks.map((chunk, index) => ({
          id: chunkId(noteId, chunk.ordinal),
          values: vectors[index],
        })),
      )
      report.chunksUpserted += chunks.length
    }
    // The tail: ordinals this note used to have and no longer does.
    const stale = windowFor(noteId, chunks.length)
    await semantic.store.remove(stale)
    report.vectorsDeleted += stale.length
    report.notesIndexed += 1
  }

  await writeCursor(tenant, changed.maxSeq)
  report.to = changed.maxSeq
  return report
}
