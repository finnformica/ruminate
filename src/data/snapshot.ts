import { foldByStamp, type RuminateEvent, type StampedState } from "./events"

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
 * The store writes them (`sql-note-store.ts`); nothing in the app reads the
 * fold yet.
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
