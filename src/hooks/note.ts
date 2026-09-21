import { useAtomValue, useStore } from "jotai"
import { selectAtom } from "jotai/utils"
import React from "react"
import { NOTE_TYPE, propsJson } from "../data/graph"
import { notePropsOps } from "../data/note-meta"
import { deleteNoteOps, type Op } from "../data/ops"
import { moveNoteOps } from "../data/note-order"
import { emittedNoteTitle } from "../data/note-identity"
import { useApplyOps } from "../data/store"
import { dateMentionsAtom, graphSnapshotAtom, notesAtom } from "../global-state"
import type { NoteId } from "../schema"

const EMPTY_MENTIONS: NoteId[] = []

const shallowEqualIds = (a: NoteId[], b: NoteId[]) => {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false
  }
  return true
}

export function useNoteById(id: NoteId | undefined) {
  const noteAtom = React.useMemo(
    () => selectAtom(notesAtom, (notes) => (id ? notes.get(id) : undefined)),
    [id],
  )
  const note = useAtomValue(noteAtom)
  return note
}

/** Get the notes referencing a date/week id (via date props), even if no
 * note exists for that id */
export function useDateMentions(id: NoteId | undefined) {
  const mentionsAtom = React.useMemo(
    () =>
      selectAtom(
        dateMentionsAtom,
        (index) => (id ? (index.get(id) ?? EMPTY_MENTIONS) : EMPTY_MENTIONS),
        shallowEqualIds,
      ),
    [id],
  )
  return useAtomValue(mentionsAtom)
}

/**
 * Set props on a note (pin, width, font, gist id…): the current props
 * with the patch applied — a `null` value removes the key — and
 * `updated_at` stamped, as one `setProps` op.
 */
export function useSetNoteProps() {
  const store = useStore()
  const apply = useApplyOps()
  return React.useCallback(
    (id: NoteId, patch: Record<string, unknown>) => {
      apply(notePropsOps(id, patch, store.get(graphSnapshotAtom)))
    },
    [store, apply],
  )
}

/**
 * Move a note within the manual order (`src/data/note-order.ts`): `noteId` is
 * the row that was dragged and `ids` the notes in the order they should now
 * sit — the list the sidebar drew, with that row at its new index.
 *
 * Costs one link row in the steady state; see `moveNoteOps`.
 */
export function useMoveNote() {
  const store = useStore()
  const apply = useApplyOps()
  return React.useCallback(
    (noteId: NoteId, ids: NoteId[]) => {
      apply(moveNoteOps(noteId, ids, store.get(graphSnapshotAtom)))
    },
    [store, apply],
  )
}

/**
 * Rename a note — which, since ids are minted and opaque
 * (docs/graph-storage.md), is simply **setting the note node's
 * text**. Nothing else moves: the id, the URL, every deep link and every
 * block row are untouched, and exactly one row changes, so a rename cannot
 * clobber a concurrent edit under per-row LWW. An emptied title puts the
 * note back to untitled (its text is its id), so it falls back to its content
 * preview like any untitled note. Returns whether anything changed.
 */
export function useRenameNote() {
  const store = useStore()
  const apply = useApplyOps()

  return React.useCallback(
    (params: { noteId: NoteId; newTitle: string }): boolean => {
      const { noteId, newTitle } = params
      if (!noteId) return false
      const snapshot = store.get(graphSnapshotAtom)
      const note = snapshot.nodes.get(noteId)
      if (!note || note.type !== NOTE_TYPE) return false

      const title = newTitle.trim()
      const current = emittedNoteTitle(noteId, note.text) ?? ""
      if (title === current) return false

      apply([
        { op: "setText", id: noteId, text: title || noteId },
        ...notePropsOps(noteId, {}, snapshot),
      ])
      return true
    },
    [store, apply],
  )
}

/**
 * Create a note: one node (its title, its props, `updated_at` stamped). The
 * blocks come with the first edit (`useNoteDoc`).
 */
export function useCreateNote() {
  const store = useStore()
  const apply = useApplyOps()
  return React.useCallback(
    (
      id: NoteId,
      { title = "", props = {} }: { title?: string; props?: Record<string, unknown> },
    ) => {
      if (store.get(graphSnapshotAtom).nodes.has(id)) return
      const op: Op = {
        op: "create",
        id,
        type: NOTE_TYPE,
        text: title.trim() || id,
        props: propsJson({ ...props, updated_at: new Date().toISOString() }),
      }
      apply([op])
    },
    [store, apply],
  )
}

/** Delete a note and everything only it held (`deleteNoteOps`). */
export function useDeleteNote() {
  const store = useStore()
  const apply = useApplyOps()

  return React.useCallback(
    (id: NoteId) => apply(deleteNoteOps(id, store.get(graphSnapshotAtom))),
    [store, apply],
  )
}
