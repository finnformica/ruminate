import { BlockNoteEditor } from "./block-editor/block-note-editor"
import { Details } from "./details"
import { useBasketDoc } from "../hooks/note-doc"
import type { NoteId } from "../schema"

/**
 * The note's **Unassigned** basket (docs/graph-schema-v2.md, "Delete"):
 * beneath the outline, every block written in this note that nothing reaches
 * any more — a row removed from the outline (⌫, Cut, Unlink) with everything
 * beneath it, or what a deleted block held. Folded by default, and absent
 * while there is nothing in it.
 *
 * The rows are the editor's own: type in them, copy one and paste it onto a
 * block in the outline to link it back (which takes it out of the basket),
 * or remove it, which here is the delete for good (`rowRemoval`). Folds are
 * kept apart from the outline's, and the basket never feeds the outline in
 * the command palette.
 */
export function UnassignedBasket({ noteId }: { noteId: NoteId }) {
  const { doc, count, setDoc } = useBasketDoc(noteId)
  if (!doc || count === 0) return null
  return (
    <div data-testid="unassigned-basket" className="mt-8 print:hidden">
      <Details defaultOpen={false}>
        <Details.Summary>Unassigned ({count})</Details.Summary>
        <BlockNoteEditor
          key={`${noteId}:unassigned`}
          noteId={noteId}
          collapseKey={`${noteId}:unassigned`}
          doc={doc}
          onChange={setDoc}
          noteTitle="Unassigned"
          publishOutline={false}
          trailingBlank={false}
          rowRemoval="delete"
        />
      </Details>
    </div>
  )
}
