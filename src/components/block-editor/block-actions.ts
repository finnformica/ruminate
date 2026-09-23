import type { Moves } from "../../blocks/commands"
import type { FigureAlign } from "../../blocks/figure"
import type { BlockType } from "../../blocks/types"

/**
 * The actions on blocks — **one set**, built once by the editor and handed
 * to every surface that offers any of them: the block's right-click menu
 * (`block-context-menu.tsx`), the bar over a selection (`selection-bar.tsx`),
 * the touch screen's edit bar (`mobile-edit-bar.tsx`) and the keys. Each
 * takes the rows it acts on (`keys`: occurrence keys, `src/blocks/view.ts`)
 * and runs the same command over them (`src/blocks/commands.ts`); a single
 * block is a list of one. The surface decides which rows — the menu the row
 * it was opened on, or the selection that row is in; the bar the selection;
 * the edit bar the row being edited — and the action never knows which
 * surface asked. A surface offers what it offers: the keymap binds the
 * actions that have a key, and one with no key is fine.
 *
 * The structural actions act on the rows' roots, so a selected subtree
 * moves as one. The actions that are one block's own affair — its link,
 * its picture, its card, sharing it — take the first of `keys`; the ones
 * that are independent per block (pin, download, refresh) take each.
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
  /** Focus on the row's block: it becomes the whole view. */
  focus: (keys: string[]) => void
  /** Inline markdown around the text selection of the row being edited
   * (nothing, on a row that is not). */
  bold: (keys: string[]) => void
  italic: (keys: string[]) => void
  strike: (keys: string[]) => void
  code: (keys: string[]) => void
  link: (keys: string[]) => void
  math: (keys: string[]) => void
  /** What the structure moves can do to the rows right now — what a surface
   * greys its items by. */
  moves: (keys: string[]) => Moves
  /** A link to the block, on the clipboard. Absent when the editor has no
   * note to link into (Storybook, tests). */
  copyLink?: (keys: string[]) => void
  /** Pin each block — or unpin it, when it is: a pinned block is listed in
   * the sidebar under Views and opens focused on. Absent where the rows
   * are not the user's own to pin. */
  pin?: (keys: string[]) => void
  /** Share the block — and everything beneath it — with someone
   * (docs/sharing.md). Absent where the rows are not the user's own. */
  share?: (keys: string[]) => void
  /** Open a link's card (`link-hover-card.tsx`) outright — a touch screen
   * has nothing to hover with. */
  editLink?: (keys: string[], href: string) => void
  /** Make a link block of one of the row's links (docs/links.md): "Turn
   * into link block", what the hover card's "Turn into block" does. */
  turnIntoLink?: (keys: string[], href: string, title: string) => void
  /** Image rows: expand the picture, and save each to the device. */
  openImage?: (keys: string[]) => void
  downloadImage?: (keys: string[]) => void
  /** Link rows (docs/links.md): open the page in a new tab, and fetch each
   * preview again (absent signed out, where there is nothing to fetch it
   * through). */
  openLink?: (keys: string[]) => void
  refreshPreview?: (keys: string[]) => void
  /** Link rows: back to a paragraph holding the link as text. */
  linkToInline?: (keys: string[]) => void
  /** Figure rows: which side of the row the picture or card keeps to. */
  alignFigure?: (keys: string[], align: FigureAlign) => void
  /** Figure rows: return a dragged figure to its natural width. */
  resetFigureSize?: (keys: string[]) => void
}
