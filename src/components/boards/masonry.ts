/**
 * A wall laid out by the pictures' own shapes (docs/boards.md, "The page"):
 * `columns` stacks, each item dropped onto the shortest one so far, its
 * height counted in widths — a portrait picture is taller than a landscape
 * one at the same width — so the columns end close to level and the order
 * given is kept near enough that the first picture is top left and the
 * last is near the bottom. Pure, so the page can lay out as many columns as
 * its width allows and lay out again when that changes.
 */
export function masonryColumns<T>(
  items: readonly T[],
  columns: number,
  /** The item's width over its height; 1 for a square. */
  ratio: (item: T) => number,
): T[][] {
  const count = Math.max(1, Math.floor(columns))
  const stacks: T[][] = Array.from({ length: count }, () => [])
  const heights = new Array<number>(count).fill(0)
  for (const item of items) {
    let shortest = 0
    for (let i = 1; i < count; i++) if (heights[i] < heights[shortest]) shortest = i
    stacks[shortest].push(item)
    const r = ratio(item)
    heights[shortest] += r > 0 && Number.isFinite(r) ? 1 / r : 1
  }
  return stacks
}

/** How many columns a wall `width` wide can hold, columns no narrower
 * than `minColumn` with `gap` between them, between two and `max`. */
export function columnCount(width: number, minColumn: number, gap: number, max = 6): number {
  if (width <= 0) return 2
  return Math.max(2, Math.min(max, Math.floor((width + gap) / (minColumn + gap))))
}
