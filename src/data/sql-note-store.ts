import migrationSql from "../../migrations/0001_init.sql?raw"
import { blockId } from "../blocks/id"
import { parse } from "../blocks/parse"
import { serialize } from "../blocks/serialize"
import type { BlockDoc } from "../blocks/types"
import type { NoteId } from "../schema"
import { docToRows, findCrossNoteIdCollisions, frontmatterUpdatedAt } from "./doc-to-rows"
import type { NoteStore } from "./note-store"
import type { SqlDriver, SqlStatement } from "./sql-driver"

/**
 * The SQL implementation of `NoteStore` (graph storage, phase 2).
 *
 * Backed by any `SqlDriver` (wa-sqlite/OPFS in the browser, `node:sqlite` in
 * tests) and the exact schema in `migrations/0001_init.sql` — the same file
 * that initializes the D1 replica. Notes decompose through `docToRows` into
 * `blocks` + `links` rows in the same transaction as the note row; reads
 * reassemble nothing — `notes.content` stays the authoritative verbatim
 * markdown and the graph tables are a derived index (the simplest shape that
 * can be verified byte-for-byte against git during the trial).
 *
 * Git/markdown remains the source of truth: this store is a derived runtime
 * replica, rebuildable at any time via `ingestWorktree`.
 */
export interface SqlNoteStore extends NoteStore {
  /** Wipe every table and repopulate from a full corpus, in one transaction. */
  replaceAll(notes: Record<NoteId, string>, viewStates?: Record<NoteId, string[]>): Promise<void>
  /** Row counts, for the diagnostics panel. */
  counts(): Promise<{ notes: number; blocks: number; links: number }>
  /** Every note's collapsed block ids in one read (notes without any omitted). */
  getAllViewStates(): Promise<Record<NoteId, string[]>>
  /** Read a `meta` key (e.g. the D1 pull cursor), or null when unset. */
  getMeta(key: string): Promise<string | null>
  /** Write a `meta` key. Kept in the same database as the rows it describes,
   * so wiping the store can never leave a stale cursor behind. */
  setMeta(key: string, value: string): Promise<void>
  close(): Promise<void>
}

const SCHEMA_VERSION = "1"

/** Drop everything the migration creates, so an incompatible schema can be
 * rebuilt from scratch — safe because the store is derived from git. */
const RESET_SQL = `
DROP TABLE IF EXISTS links;
DROP TABLE IF EXISTS blocks;
DROP TABLE IF EXISTS view_state;
DROP TABLE IF EXISTS notes;
DROP TABLE IF EXISTS meta;
`

/**
 * Open a `NoteStore` on `driver`, applying `migrations/0001_init.sql` when the
 * database is empty. A database reporting a different `meta.schema_version` is
 * reset and re-migrated (it is a derived replica — re-ingest, never migrate in
 * place during the trial).
 */
export async function openSqlNoteStore(driver: SqlDriver): Promise<SqlNoteStore> {
  const tables = await driver.exec(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'",
  )
  if (tables.length === 0) {
    await driver.execScript(migrationSql)
  } else {
    const rows = await driver.exec("SELECT value FROM meta WHERE key = 'schema_version'")
    if (rows[0]?.value !== SCHEMA_VERSION) {
      await driver.execScript(RESET_SQL + migrationSql)
    }
  }

  return {
    getNote: async (id) => {
      const rows = await driver.exec("SELECT content FROM notes WHERE id = ?", [id])
      return rows.length > 0 ? String(rows[0].content) : null
    },

    getAllNotes: async () => {
      const rows = await driver.exec("SELECT id, content FROM notes")
      const notes: Record<NoteId, string> = {}
      for (const row of rows) notes[String(row.id)] = String(row.content)
      return notes
    },

    writeNotes: async (updates) => {
      const statements: SqlStatement[] = []
      for (const [id, content] of Object.entries(updates)) {
        if (content === null) statements.push(...planNoteDelete(id))
        else statements.push(...planNoteReplace(id, content))
      }
      if (statements.length > 0) await driver.batch(statements)
    },

    deleteNote: async (id) => {
      await driver.batch(planNoteDelete(id))
    },

    getViewState: async (noteId) => {
      const rows = await driver.exec("SELECT collapsed FROM view_state WHERE note_id = ?", [noteId])
      if (rows.length === 0) return []
      return parseCollapsed(String(rows[0].collapsed))
    },

    setViewState: async (noteId, collapsedIds) => {
      const canonical = [...new Set(collapsedIds)].sort()
      if (canonical.length === 0) {
        await driver.batch([{ sql: "DELETE FROM view_state WHERE note_id = ?", params: [noteId] }])
      } else {
        await driver.batch([
          {
            sql:
              "INSERT INTO view_state (note_id, collapsed) VALUES (?, ?) " +
              "ON CONFLICT (note_id) DO UPDATE SET collapsed = excluded.collapsed",
            params: [noteId, JSON.stringify(canonical)],
          },
        ])
      }
    },

    replaceAll: async (notes, viewStates = {}) => {
      const statements: SqlStatement[] = [
        { sql: "DELETE FROM links" },
        { sql: "DELETE FROM blocks" },
        { sql: "DELETE FROM view_state" },
        { sql: "DELETE FROM notes" },
      ]
      for (const id of Object.keys(notes).sort()) {
        statements.push(...planNoteInsert(id, notes[id]))
      }
      for (const [noteId, ids] of Object.entries(viewStates)) {
        const canonical = [...new Set(ids)].sort()
        if (canonical.length === 0) continue
        statements.push({
          sql: "INSERT INTO view_state (note_id, collapsed) VALUES (?, ?)",
          params: [noteId, JSON.stringify(canonical)],
        })
      }
      await driver.batch(statements)
    },

    getAllViewStates: async () => {
      const rows = await driver.exec("SELECT note_id, collapsed FROM view_state")
      const viewStates: Record<NoteId, string[]> = {}
      for (const row of rows) {
        const collapsed = parseCollapsed(String(row.collapsed))
        if (collapsed.length > 0) viewStates[String(row.note_id)] = collapsed
      }
      return viewStates
    },

    getMeta: async (key) => {
      const rows = await driver.exec("SELECT value FROM meta WHERE key = ?", [key])
      return rows.length > 0 && rows[0].value != null ? String(rows[0].value) : null
    },

    setMeta: async (key, value) => {
      await driver.batch([
        {
          sql:
            "INSERT INTO meta (key, value) VALUES (?, ?) " +
            "ON CONFLICT (key) DO UPDATE SET value = excluded.value",
          params: [key, value],
        },
      ])
    },

    counts: async () => {
      const rows = await driver.exec(
        "SELECT (SELECT COUNT(*) FROM notes) AS notes, " +
          "(SELECT COUNT(*) FROM blocks) AS blocks, " +
          "(SELECT COUNT(*) FROM links) AS links",
      )
      return {
        notes: Number(rows[0]?.notes ?? 0),
        blocks: Number(rows[0]?.blocks ?? 0),
        links: Number(rows[0]?.links ?? 0),
      }
    },

    close: () => driver.close(),
  }
}

/** Tolerant parse of a `view_state.collapsed` JSON array (mirrors the sidecar
 * parsing: anything malformed degrades to empty). */
function parseCollapsed(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((x): x is string => typeof x === "string")
  } catch {
    return []
  }
}

/** Insert one note's row + graph rows (no cleanup — for freshly wiped tables). */
function planNoteInsert(id: NoteId, content: string): SqlStatement[] {
  const statements: SqlStatement[] = [
    {
      sql:
        "INSERT INTO notes (id, content, updated_at) VALUES (?, ?, ?) " +
        "ON CONFLICT (id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at",
      params: [id, content, frontmatterUpdatedAt(content)],
    },
  ]
  const { blocks, links } = docToRows(id, parse(content))
  for (const b of blocks) {
    statements.push({
      sql: "INSERT INTO blocks (id, note_id, parent_id, position, content) VALUES (?, ?, ?, ?, ?)",
      params: [b.id, b.note_id, b.parent_id, b.position, b.content],
    })
  }
  for (const l of links) {
    statements.push({
      sql: "INSERT OR IGNORE INTO links (from_block, to_note, to_block, kind) VALUES (?, ?, ?, ?)",
      params: [l.from_block, l.to_note, l.to_block, l.kind],
    })
  }
  return statements
}

/** Replace one note wholesale — the same shape as the worker's `planReplicaPut`:
 * upsert the note row, drop its old links/blocks, insert the new rows. */
function planNoteReplace(id: NoteId, content: string): SqlStatement[] {
  const [upsert, ...inserts] = planNoteInsert(id, content)
  return [
    upsert,
    {
      sql: "DELETE FROM links WHERE from_block IN (SELECT id FROM blocks WHERE note_id = ?)",
      params: [id],
    },
    { sql: "DELETE FROM blocks WHERE note_id = ?", params: [id] },
    ...inserts,
  ]
}

function planNoteDelete(id: NoteId): SqlStatement[] {
  return [
    {
      sql: "DELETE FROM links WHERE from_block IN (SELECT id FROM blocks WHERE note_id = ?)",
      params: [id],
    },
    { sql: "DELETE FROM blocks WHERE note_id = ?", params: [id] },
    { sql: "DELETE FROM view_state WHERE note_id = ?", params: [id] },
    { sql: "DELETE FROM notes WHERE id = ?", params: [id] },
  ]
}

// -----------------------------------------------------------------------------
// Ingest (initial population + cross-note block-id dedup)
// -----------------------------------------------------------------------------

/** One re-keyed block: `noteId`'s block `oldId` became `newId`; the first note
 * in sorted id order (`keeperNoteId`) kept the original id. */
export interface RekeyRecord {
  noteId: NoteId
  keeperNoteId: NoteId
  oldId: string
  newId: string
}

export interface IngestResult {
  /** Notes ingested (after rewrites). */
  ingestedNotes: number
  /** Collision re-keys performed (empty when the corpus was clean). */
  rekeys: RekeyRecord[]
  /**
   * Rewritten note contents (`id::` lines re-keyed), keyed by note id. Git is
   * canonical, so the caller MUST persist these through the normal note save
   * path — the ingest only wrote them to the SQL store.
   */
  rewrittenNotes: Record<NoteId, string>
}

/**
 * Full rebuild of the SQL store from the current worktree: wipe + insert every
 * note (and its view state) in one transaction.
 *
 * Runs `findCrossNoteIdCollisions` first and re-keys collisions per the design
 * in docs/graph-storage.md: the first note in sorted id order keeps the id;
 * every later note gets a fresh `blk_` id minted and its `id::` line rewritten
 * (parse → rename → serialize, the same transform a normal editor save
 * performs). The rewritten contents are ingested here and returned in
 * `rewrittenNotes` for the caller to persist through the git save path.
 */
export async function ingestWorktree(
  store: SqlNoteStore,
  notes: Record<NoteId, string>,
  viewStates?: Record<NoteId, string[]>,
): Promise<IngestResult> {
  const rekeys: RekeyRecord[] = []
  const rewrittenNotes: Record<NoteId, string> = {}

  const collisions = findCrossNoteIdCollisions(notes)
  if (collisions.length > 0) {
    // Group by losing note so each note is parsed and serialized exactly once,
    // no matter how many of its blocks collide.
    const byLoser = new Map<NoteId, { oldId: string; keeperNoteId: NoteId }[]>()
    for (const { blockId: oldId, noteIds } of collisions) {
      for (const loser of noteIds.slice(1)) {
        const entry = byLoser.get(loser) ?? []
        entry.push({ oldId, keeperNoteId: noteIds[0] })
        byLoser.set(loser, entry)
      }
    }
    for (const [noteId, colliding] of byLoser) {
      const doc = parse(notes[noteId])
      for (const { oldId, keeperNoteId } of colliding) {
        // `parse` may already have re-keyed an intra-document duplicate.
        if (!doc.blocks[oldId]) continue
        let newId = blockId()
        while (doc.blocks[newId]) newId = blockId()
        renameBlock(doc, oldId, newId)
        rekeys.push({ noteId, keeperNoteId, oldId, newId })
      }
      rewrittenNotes[noteId] = serialize(doc)
    }
  }

  const finalNotes = { ...notes, ...rewrittenNotes }
  await store.replaceAll(finalNotes, viewStates)

  return { ingestedNotes: Object.keys(finalNotes).length, rekeys, rewrittenNotes }
}

function renameBlock(doc: BlockDoc, oldId: string, newId: string) {
  const block = doc.blocks[oldId]
  delete doc.blocks[oldId]
  doc.blocks[newId] = { ...block, id: newId }
  doc.rootBlockIds = doc.rootBlockIds.map((id) => (id === oldId ? newId : id))
  for (const b of Object.values(doc.blocks)) {
    if (b.children.includes(oldId)) {
      b.children = b.children.map((id) => (id === oldId ? newId : id))
    }
  }
}
