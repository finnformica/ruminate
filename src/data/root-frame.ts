import type { BlockDoc } from "../blocks/types"
import { idOfKey, walkDoc } from "../blocks/view"
import { CORPUS_ROOT_ID } from "./graph"
import type { FocusFrame } from "./panes"

/**
 * **The Root frame** (docs/graph-walk.md, section 2, decision 5): the frame
 * at the base of every pane's stack, rooted at the corpus root. It lists
 * every live note, so a note with no View is still one step from anywhere,
 * and Back and Shift+F come down to it.
 *
 * It is implicit: the URL does not write it (`layoutToSearch`). Every reader
 * puts it back at the base.
 *
 * It is drawn as any note is, by the note page's own editor: its doc is the
 * walk of the corpus root (`rootView`), whose rows are notes, and an edit
 * there is `rootToOps`.
 */

/** What the Root frame is called: its crumb, its header and its sidebar
 * entry. Finn's choice was "Base" or "Root", then "Notes"; this is the one
 * place to change. */
export const ROOT_LABEL = "Notes"

/** The Root frame as a pane holds it. */
export const rootFrame = (): FocusFrame => ({ noteId: CORPUS_ROOT_ID, root: null, selected: null })

/** Is this frame the Root frame? */
export const isRootFrame = (frame: { noteId: string }): boolean => frame.noteId === CORPUS_ROOT_ID

/** Root's icon, drawn by the one icon component a note and a board use
 * (`NoteFavicon`): the root is a node of its own type, with its own icon. */
export const ROOT_FAVICON = { id: CORPUS_ROOT_ID, type: "root" } as const

/** How deep Root opens until the reader sets a depth: its note rows only,
 * closed, so Root reads as the list of every note. */
export const ROOT_DEPTH = 1

/**
 * The note a row of the Root frame's doc sits in: the root row its key
 * starts from. Null when the doc does not draw the row. What a focus from
 * Root opens, since Root has no focus view of its own.
 */
export function rootHomeOf(doc: BlockDoc, id: string): string | null {
  let home: string | null = null
  walkDoc(doc, doc.rootBlockIds, ({ block, key }) => {
    if (home !== null) return false
    if (block.id === id) home = idOfKey(key.split("/")[0])
  })
  return home
}

/**
 * What a tap on a row does where the frame decides it (Settings → Editor):
 * on the Root frame (the notes page) `phone` opens the row on a touch
 * screen and edits it with a mouse, `always` opens it everywhere (a mouse's
 * click too), `never` edits it everywhere. Any row opens, a note or a
 * block at any depth below one. Opening is the focus path (`focusBlock`,
 * what F runs), so a board or a tracker opens its own page. In any other
 * frame (a note, or a block focused) a tap edits.
 */
export type RootTap = "phone" | "always" | "never"

export const ROOT_TAPS: readonly RootTap[] = ["phone", "always", "never"]

export const DEFAULT_ROOT_TAP: RootTap = "phone"

/** What a tap (or a click) on a row does: open it, or edit it in place. */
export type TapAction = "open" | "edit"

/**
 * The tap rule by the row's place in the graph: the frame decides, not the
 * row. A later setting can add more places than the Root frame here.
 */
export const tapAction = (
  frameIsRoot: boolean,
  coarsePointer: boolean,
  setting: RootTap,
): TapAction =>
  frameIsRoot && (setting === "always" || (setting === "phone" && coarsePointer)) ? "open" : "edit"
