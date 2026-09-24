import { isTombstoned, type LinkRow, type NodeRow } from "../../worker/handlers/replica-payload"
import type { NoteId } from "../schema"
import { CHILD_KIND, NOTE_TYPE } from "./graph"
import { emittedNoteTitle } from "./note-identity"
import type { Op } from "./ops"

/**
 * Recently deleted notes, and putting one back.
 *
 * A delete never removes a row (docs/graph-storage.md, "Remove = unlink,
 * delete is explicit"): deleting a note stamps `deleted_at` on its node and
 * on every block the delete took with it (`deleteNoteOps`), all with the one
 * timestamp of the write that landed them, and leaves every link row in
 * place. So the rows the store hands back with tombstones included
 * (`NoteStore.getAllRows`) still hold the whole note, and the restore is the
 * reverse of the delete: re-create the note and the blocks stamped with it,
 * and re-link them along the links that were kept.
 *
 * Which blocks "were stamped with it": one flush can land several deletes
 * under one stamp, so the stamp alone is not enough. The blocks a note takes
 * with it are the ones it reaches and the ones written in it (its basket),
 * so a restore walks the retained links out from the note, and from the
 * basket's roots, taking only blocks that share the note's stamp — a block
 * deleted on its own earlier stays deleted, and a live block is left as it
 * is, still linked from the revived note as it was before.
 */

/** The corpus rows a restore reads: `getAllRows` (views are not needed). */
export interface CorpusRows {
  nodes: readonly NodeRow[]
  links: readonly LinkRow[]
}

export interface DeletedNote {
  id: NoteId
  /** The note's title as it was; the id when it had none. */
  title: string
  /** When it was deleted (ms epoch). */
  deletedAt: number
  /** How many blocks come back with it. */
  blocks: number
}

/** The deleted notes the rows hold, newest deletion first. */
export function deletedNotesOf(rows: CorpusRows): DeletedNote[] {
  const notes: DeletedNote[] = []
  for (const node of rows.nodes) {
    if (node.type !== NOTE_TYPE || !isTombstoned(node)) continue
    notes.push({
      id: node.id,
      title: emittedNoteTitle(node.id, node.text) ?? node.id,
      deletedAt: node.deleted_at as number,
      blocks: revivedIdsOf(node, rows).size - 1,
    })
  }
  return notes.sort((a, b) => b.deletedAt - a.deletedAt || (a.id < b.id ? -1 : 1))
}

/**
 * The batch that restores a deleted note: a `create` for the note and each
 * block that went with it, and a `link` for every retained link between two
 * of them, or between one of them and a live node (the corpus root's link
 * to the note, so it keeps its place in the order; a block another note
 * also holds, so it hangs beneath both again). Empty for a note the rows do
 * not hold, or hold live. Applying it to the graph the rows describe yields
 * the note as it was before its delete, less the links unlinked before then
 * — those were tombstoned in their own right and stay so.
 */
export function restoreNoteOps(noteId: NoteId, rows: CorpusRows): Op[] {
  const note = rows.nodes.find((node) => node.id === noteId)
  if (!note || note.type !== NOTE_TYPE || !isTombstoned(note)) return []
  const nodes = new Map(rows.nodes.map((node) => [node.id, node]))
  const revived = revivedIdsOf(note, rows)
  const alive = (id: string) => {
    if (revived.has(id)) return true
    const node = nodes.get(id)
    return node !== undefined && !isTombstoned(node)
  }
  const ops: Op[] = []
  for (const id of revived) {
    const node = nodes.get(id) as NodeRow
    ops.push({
      op: "create",
      id,
      type: node.type,
      text: node.text,
      props: node.props,
      ...(node.notes_id ? { notesId: node.notes_id } : {}),
    })
  }
  for (const link of rows.links) {
    if (isTombstoned(link) || link.kind !== CHILD_KIND) continue
    if (!revived.has(link.source_id) && !revived.has(link.destination_id)) continue
    if (!alive(link.source_id) || !alive(link.destination_id)) continue
    ops.push({
      op: "link",
      source: link.source_id,
      destination: link.destination_id,
      sortKey: link.sort_key,
    })
  }
  return ops
}

/** The note and every block its delete took with it (see the module note):
 * the nodes sharing its stamp that the retained links reach from it or from
 * the roots of its basket. */
function revivedIdsOf(note: NodeRow, rows: CorpusRows): Set<string> {
  const stamp = note.deleted_at
  const nodes = new Map(rows.nodes.map((node) => [node.id, node]))
  const children = new Map<string, string[]>()
  for (const link of rows.links) {
    if (isTombstoned(link) || link.kind !== CHILD_KIND) continue
    let list = children.get(link.source_id)
    if (!list) children.set(link.source_id, (list = []))
    list.push(link.destination_id)
  }
  const revived = new Set<string>([note.id])
  const stack: string[] = [note.id]
  for (const node of rows.nodes) {
    if (node.notes_id !== note.id || node.deleted_at !== stamp || node.type === NOTE_TYPE) continue
    if (revived.has(node.id)) continue
    revived.add(node.id)
    stack.push(node.id)
  }
  while (stack.length > 0) {
    const id = stack.pop() as string
    for (const child of children.get(id) ?? []) {
      if (revived.has(child)) continue
      const node = nodes.get(child)
      if (!node || node.type === NOTE_TYPE || node.deleted_at !== stamp) continue
      revived.add(child)
      stack.push(child)
    }
  }
  return revived
}
