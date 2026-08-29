// The replica wire format, shared between the Worker and the client.
//
// This module is deliberately pure — no Cloudflare types, no cookie handling,
// nothing but the payload shapes, their validation, and the SQL planning for
// `PUT /api/replica/notes`. The Worker (`replica.ts`) imports it to validate
// and plan real requests; the client (`src/data/replica-sync.ts`) imports the
// *types* so the payload it builds is the payload the Worker parses, and the
// client's unit tests import `parseReplicaPayload` itself to prove the built
// payloads round-trip — same repo, same file, no drift.

const LINK_KINDS = ["wikilink", "transclusion", "tag"] as const

interface NoteRow {
  id: string
  content: string
  updated_at: number | null
}

interface BlockRow {
  id: string
  note_id: string
  parent_id: string | null
  position: number
  content: string
}

interface LinkRow {
  from_block: string
  to_note: string | null
  to_block: string | null
  kind: (typeof LINK_KINDS)[number]
}

/** One note's full replica record, as produced by `src/data/doc-to-rows.ts`. */
export interface ReplicaNoteEntry {
  note: NoteRow
  blocks: BlockRow[]
  links: LinkRow[]
  /** Collapsed block ids (canonical view state); empty clears the row. */
  view_state: string[]
}

export interface ReplicaPutPayload {
  notes: ReplicaNoteEntry[]
  /** Note ids to remove from the replica (deleted or renamed away). */
  deletes?: string[]
  /** Opaque client marker of the replicated repo state (monotonic per client). */
  cursor?: string
}

/** The body of `GET /api/replica/status`. */
export interface ReplicaStatusBody {
  counts: { notes: number; blocks: number; links: number; view_state: number }
  schema_version: string | null
  replica_cursor: string | null
}

/** A planned SQL statement: the pure, D1-free representation of the write. */
export interface SqlStatement {
  sql: string
  params: (string | number | null)[]
}

const isString = (x: unknown): x is string => typeof x === "string"
const isStringOrNull = (x: unknown): x is string | null => x === null || typeof x === "string"

function parseNoteEntry(x: unknown): ReplicaNoteEntry | null {
  if (typeof x !== "object" || x === null) return null
  const entry = x as Record<string, unknown>
  const note = entry.note as Record<string, unknown> | null | undefined
  if (
    typeof note !== "object" ||
    note === null ||
    !isString(note.id) ||
    note.id.length === 0 ||
    !isString(note.content) ||
    !(note.updated_at === null || typeof note.updated_at === "number")
  ) {
    return null
  }
  if (!Array.isArray(entry.blocks) || !Array.isArray(entry.links)) return null
  for (const b of entry.blocks as Record<string, unknown>[]) {
    if (
      typeof b !== "object" ||
      b === null ||
      !isString(b.id) ||
      b.note_id !== note.id ||
      !isStringOrNull(b.parent_id) ||
      typeof b.position !== "number" ||
      !isString(b.content)
    ) {
      return null
    }
  }
  for (const l of entry.links as Record<string, unknown>[]) {
    if (
      typeof l !== "object" ||
      l === null ||
      !isString(l.from_block) ||
      !isStringOrNull(l.to_note) ||
      !isStringOrNull(l.to_block) ||
      !LINK_KINDS.includes(l.kind as LinkRow["kind"])
    ) {
      return null
    }
  }
  if (!Array.isArray(entry.view_state) || !(entry.view_state as unknown[]).every(isString)) {
    return null
  }
  return {
    note: { id: note.id, content: note.content, updated_at: note.updated_at as number | null },
    blocks: (entry.blocks as BlockRow[]).map((b) => ({
      id: b.id,
      note_id: b.note_id,
      parent_id: b.parent_id,
      position: b.position,
      content: b.content,
    })),
    links: (entry.links as LinkRow[]).map((l) => ({
      from_block: l.from_block,
      to_note: l.to_note,
      to_block: l.to_block,
      kind: l.kind,
    })),
    view_state: entry.view_state as string[],
  }
}

/**
 * Validate an untrusted request body into a `ReplicaPutPayload`, or null.
 * Hand-rolled (no schema library) to keep the Worker bundle lean.
 */
export function parseReplicaPayload(body: unknown): ReplicaPutPayload | null {
  if (typeof body !== "object" || body === null) return null
  const raw = body as Record<string, unknown>
  if (!Array.isArray(raw.notes)) return null
  const notes: ReplicaNoteEntry[] = []
  for (const entry of raw.notes) {
    const parsed = parseNoteEntry(entry)
    if (!parsed) return null
    notes.push(parsed)
  }
  if (raw.deletes !== undefined && !(Array.isArray(raw.deletes) && raw.deletes.every(isString))) {
    return null
  }
  if (raw.cursor !== undefined && !isString(raw.cursor)) return null
  return { notes, deletes: raw.deletes as string[] | undefined, cursor: raw.cursor as string }
}

/**
 * Plan the SQL for one replica push. Pure: returns statements + bind params;
 * the Worker turns them into a single `db.batch()` (one transaction).
 *
 * Per note the write is a replace: upsert the note row first (blocks FK on
 * it), drop its old links (via its old blocks) and blocks, then insert the
 * new rows. Link inserts use OR IGNORE so the unique edge index makes replays
 * idempotent. View state mirrors the sidecar: a row when anything is
 * collapsed, no row otherwise.
 */
export function planReplicaPut(payload: ReplicaPutPayload): SqlStatement[] {
  const statements: SqlStatement[] = []
  const dropNoteGraph = (noteId: string) => {
    statements.push({
      sql: "DELETE FROM links WHERE from_block IN (SELECT id FROM blocks WHERE note_id = ?1)",
      params: [noteId],
    })
    statements.push({ sql: "DELETE FROM blocks WHERE note_id = ?1", params: [noteId] })
  }

  for (const { note, blocks, links, view_state } of payload.notes) {
    statements.push({
      sql:
        "INSERT INTO notes (id, content, updated_at) VALUES (?1, ?2, ?3) " +
        "ON CONFLICT (id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at",
      params: [note.id, note.content, note.updated_at],
    })
    dropNoteGraph(note.id)
    for (const b of blocks) {
      statements.push({
        sql: "INSERT INTO blocks (id, note_id, parent_id, position, content) VALUES (?1, ?2, ?3, ?4, ?5)",
        params: [b.id, b.note_id, b.parent_id, b.position, b.content],
      })
    }
    for (const l of links) {
      statements.push({
        sql: "INSERT OR IGNORE INTO links (from_block, to_note, to_block, kind) VALUES (?1, ?2, ?3, ?4)",
        params: [l.from_block, l.to_note, l.to_block, l.kind],
      })
    }
    if (view_state.length > 0) {
      statements.push({
        sql:
          "INSERT INTO view_state (note_id, collapsed) VALUES (?1, ?2) " +
          "ON CONFLICT (note_id) DO UPDATE SET collapsed = excluded.collapsed",
        params: [note.id, JSON.stringify([...new Set(view_state)].sort())],
      })
    } else {
      statements.push({ sql: "DELETE FROM view_state WHERE note_id = ?1", params: [note.id] })
    }
  }

  for (const noteId of payload.deletes ?? []) {
    dropNoteGraph(noteId)
    statements.push({ sql: "DELETE FROM notes WHERE id = ?1", params: [noteId] })
    statements.push({ sql: "DELETE FROM view_state WHERE note_id = ?1", params: [noteId] })
  }

  if (payload.cursor !== undefined) {
    statements.push({
      sql: "UPDATE meta SET value = ?1 WHERE key = 'replica_cursor'",
      params: [payload.cursor],
    })
  }

  return statements
}
