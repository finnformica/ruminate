import type { BlockDoc } from "./types"

/**
 * A local, in-memory undo/redo history for the block editor. It records
 * snapshots of the whole document, so a single Cmd-Z can undo a change that
 * spanned several blocks — something the browser's per-textarea native undo
 * can't do.
 *
 * Consecutive text edits to the *same* block coalesce into one undo step (so
 * typing a word isn't undone one keystroke at a time), while structural
 * changes — inserting, deleting, indenting, switching type — are always their
 * own step. The history is collapsed on save (see `emptyHistory`), so undo
 * never reaches behind a committed state.
 */

/** Describes the change being recorded, used to decide coalescing. */
export type BlockOp = { type: "text"; blockId: string } | { type: "structural" }

/** One step: the doc to restore, and the blocks the step being stepped over
 * brought into being (new to the graph, not merely linked in). Undoing that
 * step takes them back out for good — an undone creation is not an unlink
 * (`ChangeHint.discard`, types.ts). */
type HistoryEntry = {
  doc: BlockDoc
  created: string[]
}

export type History = {
  /** Steps to restore on undo, oldest first; the last is the most recent. */
  past: HistoryEntry[]
  /** Steps to restore on redo, oldest first. */
  future: HistoryEntry[]
  /** The last recorded op, for coalescing runs of edits to one block. */
  lastOp: BlockOp | null
}

/** How many undo steps to keep. */
const LIMIT = 200

export function emptyHistory(): History {
  return { past: [], future: [], lastOp: null }
}

/**
 * Record a change about to be applied. `current` is the document *before* the
 * change; `created` names the blocks the change brings into being. Returns
 * the new history (the caller then applies the next doc).
 */
export function record(
  history: History,
  current: BlockDoc,
  op: BlockOp,
  created: string[] = [],
): History {
  const coalesce =
    op.type === "text" && history.lastOp?.type === "text" && history.lastOp.blockId === op.blockId

  let past: HistoryEntry[]
  if (coalesce && history.past.length > 0) {
    // A coalesced edit keeps the snapshot taken at the start of the run, and
    // owns everything the run created.
    const last = history.past[history.past.length - 1]
    past = [
      ...history.past.slice(0, -1),
      created.length > 0 ? { ...last, created: [...last.created, ...created] } : last,
    ]
  } else {
    past = [...history.past, { doc: current, created }].slice(-LIMIT)
  }
  return {
    past,
    // Any fresh change invalidates the redo stack.
    future: [],
    lastOp: op,
  }
}

/**
 * Undo one step. `current` is the live document (pushed onto the redo stack).
 * Returns the doc to restore, the blocks the undone step had created (for the
 * save to discard rather than unlink), and the new history — or `null` if
 * there is nothing to undo.
 */
export function undo(
  history: History,
  current: BlockDoc,
): { history: History; doc: BlockDoc; created: string[] } | null {
  if (history.past.length === 0) return null
  const entry = history.past[history.past.length - 1]
  return {
    doc: entry.doc,
    created: entry.created,
    history: {
      past: history.past.slice(0, -1),
      // Redoing this step re-applies `current`, creating the same blocks again.
      future: [...history.future, { doc: current, created: entry.created }],
      lastOp: null,
    },
  }
}

/** Redo one step, the mirror of {@link undo}. */
export function redo(
  history: History,
  current: BlockDoc,
): { history: History; doc: BlockDoc } | null {
  if (history.future.length === 0) return null
  const entry = history.future[history.future.length - 1]
  return {
    doc: entry.doc,
    history: {
      past: [...history.past, { doc: current, created: entry.created }],
      future: history.future.slice(0, -1),
      lastOp: null,
    },
  }
}
