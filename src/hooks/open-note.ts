import { useNavigate, useRouter } from "@tanstack/react-router"
import { atom, useAtomValue, useStore } from "jotai"
import React from "react"
import { isBoard } from "../data/boards"
import { layoutFromSearch, layoutToSearch, withPane, type FocusFrame } from "../data/panes"
import { rootFrame } from "../data/root-frame"
import { restoreViewFrames } from "../data/view-stack"
import { viewByRootAtom } from "../data/views"
import { graphSnapshotAtom, notesAtom } from "../global-state"
import type { NoteId } from "../schema"

/**
 * Where the palette opens a note: a board (docs/boards.md) on its board
 * page, a tracker (docs/trackers.md) on its tracker page, every other note
 * on its outline — focused on a block when one is
 * given, unless that block is a board, which opens on its own board page.
 * A pick restarts the stack (docs/graph-walk.md, section 1): the pane shows
 * Root › the note or block, not the old frames with it pushed on top. While
 * the page is split, that is the stack of the pane with the keyboard
 * (`useOpenFramesInPane`).
 */
export function useOpenNote() {
  const navigate = useNavigate()
  const openFramesInPane = useOpenFramesInPane()
  const store = useStore()
  return React.useCallback(
    (noteId: NoteId, block?: string) => {
      if (block && isBoard(store.get(graphSnapshotAtom), block)) {
        return navigate({ to: "/boards/$", params: { _splat: block } })
      }
      const kind = store.get(notesAtom).get(noteId)?.type
      if (kind === "board") {
        return navigate({ to: "/boards/$", params: { _splat: noteId } })
      }
      if (kind === "tracker") {
        return navigate({ to: "/trackers/$", params: { _splat: noteId } })
      }
      if (openFramesInPane([rootFrame(), { noteId, root: block ?? null, selected: null }])) return
      return navigate({
        to: "/views/$",
        params: { _splat: noteId },
        search: { query: undefined, block },
      })
    },
    [navigate, openFramesInPane, store],
  )
}

/**
 * Where the palette opens a View row: its saved stack (`restoreViewFrames`,
 * docs/graph-walk.md section 7), as the sidebar's row does, in place of the
 * pane's stack. A View with no saved stack, a board, or a row that is not a
 * View (a block revealed under a View's row) opens as `useOpenNote` does.
 */
export function useOpenView() {
  const navigate = useNavigate()
  const openNote = useOpenNote()
  const openFramesInPane = useOpenFramesInPane()
  const store = useStore()
  return React.useCallback(
    (noteId: NoteId, block?: string) => {
      const rootId = block ?? noteId
      const graph = store.get(graphSnapshotAtom)
      const stack = store.get(viewByRootAtom).get(rootId)?.stack
      const frames =
        stack && !isBoard(graph, rootId)
          ? restoreViewFrames({ rootId, noteId, stack }, graph)
          : null
      if (!frames) return openNote(noteId, block)
      if (openFramesInPane(frames)) return
      const { noteId: first, search } = layoutToSearch({ panes: [{ frames }], active: 0 })
      return navigate({
        to: "/views/$",
        params: { _splat: first },
        search: { query: undefined, ...search },
      })
    },
    [navigate, openNote, openFramesInPane, store],
  )
}

/**
 * Open a whole stack (a View's, `restoreViewFrames`) in the pane with the
 * keyboard while the page is split: that pane's stack becomes the frames,
 * the other pane is left as it is. Returns whether it did — false when the
 * page is not a split note page, and the caller follows its link.
 */
export function useOpenFramesInPane() {
  const navigate = useNavigate()
  const router = useRouter()
  return React.useCallback(
    (frames: FocusFrame[]): boolean => {
      const page = router.state.matches.find((match) => match.routeId === "/_appRoot/views_/$")
      const pageNote = (page?.params as { _splat?: string } | undefined)?._splat
      if (!page || !pageNote) return false
      const layout = layoutFromSearch(pageNote, page.search as Record<string, unknown>)
      if (layout.panes.length < 2) return false
      const { noteId: first, search } = layoutToSearch(withPane(layout, layout.active, { frames }))
      void navigate({
        to: "/views/$",
        params: { _splat: first },
        search: { query: undefined, ...search },
      })
      return true
    },
    [navigate, router],
  )
}

/**
 * A board is never a focused frame (docs/boards.md): a focus on one opens
 * its board page instead, as a new history entry, so Back returns to the
 * view the reader left. The returned `opensBoard(id)` does that and says
 * whether it did, for the note page's focus moves (a key, the block menu,
 * a crumb) to try first. A link to a board block (Copy link, an old URL)
 * opens the board in the link's place; in a split the pane keeps it, as the
 * board page has no panes.
 */
export function useBoardFocus(focusBlockId: string | null, split: boolean) {
  const navigate = useNavigate()
  const store = useStore()
  const focusesBoard = useAtomValue(
    React.useMemo(
      () => atom((get) => focusBlockId !== null && isBoard(get(graphSnapshotAtom), focusBlockId)),
      [focusBlockId],
    ),
  )
  React.useEffect(() => {
    if (!focusesBoard || focusBlockId === null || split) return
    void navigate({ to: "/boards/$", params: { _splat: focusBlockId }, replace: true })
  }, [focusesBoard, focusBlockId, split, navigate])
  return React.useCallback(
    (id: string | null): boolean => {
      if (id === null || !isBoard(store.get(graphSnapshotAtom), id)) return false
      void navigate({ to: "/boards/$", params: { _splat: id } })
      return true
    },
    [navigate, store],
  )
}
