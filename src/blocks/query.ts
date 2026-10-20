import type { Direction, ExpandedRule } from "./view"

/**
 * The query: the rule for the rows beneath a row (docs/graph-walk.md, 3.2).
 *
 * A view is a root and a query. The default query is down, so a view with
 * no pivots reads as a note reads today. A **pivot** is a query set on one
 * block: its rows walk up (what holds the block) or down (what the block
 * holds), and the rows beneath inherit that direction until another pivot.
 * A **fold** is the collapse query on one row. Pivots and folds belong to a
 * frame, so each pane and each frame in a pane's stack has its own.
 *
 * Pure: nothing here reads the graph. The walk (`walkGraph`,
 * src/data/graph.ts) asks `queryAt` at each row it reaches.
 */

/** The rule for the rows beneath a row. */
export type Query = { type: "links"; direction: Direction } | { type: "collapse" }

/** The link pivots of one frame: block id → the direction its rows walk.
 * Keyed by block id, as Pensive keys them: a pivot asks a question about a
 * block, and the answer is the same at each place the block shows. */
export type LinkPivots = ReadonlyMap<string, Direction>

/** Everything a walk reads to decide a row: the frame's link pivots, and
 * the fold rule (the reader's folds over the depth rule) for collapse. */
export interface WalkRule {
  pivots: LinkPivots
  expanded: ExpandedRule
}

/** One row as the rule sees it: its occurrence key, its block, its level
 * below the walk's root (or below the nearest pivot above it, `levelBeneath`)
 * and its stored type. */
export interface QueryRow {
  key: string
  id: string
  level: number
  type?: string
}

/**
 * The query beneath one row. In order:
 *
 * 1. The fold rule closes the row → collapse. A fold wins over a link pivot,
 *    as in Pensive. The pivot stays stored, and applies again when the row
 *    opens.
 * 2. The block has a link pivot → links in that direction.
 * 3. Else → links in `inherited`: the direction of the row above's query,
 *    or the frame's root query at the top (`rootDirection`).
 */
export function queryAt(rule: WalkRule, row: QueryRow, inherited: Direction): Query {
  if (!rule.expanded(row.key, row.level, row.type)) return { type: "collapse" }
  return { type: "links", direction: rule.pivots.get(row.id) ?? inherited }
}

/** The level of the rows beneath `row`. The depth count starts again at a
 * pivot: the rows beneath a pivot row are level 1, as a focused block's
 * children are, so a pivot opens as many levels as the depth rule allows,
 * whatever the depth of the row. */
export function levelBeneath(rule: WalkRule, row: QueryRow): number {
  return rule.pivots.has(row.id) ? 1 : row.level + 1
}

/** The root query's direction: the pivot on the frame's root id (the note id
 * or the focused block id), and down when there is none. */
export function rootDirection(pivots: LinkPivots, rootId: string): Direction {
  return pivots.get(rootId) ?? "down"
}
