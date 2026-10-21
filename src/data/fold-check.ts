import type { LinkRow, NodeRow, ViewRow } from "../../worker/handlers/replica-payload"
import { linkEntityId, type Entity } from "./events"
import type { GraphSnapshot } from "./graph"

/**
 * The fold check (docs/event-only-sync.md, item 7): the app reads the fold
 * of the log, and the tables are still written beside it. After a batch the
 * runtime reads both out as the app would read them and lists where they
 * differ, for Settings → Storage. A week of checks with no difference is
 * what lets the row pull go (ES-9).
 */

/** One side of the check: the live graph and the live view rows. */
export interface FoldCheckSide {
  graph: GraphSnapshot
  views: readonly ViewRow[]
}

/** How many differences the check keeps to show. The count is still whole. */
export const FOLD_CHECK_SAMPLE = 20

/**
 * Every field the app reads is compared, so a new field is compared without
 * a change here. `seq` is not: it is the pull cursor's measure, the app does
 * not read it, and the push moves it on the tables outside the runtime's
 * queue (`markEventsPushed`), before the fold sees the event placed.
 */
const IGNORED = new Set(["seq"])

function differingFields(fold: object, tables: object): string[] {
  const a = fold as Record<string, unknown>
  const b = tables as Record<string, unknown>
  const out: string[] = []
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (IGNORED.has(key)) continue
    // A field a row leaves out reads as null (`notes_id`, `props`).
    if ((a[key] ?? null) !== (b[key] ?? null)) out.push(key)
  }
  return out
}

function compare<R extends object>(
  entity: Entity,
  fold: ReadonlyMap<string, R>,
  tables: ReadonlyMap<string, R>,
  skip: (entity: Entity, id: string) => boolean,
  out: string[],
) {
  for (const id of new Set([...fold.keys(), ...tables.keys()])) {
    if (skip(entity, id)) continue
    const a = fold.get(id)
    const b = tables.get(id)
    if (!b) out.push(`${entity} ${id}: only in the fold`)
    else if (!a) out.push(`${entity} ${id}: only in the tables`)
    else {
      const fields = differingFields(a, b)
      if (fields.length > 0) out.push(`${entity} ${id}: ${fields.join(", ")}`)
    }
  }
}

const linksOf = (graph: GraphSnapshot) => {
  const out = new Map<string, LinkRow>()
  for (const list of graph.childLinks.values()) {
    for (const link of list) {
      out.set(linkEntityId(link.source_id, link.destination_id, link.kind), link)
    }
  }
  return out
}

/**
 * Where the fold and the tables differ, one line per entity:
 * `block blk_1: text, updated_at`, or `link a|b|child: only in the tables`.
 * `skip` leaves out an entity the check cannot judge yet: one the fold holds
 * past the rows the last pull brought.
 */
export function foldDifferences(
  fold: FoldCheckSide,
  tables: FoldCheckSide,
  skip: (entity: Entity, id: string) => boolean = () => false,
): string[] {
  const out: string[] = []
  compare<NodeRow>("block", fold.graph.nodes, tables.graph.nodes, skip, out)
  compare<LinkRow>("link", linksOf(fold.graph), linksOf(tables.graph), skip, out)
  const views = (rows: readonly ViewRow[]) => new Map(rows.map((row) => [row.id, row]))
  compare<ViewRow>("view", views(fold.views), views(tables.views), skip, out)
  return out
}
