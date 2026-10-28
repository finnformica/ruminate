import { useNavigate, useRouter } from "@tanstack/react-router"
import { atom, useAtomValue, useStore } from "jotai"
import React from "react"
import { isBoard } from "../data/boards"
import type { GraphSnapshot } from "../data/graph"
import { layoutFromSearch, layoutToSearch, withPane, type FocusFrame } from "../data/panes"
import { rootFrame } from "../data/root-frame"
import { isTracker } from "../data/tracker"
import { restoreViewFrames } from "../data/view-stack"
import { viewByRootAtom } from "../data/views"
import { graphSnapshotAtom } from "../global-state"
import type { NoteId } from "../schema"

/**
 * Where the palette opens a note or a block (`useFocusBlock`): a board or a
 * tracker on its own page, every other note on its outline — focused on a
 * block when one is given.
 * A pick restarts the stack (docs/graph-walk.md, section 1): the pane shows
 * Root › the note or block, not the old frames with it pushed on top. While
 * the page is split, that is the stack of the pane with the keyboard
 * (`useOpenFramesInPane`).
 */
export function useOpenNote() {
  const navigate = useNavigate()
  const openFramesInPane = useOpenFramesInPane()
  const focusBlock = useFocusBlock()
  return React.useCallback(
    (noteId: NoteId, block?: string) => {
      focusBlock(block ?? noteId, () => {
        if (openFramesInPane([rootFrame(), { noteId, root: block ?? null, selected: null }])) return
        void navigate({
          to: "/views/$",
          params: { _splat: noteId },
          search: { query: undefined, block },
        })
      })
    },
    [navigate, openFramesInPane, focusBlock],
  )
}

/**
 * Where the palette opens a View row: its saved stack (`restoreViewFrames`,
 * docs/graph-walk.md section 7), as the sidebar's row does, in place of the
 * pane's stack. A View with no saved stack, a board or a tracker, or a row
 * that is not a View (a block revealed under a View's row) opens as
 * `useOpenNote` does.
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
        stack && kindPageOf(graph, rootId) === null
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

/** The page of its own that a block's kind opens on (block-kinds.tsx:
 * note, board, tracker): a board's (docs/boards.md) or a tracker's
 * (docs/trackers.md). Null for every other block, which focuses in the
 * outline. */
function kindPageOf(graph: GraphSnapshot, id: string): "/boards/$" | "/trackers/$" | null {
  if (isTracker(graph, id)) return "/trackers/$"
  if (isBoard(graph, id)) return "/boards/$"
  return null
}

/**
 * The one focus: every way to focus on a block calls it (F and ⌘., the
 * block menu, the phone edit bar, a crumb, the palette, a link). A board or
 * a tracker is never a focused frame: a focus on one opens its own page
 * (`kindPageOf`), as a new history entry, so Back returns to the view the
 * reader left. Any other block (or none) goes to `outline`, the caller's
 * own focus in the outline. `replace` puts the page in the place of the
 * history entry, for a link.
 */
export function useFocusBlock() {
  const navigate = useNavigate()
  const store = useStore()
  return React.useCallback(
    (id: string | null, outline: () => void, options: { replace?: boolean } = {}) => {
      const to = id === null ? null : kindPageOf(store.get(graphSnapshotAtom), id)
      if (to === null || id === null) return outline()
      void navigate({ to, params: { _splat: id }, ...(options.replace ? { replace: true } : {}) })
    },
    [navigate, store],
  )
}

/**
 * The note page's focus (`useFocusBlock`), and its link: a link to a board
 * or a tracker block (Copy link, an old URL) opens that page in the link's
 * place. In a split the pane keeps it, as those pages have no panes.
 */
export function useNotePageFocus(focusBlockId: string | null, split: boolean) {
  const focusBlock = useFocusBlock()
  const opensPage = useAtomValue(
    React.useMemo(
      () =>
        atom(
          (get) =>
            focusBlockId !== null && kindPageOf(get(graphSnapshotAtom), focusBlockId) !== null,
        ),
      [focusBlockId],
    ),
  )
  React.useEffect(() => {
    if (!opensPage || split) return
    focusBlock(focusBlockId, () => {}, { replace: true })
  }, [opensPage, focusBlockId, split, focusBlock])
  return focusBlock
}
