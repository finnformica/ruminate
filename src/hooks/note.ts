import { useAtomValue, useStore } from "jotai"
import { selectAtom } from "jotai/utils"
import React from "react"
import { PAGE_TYPE, propsJson } from "../data/graph"
import { pagePropsOps } from "../data/note-meta"
import { deletePageOps, type Op } from "../data/ops"
import { emittedPageTitle } from "../data/page-identity"
import { useApplyOps } from "../data/store"
import { dateMentionsAtom, githubUserAtom, graphSnapshotAtom, notesAtom } from "../global-state"
import type { NoteId } from "../schema"
import { deleteGist } from "../utils/gist"

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
 * Set props on a page (pin, width, font, gist id, tags…): the current props
 * with the patch applied — a `null` value removes the key — and
 * `updated_at` stamped, as one `setProps` op.
 */
export function useSetPageProps() {
  const store = useStore()
  const apply = useApplyOps()
  return React.useCallback(
    (id: NoteId, patch: Record<string, unknown>) => {
      apply(pagePropsOps(id, patch, store.get(graphSnapshotAtom)))
    },
    [store, apply],
  )
}

/**
 * Rename a note — which, since ids are minted and opaque
 * (docs/page-identity-design.md), is simply **setting the page node's
 * text**. Nothing else moves: the id, the URL, every deep link and every
 * block row are untouched, and exactly one row changes, so a rename cannot
 * clobber a concurrent edit under per-row LWW. An emptied title puts the
 * page back to untitled (its text is its id), so it falls back to its content
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
      const page = snapshot.nodes.get(noteId)
      if (!page || page.type !== PAGE_TYPE) return false

      const title = newTitle.trim()
      const current = emittedPageTitle(noteId, page.text) ?? ""
      if (title === current) return false

      apply([
        { op: "setText", id: noteId, text: title || noteId },
        ...pagePropsOps(noteId, {}, snapshot),
      ])
      return true
    },
    [store, apply],
  )
}

/**
 * Create a page: one node (its title, its props, `updated_at` stamped). The
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
        type: PAGE_TYPE,
        text: title.trim() || id,
        props: propsJson({ ...props, updated_at: new Date().toISOString() }),
      }
      apply([op])
    },
    [store, apply],
  )
}

/** Delete a page and everything only it held (`deletePageOps`); a published
 * gist goes with it. */
export function useDeleteNote() {
  const store = useStore()
  const apply = useApplyOps()
  const githubUser = useAtomValue(githubUserAtom)

  return React.useCallback(
    async (id: NoteId) => {
      const note = store.get(notesAtom).get(id)
      if (typeof note?.props.gist_id === "string" && githubUser?.token) {
        await deleteGist({ githubToken: githubUser.token, gistId: note.props.gist_id })
      }
      apply(deletePageOps(id, store.get(graphSnapshotAtom)))
    },
    [store, apply, githubUser],
  )
}
