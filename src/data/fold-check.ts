import type { LinkRow, NodeRow, ViewRow } from "../../worker/handlers/replica-payload"
import { linkEntityId, type Entity } from "./events"
import type { GraphSnapshot } from "./graph"

/**
 * The fold check (docs/event-only-sync.md, "The cache"): the client's tables
 * are a cache of the fold of its log. The runtime compares, as the app
 * would read each, the cache with the fold of the log, and the cache with
 * the replica's pulled rows, and lists where they differ, for Settings →
 * Storage. After a batch it reads only the entities the batch touched
 * (`foldOfLog`, `readOutEntities`, `NoteStore.getLiveRows`); the whole of
 * both is read only when asked (`requestFullFoldCheck`). A week of checks
 * with no difference is what lets the row pull go (ES-9).
 */

/** One side of the check: rows, as the app reads them. */
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
 * not read it, and the push moves it on the cache outside the runtime's
 * queue (`markEventsPushed`), before the log's copy of the replica's does.
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

/** What each side of a check is called in its lines. */
export type FoldCheckSides = readonly [first: string, second: string]

function compare<R extends object>(
  entity: Entity,
  first: ReadonlyMap<string, R>,
  second: ReadonlyMap<string, R>,
  skip: (entity: Entity, id: string) => boolean,
  sides: FoldCheckSides,
  out: Map<string, string>,
) {
  for (const id of new Set([...first.keys(), ...second.keys()])) {
    if (skip(entity, id)) continue
    const key = foldCheckKey(entity, id)
    const a = first.get(id)
    const b = second.get(id)
    if (!b) out.set(key, `${key}: only in ${sides[0]}`)
    else if (!a) out.set(key, `${key}: only in ${sides[1]}`)
    else {
      const fields = differingFields(a, b)
      if (fields.length > 0) out.set(key, `${key}: ${fields.join(", ")}`)
    }
  }
}

/**
 * Where two sides differ, one line per entity, by its key:
 * `block blk_1: text, updated_at`, or `link a|b|child: only in the cache`.
 * `skip` leaves out an entity the check cannot judge yet.
 */
export function foldDifferences(
  first: FoldCheckRows,
  second: FoldCheckRows,
  sides: FoldCheckSides,
  skip: (entity: Entity, id: string) => boolean = () => false,
): Map<string, string> {
  const out = new Map<string, string>()
  const byId = <R extends { id: string }>(rows: readonly R[]) =>
    new Map(rows.map((row) => [row.id, row]))
  const byLink = (rows: readonly LinkRow[]) =>
    new Map(rows.map((row) => [linkEntityId(row.source_id, row.destination_id, row.kind), row]))
  compare("block", byId(first.nodes), byId(second.nodes), skip, sides, out)
  compare("link", byLink(first.links), byLink(second.links), skip, sides, out)
  compare("view", byId(first.views), byId(second.views), skip, sides, out)
  return out
}
