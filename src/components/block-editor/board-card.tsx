import { useAtomValue } from "jotai"
import { useMemo } from "react"
import type { ReactNode } from "react"
import type { Block } from "../../blocks/types"
import type { Occurrence } from "../../blocks/view"
import { boardFeatures, boardImageIds } from "../../data/boards"
import type { GraphSnapshot } from "../../data/graph"
import { graphSnapshotAtom } from "../../global-state"
import { cx } from "../../utils/cx"
import { BoardIcon16 } from "../icons"
import type { BlockEditorApi } from "./block-item"
import { FigureFrame, FigureTool } from "./figure-frame"

/** How many features the card names before it counts the rest. */
const NAMED_FEATURES = 4

/**
 * What the card says beneath the board's name (docs/boards.md, "A board in
 * a note"): how many pictures it holds and what its features are, read off
 * the graph as it stands — "12 pictures · Location, Object, Material", or
 * "No pictures yet" while it is empty. Past four features the rest are
 * counted rather than named, so the line stays a line.
 */
export function boardCardLine(snapshot: GraphSnapshot, boardId: string): string {
  const pictures = boardImageIds(snapshot, boardId).length
  const count =
    pictures === 0 ? "No pictures yet" : pictures === 1 ? "1 picture" : `${pictures} pictures`
  const labels = boardFeatures(snapshot, boardId).map((state) => state.feature.label.trim() || "…")
  if (labels.length === 0) return count
  const named = labels.slice(0, NAMED_FEATURES).join(", ")
  const rest = labels.length - NAMED_FEATURES
  return `${count} · ${rest > 0 ? `${named} and ${rest} more` : named}`
}

/**
 * A board's card: how a board drawn as a row in an outline looks
 * (docs/boards.md, "A board in a note"). The row IS the board's own node,
 * linked under the block, so the card is the board as the graph has it:
 * its name (the node's text — the row's content line, rendered and never a
 * textarea: a board is named on its own page), and beneath it what the
 * board holds, live (`boardCardLine`). No icon: in an outline the card is
 * the board's mark, as a picture is an image row's, and the key slot before
 * it is a figure's empty one. **Open board** in the card's corner — the
 * board's own glyph, the one its page and its listed row carry — opens the
 * board's page, as **Open link** opens a link block's page. Click anywhere else and the row is selected, and a
 * double-click selects it too: the row's surface takes the pointer
 * (`block-item.tsx`), and the editor turns an edit of this row into a
 * selection. The card sits in the block frame every framed block shares
 * (`block-frame.tsx`: the inset is the card's spacing, the card has none
 * of its own) and the figure frame holds the layout (`figure-frame.tsx`),
 * so the card keeps to a side and takes a width as a link card does; its
 * surface is the link card's, class for class (`link-card.tsx`), as the
 * code panel's is its sibling (`code-panel.tsx`). Listed — a search
 * result, the Views page — a board is a note row with the board's favicon,
 * not this card (`block-kinds.tsx`).
 */
export function BoardCard({
  block,
  occurrence,
  api,
  title,
}: {
  block: Block
  occurrence: Occurrence
  api: BlockEditorApi
  /** The title line: the row's content line, rendered. */
  title: ReactNode
}) {
  const snapshot = useAtomValue(graphSnapshotAtom)
  const line = useMemo(() => boardCardLine(snapshot, block.id), [snapshot, block.id])

  return (
    <FigureFrame
      block={block}
      occurrence={occurrence}
      api={api}
      noun="board"
      naturalWidth="100%"
      controls={!api.readOnly}
      tools={
        api.openBoard ? (
          <FigureTool label="Open board" onClick={() => api.openBoard?.(block.id)}>
            <BoardIcon16 />
          </FigureTool>
        ) : null
      }
    >
      {() => (
        // The link card's surface, to the class: the same card, holding a
        // board rather than a page. Its ink is its own (`text-text`): a
        // selected row tints the text it inherits towards the accent
        // (`.block-highlight`, block-editor.css), and a card's title is a
        // name on a surface, not a line of the note, so it keeps its colour.
        <div
          data-testid="board-card"
          className={cx(
            "flex w-full overflow-hidden rounded-lg border border-border-secondary bg-bg-card text-text",
            "transition-colors duration-150 hover:bg-bg-hover",
          )}
        >
          <div className="flex min-w-0 flex-1 flex-col gap-1 px-4 py-3">
            <div data-block-body className="flex min-w-0">
              {title}
            </div>
            <div
              data-testid="board-card-line"
              className="truncate text-sm leading-normal text-text-secondary"
            >
              {line}
            </div>
          </div>
        </div>
      )}
    </FigureFrame>
  )
}
