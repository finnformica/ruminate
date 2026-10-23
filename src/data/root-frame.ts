import { CORPUS_ROOT_ID } from "./graph"
import type { FocusFrame } from "./panes"

/**
 * **The Root frame** (docs/graph-walk.md, section 2, decision 5): the frame
 * at the base of every pane's stack, rooted at the corpus root. It lists
 * every live note, so a note with no View is still one step from anywhere,
 * and Back and Shift+F come down to it.
 *
 * It is implicit: the URL does not write it (`layoutToSearch`) and a View
 * does not save it (`view-stack.ts`). Every reader puts it back at the base.
 */

/** What the Root frame is called: its crumb, its header and its sidebar
 * entry. Finn's choice was "Base" or "Root"; this is the one place to change. */
export const ROOT_LABEL = "Root"

/** The Root frame as a pane holds it. */
export const rootFrame = (): FocusFrame => ({ noteId: CORPUS_ROOT_ID, root: null, selected: null })

/** Is this frame the Root frame? */
export const isRootFrame = (frame: { noteId: string }): boolean => frame.noteId === CORPUS_ROOT_ID
