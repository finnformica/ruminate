import { useCallback, useRef } from "react"
import { emptyHistory, record, redo, undo, type BlockOp } from "../../blocks/history"
import type { BlockDoc, ChangeHint } from "../../blocks/types"

/**
 * Wraps the block editor's `onChange` with a document-level undo/redo history.
 *
 * - `commit(current, next, op)` records `current` then applies `next`. The
 *   blocks `next` brings in that the graph does not know (`knownBlock`) are
 *   the step's creations, remembered with it.
 * - `undo()` / `redo()` restore a snapshot (and return it, or `null`). An undo
 *   hands the save the undone step's creations as `discard`, so taking back a
 *   duplicate or a paste deletes the copies rather than stranding them in
 *   the Unassigned basket (`ChangeHint`, `src/blocks/types.ts`).
 * - The history lives for the editor's lifetime (it resets only when the note
 *   changes and the editor remounts), so undo/redo keep working across saves.
 */
export function useBlockHistory(
  onChange: (doc: BlockDoc, hint?: ChangeHint) => void,
  knownBlock: (id: string) => boolean = () => false,
) {
  const historyRef = useRef(emptyHistory())

  const commit = useCallback(
    (current: BlockDoc, next: BlockDoc, op: BlockOp) => {
      const created = Object.keys(next.blocks).filter(
        (id) => !(id in current.blocks) && !knownBlock(id),
      )
      historyRef.current = record(historyRef.current, current, op, created)
      onChange(next)
    },
    [onChange, knownBlock],
  )

  const undoChange = useCallback(
    (current: BlockDoc): BlockDoc | null => {
      const result = undo(historyRef.current, current)
      if (!result) return null
      historyRef.current = result.history
      const discard = result.created.filter((id) => !(id in result.doc.blocks))
      onChange(result.doc, discard.length > 0 ? { discard } : undefined)
      return result.doc
    },
    [onChange],
  )

  const redoChange = useCallback(
    (current: BlockDoc): BlockDoc | null => {
      const result = redo(historyRef.current, current)
      if (!result) return null
      historyRef.current = result.history
      onChange(result.doc)
      return result.doc
    },
    [onChange],
  )

  return { commit, undo: undoChange, redo: redoChange }
}
