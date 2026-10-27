import type { LinkRow, NodeRow, ViewRow } from "../../worker/handlers/replica-payload"
import { linkEntityId, type Entity } from "./events"
import { canonicalJson, propsEqual, type DeltaMatValueRow } from "./key-events"

/**
 * The fold check (docs/event-only-sync.md, "The cache"): the client's tables
 * are a cache of the fold of its log. In the background, after a batch, the
 * runtime compares, as the app would read each, the cache with the fold of
 * the log, and the cache with the replica's pulled rows. It reads only the
 * entities the batch touched (`foldOfLog`, `readOutEntities`,
 * `NoteStore.getLiveRows`), and reports where they differ with
 * `console.error`. A week with no difference lets the row pull go (ES-9).
 */

/** One side of the check: rows, as the app reads them. */
export interface FoldCheckRows {
  nodes: readonly NodeRow[]
  links: readonly LinkRow[]
  views: readonly ViewRow[]
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
    // A block's props are compared as a value: the two sides may spell the
    // same keys in different orders (docs/event-sourcing.md, "Per-key events").
    if (key === "props") {
      if (!propsEqual(a.props as string | null, b.props as string | null)) out.push(key)
      continue
    }
    // A field a row leaves out reads as null (`notes_id`, `props`).
    if ((a[key] ?? null) !== (b[key] ?? null)) out.push(key)
  }
  return out
}

/**
 * Where two sets of `delta_mat_values` rows differ, one line per (block, key):
 * `block blk_1 align: value`. A row's value is compared as JSON, its stamp
 * as is; `seq` and `updated_at` are not compared (`IGNORED`, and the
 * writer's clock). `skip` leaves out a block the check cannot judge yet.
 */
export function deltaMatValueDifferences(
  first: readonly DeltaMatValueRow[],
  second: readonly DeltaMatValueRow[],
  sides: FoldCheckSides,
  skip: (entity: Entity, id: string) => boolean = () => false,
): Map<string, string> {
  const out = new Map<string, string>()
  const keyOf = (row: DeltaMatValueRow) => `${row.block_id} ${row.key}`
  const byKey = (rows: readonly DeltaMatValueRow[]) => new Map(rows.map((row) => [keyOf(row), row]))
  const a = byKey(first)
  const b = byKey(second)
  const valueOf = (row: DeltaMatValueRow) =>
    row.value === null ? "" : canonicalJson(JSON.parse(row.value) as unknown)
  for (const key of new Set([...a.keys(), ...b.keys()])) {
    const row = a.get(key) ?? (b.get(key) as DeltaMatValueRow)
    if (skip("block", row.block_id)) continue
    const label = `block ${key}`
    const x = a.get(key)
    const y = b.get(key)
    if (!y) out.set(label, `${label}: only in ${sides[0]}`)
    else if (!x) out.set(label, `${label}: only in ${sides[1]}`)
    else {
      const fields: string[] = []
      if (valueOf(x) !== valueOf(y)) fields.push("value")
      if (x.hlc !== y.hlc) fields.push("hlc")
      if (fields.length > 0) out.set(label, `${label}: ${fields.join(", ")}`)
    }
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
