import type { Moves } from "../../blocks/commands"
import type { BlockType } from "../../blocks/types"

/**
 * The actions a block, or a selection of blocks, can take — **one set**,
 * built once by the editor and handed to every surface that offers them:
 * the block's right-click menu (`block-context-menu.tsx`), the bar over a
 * selection (`selection-bar.tsx`) and the keys. Each takes the rows it acts
 * on (`keys`: occurrence keys, `src/blocks/view.ts`), and runs the same
 * command over them (`src/blocks/commands.ts`); a single block is a list of
 * one. The surface decides which rows — the menu the row it was opened on,
 * or the selection that row is in; the bar the selection's roots — and the
 * action never knows which surface asked.
 */
export interface BlockActions {
  indent: (keys: string[]) => void
  outdent: (keys: string[]) => void
  moveUp: (keys: string[]) => void
  moveDown: (keys: string[]) => void
  /** Copies below the rows; the copies are the selection then. */
  duplicate: (keys: string[]) => void
  /** Every row's block becomes `type` outright (a menu's pick, not a
   * marker key's toggle). */
  turnInto: (keys: string[], type: BlockType) => void
  /** To the clipboard, as markdown and as rich text that pastes back exactly. */
  copy: (keys: string[]) => void
  cut: (keys: string[]) => void
  /** Remove the rows: the blocks stay where else they are held (a note's
   * outline), or go for good where a row's removal is the delete. */
  remove: (keys: string[]) => void
  /** Delete the rows' blocks from every place they appear. Absent where a
   * row's removal is already the delete. */
  deleteEverywhere?: (keys: string[]) => void
  /** Delete the rows' blocks and everything beneath them that nothing else
   * holds (the basket's). Absent where a delete never cascades. */
  deleteSubtree?: (keys: string[]) => void
  /** What the structure moves can do to the rows right now — what a surface
   * greys its items by. */
  moves: (keys: string[]) => Moves
}
