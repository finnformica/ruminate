import type React from "react"
import { useAtomValue } from "jotai"
import { useMemo } from "react"
import type { ReactNode } from "react"
import type { Block } from "../../blocks/types"
import type { Occurrence } from "../../blocks/view"
import { boardFeatures, boardImageIds } from "../../data/boards"
import type { GraphSnapshot } from "../../data/graph"
import { graphSnapshotAtom } from "../../global-state"
import { cx } from "../../utils/cx"
import { ExternalLinkIcon16 } from "../icons"
import { NoteFavicon } from "../note-favicon"
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
 * its icon, its name (the node's text — the row's content line, rendered
 * and never a textarea: a board is named on its own page), and beneath it
 * what the board holds, live (`boardCardLine`). **Open board** in the
 * card's corner opens the board's page, as **Open link** opens a link
 * block's page. Click anywhere else and the row is selected, as a link
 * card's surface selects its row; the frame (`figure-frame.tsx`) holds the
 * layout, so the card keeps to a side and takes a width as a link card
 * does. Listed — a search result, the Views page — a board is a note row
 * with the board's favicon, not this card (`block-kinds.tsx`).
 */
export function BoardCard({
  block,
  occurrence,
  api,
  title,
  pointer,
}: {
  block: Block
  occurrence: Occurrence
  api: BlockEditorApi
  /** The title line: the row's content line, rendered. */
  title: ReactNode
  /** The row's click and double-click, for the card's plain surface. */
  pointer: Pick<React.HTMLAttributes<HTMLElement>, "onClick" | "onDoubleClick">
}) {
  const snapshot = useAtomValue(graphSnapshotAtom)
  const line = useMemo(() => boardCardLine(snapshot, block.id), [snapshot, block.id])
  const editable = !api.readOnly

  // The card's own surface takes the row's click; its tools keep theirs.
  const plain = (event: React.MouseEvent<HTMLElement>) =>
    !(event.target as Element).closest("a, button")
  const surface = {
    onClick: (event: React.MouseEvent<HTMLElement>) => plain(event) && pointer.onClick?.(event),
    onDoubleClick: (event: React.MouseEvent<HTMLElement>) =>
      plain(event) && pointer.onDoubleClick?.(event),
  }

  return (
    <FigureFrame
      block={block}
      occurrence={occurrence}
      api={api}
      noun="board"
      naturalWidth="100%"
      controls={editable}
      tools={
        api.openBoard ? (
          <FigureTool label="Open board" onClick={() => api.openBoard?.(block.id)}>
            <ExternalLinkIcon16 />
          </FigureTool>
        ) : null
      }
    >
      {() => (
        // eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events
        <div
          data-testid="board-card"
          className={cx(
            "flex w-full items-center gap-3 overflow-hidden rounded-lg border border-border-secondary bg-bg-card px-4 py-3",
            "transition-colors duration-150 hover:bg-bg-hover",
          )}
          {...surface}
        >
          <NoteFavicon note={{ id: block.id, type: "board" }} />
          <div className="flex min-w-0 flex-1 flex-col">
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
