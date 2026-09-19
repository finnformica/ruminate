import React from "react"

/**
 * **Drag to reorder a vertical list.**
 *
 * Built on the native drag events rather than a library: the sidebar's note
 * list is the only thing in the app that reorders by pointer, and a list of
 * rows dragged within one parent is the case HTML5 drag-and-drop actually
 * does well. There is nothing here to generalise to a second caller yet.
 *
 * The hook owns only what is being dragged and where it would land; the
 * caller keeps the list and is told the new order on drop. Nothing moves
 * until then, so an abandoned drag (Escape, a drop outside the list) leaves
 * the list exactly as it was.
 *
 * Reordering by pointer alone would be reachable by pointer alone, so the
 * caller pairs this with a keyboard path — the note row's actions menu moves
 * a note up and down (`NoteActionsMenu`).
 */

export interface DragReorder<T extends string> {
  /** The id being dragged, or null. */
  dragging: T | null
  /** Where the dragged row would land: the id it would sit above, or
   * `"end"` for past the last row. Null while nothing is over the list. */
  dropBefore: T | "end" | null
  /** Props for each row's element, in the order the caller drew them. */
  rowProps: (id: T) => {
    draggable: boolean
    onDragStart: (event: React.DragEvent) => void
    onDragOver: (event: React.DragEvent) => void
    onDragEnd: () => void
    onDrop: (event: React.DragEvent) => void
    "data-dragging"?: string
  }
  /** Props for the list element, so a drop past the last row still lands. */
  listProps: {
    onDragOver: (event: React.DragEvent) => void
    onDrop: (event: React.DragEvent) => void
  }
}

export function useDragReorder<T extends string>({
  ids,
  onMove,
  enabled = true,
}: {
  /** The list as drawn, in order. */
  ids: readonly T[]
  /** The dragged id, and the full list in its new order. */
  onMove: (id: T, next: T[]) => void
  enabled?: boolean
}): DragReorder<T> {
  const [dragging, setDragging] = React.useState<T | null>(null)
  const [dropBefore, setDropBefore] = React.useState<T | "end" | null>(null)

  // Read through a ref so the row handlers, memoised once, always see the
  // list as it is now rather than as it was when the drag started.
  const idsRef = React.useRef(ids)
  idsRef.current = ids

  const reset = React.useCallback(() => {
    setDragging(null)
    setDropBefore(null)
  }, [])

  const commit = React.useCallback(
    (before: T | "end" | null) => {
      const id = dragging
      reset()
      if (id === null || before === null || before === id) return
      const rest = idsRef.current.filter((other) => other !== id)
      const at = before === "end" ? rest.length : rest.indexOf(before)
      if (at === -1) return
      const next = [...rest.slice(0, at), id, ...rest.slice(at)]
      // A drop that changes nothing (onto the gap the row already fills) is
      // not a move: the ops layer would no-op anyway, but not asking keeps
      // the push queue clean.
      if (next.every((other, index) => other === idsRef.current[index])) return
      onMove(id, next)
    },
    [dragging, onMove, reset],
  )

  const rowProps = React.useCallback(
    (id: T) => ({
      draggable: enabled,
      onDragStart: (event: React.DragEvent) => {
        if (!enabled) return
        setDragging(id)
        event.dataTransfer.effectAllowed = "move"
        // Firefox starts no drag at all without data on the transfer. The
        // payload is never read back — the dragged id is state — so it is
        // the row's own id purely to put something there.
        event.dataTransfer.setData("text/plain", id)
      },
      onDragOver: (event: React.DragEvent) => {
        if (!enabled || dragging === null) return
        event.preventDefault()
        event.stopPropagation()
        event.dataTransfer.dropEffect = "move"
        // Past the halfway line the row would land *after* this one, which
        // is "before the next" — and before nothing at all at the end.
        const box = event.currentTarget.getBoundingClientRect()
        const after = event.clientY > box.top + box.height / 2
        if (!after) return setDropBefore(id)
        const at = idsRef.current.indexOf(id)
        setDropBefore(at === idsRef.current.length - 1 ? "end" : (idsRef.current[at + 1] ?? "end"))
      },
      onDragEnd: reset,
      onDrop: (event: React.DragEvent) => {
        if (!enabled || dragging === null) return
        event.preventDefault()
        event.stopPropagation()
        commit(dropBefore)
      },
      ...(dragging === id ? { "data-dragging": "" } : {}),
    }),
    [enabled, dragging, dropBefore, commit, reset],
  )

  const listProps = React.useMemo(
    () => ({
      onDragOver: (event: React.DragEvent) => {
        if (!enabled || dragging === null) return
        event.preventDefault()
        event.dataTransfer.dropEffect = "move"
      },
      onDrop: (event: React.DragEvent) => {
        if (!enabled || dragging === null) return
        event.preventDefault()
        commit(dropBefore)
      },
    }),
    [enabled, dragging, dropBefore, commit],
  )

  return { dragging: enabled ? dragging : null, dropBefore, rowProps, listProps }
}
