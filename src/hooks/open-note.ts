import { useNavigate, useRouter } from "@tanstack/react-router"
import { useStore } from "jotai"
import React from "react"
import { goTo, layoutFromSearch, layoutToSearch, withPane, type FocusFrame } from "../data/panes"
import { notesAtom } from "../global-state"
import type { NoteId } from "../schema"

/**
 * Open a note, or a block in one, in the pane with the keyboard while the
 * page is split (docs/split-view.md): pushed onto that pane's focus stack,
 * the other pane left as it is. Returns whether it did — false when the page
 * is not a split note page, and the caller goes on as it would.
 */
export function useOpenInPane() {
  const navigate = useNavigate()
  const router = useRouter()
  return React.useCallback(
    (noteId: NoteId, block?: string): boolean => {
      const page = router.state.matches.find((match) => match.routeId === "/_appRoot/views_/$")
      const pageNote = (page?.params as { _splat?: string } | undefined)?._splat
      if (!page || !pageNote) return false
      const layout = layoutFromSearch(pageNote, page.search as Record<string, unknown>)
      if (layout.panes.length < 2) return false
      const move = goTo(layout.panes[layout.active], { noteId, root: block ?? null }, null)
      if (!move) return true
      const { noteId: first, search } = layoutToSearch(withPane(layout, layout.active, move.pane))
      void navigate({
        to: "/views/$",
        params: { _splat: first },
        // Each frame's narrowing and folds travel with the layout.
        search: { query: undefined, ...search },
      })
      return true
    },
    [navigate, router],
  )
}

/**
 * Where a note opens: a board (docs/boards.md) on its board page, every
 * other note on its outline — focused on a block when one is given. The one
 * place that decides, so the sidebar, the Views page and the palette agree.
 * While the page is split, the note opens in the pane with the keyboard
 * (`useOpenInPane`).
 */
export function useOpenNote() {
  const navigate = useNavigate()
  const openInPane = useOpenInPane()
  const store = useStore()
  return React.useCallback(
    (noteId: NoteId, block?: string) => {
      if (store.get(notesAtom).get(noteId)?.type === "board") {
        return navigate({ to: "/boards/$", params: { _splat: noteId } })
      }
      if (openInPane(noteId, block)) return
      return navigate({
        to: "/views/$",
        params: { _splat: noteId },
        search: { query: undefined, block },
      })
    },
    [navigate, openInPane, store],
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
