import type { LinkRow, NodeRow, ViewRow } from "../../worker/handlers/replica-payload"
import {
  foldByStamp,
  linkEntityId,
  rowsToEvents,
  type CurrentRows,
  type RuminateEvent,
  type StampedState,
} from "./events"

/**
 * Snapshots of the fold by stamp (docs/event-sourcing.md, Snapshots;
 * docs/event-only-sync.md, item 5). A snapshot is the state `foldByStamp`
 * holds — every field of every entity with its stamp, tombstones too — and
 * the **log position** it covers: the highest `events.position` folded into
 * it. Because the fold does not depend on order and an event applied twice
 * is applied once, a snapshot plus every event after its position is the
 * state, whatever else the tail holds.
 *
 * A snapshot is a cache of the log, not history: the log is never compacted,
 * and a snapshot that is lost or does not parse costs only a longer fold.
 * The store writes them (`sql-note-store.ts`); the runtime reads the newest
 * at boot (`loadFold`, `database-mode.ts`).
 *
 * **Snapshot 0** (docs/event-only-sync.md, item 6) is the one-time fold of
 * the store's tables into a snapshot (`snapshotZero`), so the fold holds
 * every row the tables hold, even one whose events this device never had.
 * The `meta` flag `SNAPSHOT_ZERO_KEY` says it has run: a snapshot from the
 * log may already exist, so "no snapshot" does not say it.
 */

/** Write a snapshot once the tail past the newest holds this many events. */
export const SNAPSHOT_EVERY_EVENTS = 1_000
/** Or once the newest is this old, and the tail holds anything. */
export const SNAPSHOT_EVERY_MS = 24 * 60 * 60 * 1_000
/** How many snapshots the store keeps: the new one and the one before it. */
export const SNAPSHOTS_KEPT = 2

/** The shape of the encoded state. A snapshot of another version does not
 * parse, and the boot folds from the one before it, or from the log. */
const SNAPSHOT_VERSION = 1

/** The `meta` key set once snapshot 0 has run, in the batch that writes it. */
export const SNAPSHOT_ZERO_KEY = "snapshot_zero"

/** A snapshot as the store holds it: the state still encoded. */
export interface StoredSnapshot {
  position: number
  taken_at: number
  state: string
}

/** Is a new snapshot due? `tail` is the count of events past the newest
 * snapshot's position, `takenAt` when it was written (0 with none). */
export function snapshotDue(tail: number, takenAt: number, now: number): boolean {
  return tail >= SNAPSHOT_EVERY_EVENTS || (tail > 0 && now - takenAt >= SNAPSHOT_EVERY_MS)
}

export function encodeSnapshot(state: StampedState): string {
  return JSON.stringify({
    v: SNAPSHOT_VERSION,
    blocks: [...state.blocks],
    links: [...state.links],
    views: [...state.views],
  })
}

type AnyEntity = StampedState["blocks"] extends Map<string, infer E> ? E : never

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x)

const isEntity = (x: unknown): x is AnyEntity =>
  isRecord(x) &&
  isRecord(x.fields) &&
  isRecord(x.stamps) &&
  Object.values(x.stamps).every((stamp) => typeof stamp === "string") &&
  typeof x.alive === "boolean" &&
  (x.deleted_at === null || typeof x.deleted_at === "number") &&
  typeof x.created === "boolean" &&
  typeof x.stamp === "string" &&
  typeof x.seq === "number" &&
  typeof x.at === "number"

function parseTable(raw: unknown): Map<string, AnyEntity> | null {
  if (!Array.isArray(raw)) return null
  const table = new Map<string, AnyEntity>()
  for (const entry of raw) {
    if (!Array.isArray(entry) || entry.length !== 2) return null
    const [id, entity] = entry as unknown[]
    if (typeof id !== "string" || !isEntity(entity)) return null
    table.set(id, entity)
  }
  return table
}

/** The state a snapshot holds, or null when it does not parse: bad JSON,
 * another version, or an entity of the wrong shape. */
export function parseSnapshot(text: string): StampedState | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(raw) || raw.v !== SNAPSHOT_VERSION) return null
  const blocks = parseTable(raw.blocks)
  const links = parseTable(raw.links)
  const views = parseTable(raw.views)
  if (!blocks || !links || !views) return null
  return { blocks, links, views } as unknown as StampedState
}

/**
 * The fold now: the newest snapshot that parses, then every event after its
 * position. When the newest does not parse, the one before it; with none
 * that parses, the whole log (`tailAfter(0)`). `snapshots` is newest first.
 * Returns the position the state starts from, as well.
 */
export async function foldFromSnapshots(
  snapshots: readonly StoredSnapshot[],
  tailAfter: (position: number) => Promise<RuminateEvent[]>,
): Promise<{ state: StampedState; from: number }> {
  for (const snapshot of snapshots) {
    const state = parseSnapshot(snapshot.state)
    if (state)
      return {
        state: foldByStamp(await tailAfter(snapshot.position), state),
        from: snapshot.position,
      }
  }
  return { state: foldByStamp(await tailAfter(0)), from: 0 }
}

/**
 * Snapshot 0: the fold of the store's rows, tombstones too. Each row is the
 * `create` it amounts to (`rowsToEvents` against no rows), with no stamp, the
 * row's `updated_at` as its `at` and the row's `seq`. So every field takes
 * the stamp `eventStamp` derives for an old event: the row's `updated_at`,
 * counter 0, `seq:<seq>`. That is the stamp the row's own last event derives
 * when it has none, so that event applied again changes nothing.
 */
export function snapshotZero(rows: {
  nodes: readonly NodeRow[]
  links: readonly LinkRow[]
  views: readonly ViewRow[]
}): StampedState {
  const seqs = new Map<string, number | undefined>([
    ...rows.nodes.map((row) => [`block:${row.id}`, row.seq] as const),
    ...rows.views.map((row) => [`view:${row.id}`, row.seq] as const),
    ...rows.links.map(
      (row) =>
        [`link:${linkEntityId(row.source_id, row.destination_id, row.kind)}`, row.seq] as const,
    ),
  ])
  const none: CurrentRows = { nodes: new Map(), links: new Map(), views: new Map() }
  const creates = rowsToEvents(none, rows, { batch: "snapshot_zero", device: "", now: 0 })
  return foldByStamp(
    creates.map((event) => {
      const seq = seqs.get(`${event.entity}:${event.entity_id}`)
      return seq === undefined ? event : { ...event, seq }
    }),
  )
}
