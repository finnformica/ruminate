import React from "react"
import useResizeObserver from "use-resize-observer"
import { imagePropsOf } from "../../blocks/image"
import { cx } from "../../utils/cx"
import { BoardPicture, type BoardImage } from "./board-picture"
import { columnCount, masonryColumns } from "./masonry"

/** A column is never narrower than this, and the wall never has fewer than
 * two — a phone's width gives two, a desktop's five or six. */
const MIN_COLUMN = 160
/** The one gap on the page: between tiles, between the buttons above the
 * wall, and between the buttons and the wall (`gap-2`). */
const GAP = 8

/**
 * The wall: the pictures as a masonry, each tile the shape of its picture
 * (`masonryColumns`), the columns as many as the width allows and laid out
 * again as it changes. A picture's shape is the size written on its block
 * when it went up (docs/images.md); one written without a size — pasted as
 * a link, say — is laid out square until its bytes arrive and say
 * otherwise. Click a tile to pick it.
 */
export function BoardWall({
  images,
  selectedId,
  onPick,
  label,
}: {
  images: BoardImage[]
  selectedId: string | null
  onPick: (id: string) => void
  label?: string
}) {
  const { ref, width = 0 } = useResizeObserver<HTMLDivElement>()
  // Shapes learnt from the bytes, for pictures whose block says nothing.
  const [learnt, setLearnt] = React.useState<ReadonlyMap<string, number>>(() => new Map())
  const learn = React.useCallback((id: string, ratio: number) => {
    setLearnt((prev) => (prev.get(id) === ratio ? prev : new Map(prev).set(id, ratio)))
  }, [])
  const ratioOf = React.useCallback(
    (image: BoardImage) => {
      const { width: w, height: h } = imagePropsOf(image)
      if (w && h) return w / h
      return learnt.get(image.id) ?? 1
    },
    [learnt],
  )
  const columns = columnCount(width, MIN_COLUMN, GAP)
  const stacks = React.useMemo(
    () => masonryColumns(images, columns, ratioOf),
    [images, columns, ratioOf],
  )

  return (
    <div
      ref={ref}
      data-testid="board-grid"
      role="list"
      aria-label={label}
      className="flex"
      style={{ gap: GAP }}
    >
      {stacks.map((stack, index) => (
        <div key={index} className="flex min-w-0 flex-1 flex-col" style={{ gap: GAP }}>
          {stack.map((image) => {
            const caption = image.text.trim()
            const ratio = ratioOf(image)
            return (
              <div key={image.id} role="listitem" className="min-w-0">
                <button
                  type="button"
                  aria-label={caption || "Picture"}
                  aria-pressed={image.id === selectedId}
                  onClick={() => onPick(image.id)}
                  style={{ aspectRatio: String(ratio) }}
                  className={cx(
                    "focus-ring group relative block w-full overflow-hidden rounded-lg bg-bg-secondary",
                    image.id === selectedId && "ring-2 ring-border-selected",
                  )}
                >
                  <BoardPicture
                    image={image}
                    fit="cover"
                    className="h-full w-full"
                    onSize={(w, h) => learn(image.id, w / h)}
                  />
                  {caption ? (
                    <span className="absolute inset-x-0 bottom-0 truncate bg-bg-overlay-backdrop px-2 py-1 text-left text-sm text-text">
                      {caption}
                    </span>
                  ) : null}
                </button>
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}
