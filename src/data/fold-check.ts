import type { LinkRow, NodeRow, ViewRow } from "../../worker/handlers/replica-payload"
import { linkEntityId, type Entity } from "./events"
import type { GraphSnapshot } from "./graph"

/**
 * The fold check (docs/event-only-sync.md, item 7): the app reads the fold
 * of the log, and the tables are still written beside it. The runtime reads
 * both out as the app would read them and lists where they differ, for
 * Settings → Storage. After a batch it reads only the entities the batch
 * touched (`readOutEntities`, `NoteStore.getLiveRows`); the whole of both is
 * read only when asked (`requestFullFoldCheck`). A week of checks with no
 * difference is what lets the row pull go (ES-9).
 */

/** One side of the check: live rows, as the app reads them. */
export interface FoldCheckRows {
  nodes: readonly NodeRow[]
  links: readonly LinkRow[]
  views: readonly ViewRow[]
}

/** How many differences the check keeps to show. The count is still whole. */
export const FOLD_CHECK_SAMPLE = 20

/** The rows a whole read-out holds: its graph's nodes and child links, and
 * the live views. */
export function rowsOfGraph(graph: GraphSnapshot, views: readonly ViewRow[]): FoldCheckRows {
  return { nodes: [...graph.nodes.values()], links: [...graph.childLinks.values()].flat(), views }
}

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

/** The key of an entity in the check's result: `block blk_1`. */
export const foldCheckKey = (entity: Entity, id: string) => `${entity} ${id}`

function compare<R extends object>(
  entity: Entity,
  fold: ReadonlyMap<string, R>,
  tables: ReadonlyMap<string, R>,
  skip: (entity: Entity, id: string) => boolean,
  out: Map<string, string>,
) {
  for (const id of new Set([...fold.keys(), ...tables.keys()])) {
    if (skip(entity, id)) continue
    const key = foldCheckKey(entity, id)
    const a = fold.get(id)
    const b = tables.get(id)
    if (!b) out.set(key, `${key}: only in the fold`)
    else if (!a) out.set(key, `${key}: only in the tables`)
    else {
      const fields = differingFields(a, b)
      if (fields.length > 0) out.set(key, `${key}: ${fields.join(", ")}`)
    }
  }
}

/**
 * Where the fold and the tables differ, one line per entity, by its key:
 * `block blk_1: text, updated_at`, or `link a|b|child: only in the tables`.
 * `skip` leaves out an entity the check cannot judge yet: one the fold holds
 * past the rows the last pull brought.
 */
export function foldDifferences(
  fold: FoldCheckRows,
  tables: FoldCheckRows,
  skip: (entity: Entity, id: string) => boolean = () => false,
): Map<string, string> {
  const out = new Map<string, string>()
  const byId = <R extends { id: string }>(rows: readonly R[]) =>
    new Map(rows.map((row) => [row.id, row]))
  const byLink = (rows: readonly LinkRow[]) =>
    new Map(rows.map((row) => [linkEntityId(row.source_id, row.destination_id, row.kind), row]))
  compare("block", byId(fold.nodes), byId(tables.nodes), skip, out)
  compare("link", byLink(fold.links), byLink(tables.links), skip, out)
  compare("view", byId(fold.views), byId(tables.views), skip, out)
  return out
}
