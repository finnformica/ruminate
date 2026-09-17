import React from "react"
import { useResultsDoc, type ResultRoot } from "../hooks/results-doc"
import type { NoteId } from "../schema"
import { BlockEditor } from "./block-editor/block-editor"

/**
 * **The results view: the block editor over a set of roots.**
 *
 * The notes list (every note as a root), a search's results (the matched
 * blocks as roots) and a filtered listing are one component, drawn by the
 * one editor — so the keys, the highlight, the folds and the styling are the
 * note page's, not a second set. What differs between the surfaces is the
 * header above (a search box, a note's title), never the rows.
 *
 * Read-only, the reader still browses (`BlockEditor.onActivate`): the
 * highlight moves, `space` / `→` / `←` fold and unfold, `f` focuses, and Enter
 * or a click opens the row — the note, or the note focused on the block.
 * Editable, the rows edit as they do in their notes and the change lands in
 * the graph (`useResultsDoc`); focusing opens the note instead, since a
 * results view has no focus view of its own. Either way the roots are the
 * view's (`fixedRoots`): nothing is added beside a root or taken from the
 * list here.
 */
export function ResultsEditor({
  roots,
  resetKey,
  readOnly = false,
  onOpen,
  focusFirstSignal,
  focusLastSignal,
  onExitTop,
  onExitBottom,
  initialSelection,
}: {
  /** Memoized by the caller (see `useResultsDoc`). */
  roots: readonly ResultRoot[]
  /** The query — changing it folds everything (see `useResultsDoc`). */
  resetKey: string
  /** Browse only: rows open rather than edit. */
  readOnly?: boolean
  /** Open a note — focused on a block, when one is given. */
  onOpen: (noteId: NoteId, blockId?: string) => void
  /** Bump to highlight the first row (↓ from the search box). */
  focusFirstSignal?: number
  /** Bump to highlight the last row (↑ from a list beneath this one). */
  focusLastSignal?: number
  /** ↑ past the first row hands focus back to the caller (the search box). */
  onExitTop?: () => void
  /** ↓ past the last row hands focus on (to a list beneath this one). */
  onExitBottom?: () => void
  /** The first row highlighted on mount (the page), or nothing until the
   * keyboard arrives (the palette's lists). */
  initialSelection?: "first" | "none"
}) {
  const { doc, collapsed, toggleCollapse, setDoc, noteOf } = useResultsDoc({ roots, resetKey })

  const open = React.useCallback(
    (id: string) => {
      const noteId = noteOf.get(id)
      if (noteId !== undefined) onOpen(noteId, id === noteId ? undefined : id)
    },
    [noteOf, onOpen],
  )
  // The focus root is controlled and never set: a results view has no focus
  // view of its own, so focusing on a row is opening it.
  const onFocusNavigate = React.useCallback(
    (id: string | null) => {
      if (id !== null) open(id)
    },
    [open],
  )

  if (doc.rootBlockIds.length === 0) return null
  return (
    <BlockEditor
      doc={doc}
      onChange={setDoc}
      readOnly={readOnly}
      onActivate={readOnly ? open : undefined}
      fixedRoots
      collapsed={collapsed}
      onToggleCollapse={toggleCollapse}
      focusRootId={null}
      onFocusNavigate={onFocusNavigate}
      focusFirstSignal={focusFirstSignal}
      focusLastSignal={focusLastSignal}
      onExitTop={onExitTop}
      onExitBottom={onExitBottom}
      initialSelection={initialSelection}
    />
  )
}
