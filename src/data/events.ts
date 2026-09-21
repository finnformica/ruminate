// SPIKE — the event log's vocabulary and its arithmetic (docs/event-sourcing.md).
//
// Pure, like `ops.ts` and `replica-payload.ts`: no SQL, no clock, no ids of its
// own making. The Worker imports it to validate and roll up what it appends
// (`worker/handlers/event-log.ts`); the client will import it to turn a batch
// of ops into the events it pushes. Same repo, same file, no drift.
//
// ## The model
//
// An **event** is one change to one entity. Three kinds of entity — a block
// (`nodes`), a link (`link`), a view (`views`) — and four things that can
// happen to any of them:
//
//   create   it comes into being, with every field it has
//   update   some of its fields change            (patch = only those fields)
//   delete   it is tombstoned                     (patch = nothing)
//   restore  it returns to a state it once had    (patch = the fields to set;
//            `ref_seq` = the moment being returned to) — and is live again
//
// Patches hold ABSOLUTE values, never relative diffs ("text is now X", not
// "insert X at 4"). That one decision is what makes the rest cheap: an event
// means the same thing wherever it is replayed, a run of events **rolls up**
// by keeping the last value of each field (`netChanges`), and a typing run
// coalesces to its final event without reading the ones it replaces
// (`coalesceTyping`).
//
// **Order is a link's, not a block's.** A block may sit under several parents
// (multi-homing, docs/graph-storage.md) and has a position under each, so
// position lives where it always has — `link.sort_key`. Reordering a block is
// therefore a `link` `update`, and moving it a `link` `delete` plus a `link`
// `create`. A block `update` is its type, its text, or its props.
//
// ## The fold
//
// State is a left fold of the log in `seq` order (`fold`). The projection
// tables hold that fold's current value and nothing more, which is the
// property the tests pin: fold(events) == rows. `stateAt` folds a prefix —
// time travel without touching production — and `planRestoreSubtree` turns
// the difference between then and now into `restore` events, so a restore is
// itself appended, never a rewind.
//
// The fold is TOTAL: it never throws on an event it cannot apply (an update
// to a block it has never seen), because a log is forever and a fold that can
// fail is a corpus that can become unreadable. It sets the event aside in
// `rejected` and carries on.

import type { LinkRow, NodeRow, ViewRow } from "../../worker/handlers/replica-payload"
import type { GraphSnapshot } from "./graph"
import type { Op } from "./ops"

/** The event schema version this build writes. Old events are never rewritten:
 * a reader upcasts them on the way in (`upcast`). */
export const EVENT_VERSION = 1

export type Entity = "block" | "link" | "view"
type Action = "create" | "update" | "delete" | "restore"

interface BlockFields {
  type: string
  text: string
  props: string | null
  /** Set at creation, never changed (migrations/0006). */
  notes_id: string | null
}

interface LinkFields {
  source_id: string
  destination_id: string
  kind: string
  sort_key: string
}

interface ViewFields {
  root_id: string
  filter: string | null
  sort: string | null
  pinned: boolean
  sort_key: string | null
}

type FieldsOf<E extends Entity> = E extends "block"
  ? BlockFields
  : E extends "link"
    ? LinkFields
    : ViewFields

/** What every event carries besides its change. */
interface EventEnvelope {
  /** Writer-minted, unique per tenant: the idempotency key. */
  id: string
  /** Assigned by the replica at append; absent on an event not yet pushed. */
  seq?: number
  /** Groups the events one gesture produced. */
  batch: string
  /** The tab, device or agent that wrote it. */
  device: string
  /** The command behind it (`backspaceEmpty`, `undo`, `mcp:append_block`). */
  cause?: string
  /** The entity's `seq` as the writer last saw it — what it believed it was
   * changing. Null for a create. Recorded, not enforced (see the doc). */
  base_seq?: number | null
  /** `restore` only: the `seq` whose state this returns to. */
  ref_seq?: number | null
  /** Writer's clock, ms. Informational — order is `seq`, never this. */
  at: number
  v: number
}

type EventOf<E extends Entity, A extends Action, P> = EventEnvelope & {
  entity: E
  entity_id: string
  action: A
  patch: P
}

/** A `create` holds every field. Only genesis (migrations-spike/events_genesis.sql) may add
 * `deleted_at`: a tombstoned row has a final state and no history. */
type CreatePatch<E extends Entity> = FieldsOf<E> & { deleted_at?: number | null }

type EventsFor<E extends Entity> =
  | EventOf<E, "create", CreatePatch<E>>
  | EventOf<E, "update", Partial<FieldsOf<E>>>
  | EventOf<E, "delete", Record<string, never>>
  | EventOf<E, "restore", Partial<FieldsOf<E>>>

type BlockEvent = EventsFor<"block">
type LinkEvent = EventsFor<"link">
export type ViewEvent = EventsFor<"view">
export type RuminateEvent = BlockEvent | LinkEvent | ViewEvent

/** A link's entity id: its primary key, readable in the D1 console. Block ids
 * are `blk_[0-9a-z]+` or `corpus_root` and kinds are words, so `|` is free. */
export const linkEntityId = (source: string, destination: string, kind = "child") =>
  `${source}|${destination}|${kind}`

// -----------------------------------------------------------------------------
// The fold: events → state
// -----------------------------------------------------------------------------

interface EntityState<F> {
  fields: F
  deleted: boolean
  /** `seq` of the event that created it, and of the last one applied. */
  created_seq: number
  seq: number
  /** Writer's clock of the last event applied — the projection's `updated_at`. */
  at: number
  /** When it was tombstoned (writer's clock); null while live. */
  deleted_at: number | null
}

interface Rejection {
  event: RuminateEvent
  reason: "update-on-missing" | "delete-on-missing" | "restore-on-missing"
}

export interface LogState {
  blocks: Map<string, EntityState<BlockFields>>
  links: Map<string, EntityState<LinkFields>>
  views: Map<string, EntityState<ViewFields>>
  /** Events the fold could not apply. Never thrown: a log is forever. */
  rejected: Rejection[]
}

const emptyLogState = (): LogState => ({
  blocks: new Map(),
  links: new Map(),
  views: new Map(),
  rejected: [],
})

const tableOf = (state: LogState, entity: Entity) =>
  (entity === "block"
    ? state.blocks
    : entity === "link"
      ? state.links
      : state.views) as unknown as Map<string, EntityState<Record<string, unknown>>>

/** Apply one event to `state`, IN PLACE (`fold` owns the state it builds). */
function applyEvent(state: LogState, raw: RuminateEvent): void {
  const event = upcast(raw)
  const table = tableOf(state, event.entity)
  const current = table.get(event.entity_id)
  const seq = event.seq ?? 0

  switch (event.action) {
    case "create": {
      const { deleted_at, ...fields } = event.patch as unknown as Record<string, unknown>
      const deletedAt = typeof deleted_at === "number" ? deleted_at : null
      // A create over a tombstone revives it: re-linking a pair that was once
      // unlinked is the same primary key, so it happens every time a block is
      // moved back. A create over a LIVE entity lands as an update — two
      // devices minting the same view, or a retry that lost its first half.
      table.set(event.entity_id, {
        fields: current ? { ...current.fields, ...fields } : fields,
        deleted: deletedAt !== null,
        created_seq: current?.created_seq ?? seq,
        seq,
        at: event.at,
        deleted_at: deletedAt,
      })
      return
    }
    case "update": {
      if (!current) return void state.rejected.push({ event, reason: "update-on-missing" })
      // An edit that raced a delete still lands, under the tombstone: a later
      // restore brings back the newest text, not the text as of the delete.
      table.set(event.entity_id, {
        ...current,
        fields: { ...current.fields, ...event.patch },
        seq,
        at: event.at,
      })
      return
    }
    case "delete": {
      if (!current) return void state.rejected.push({ event, reason: "delete-on-missing" })
      if (current.deleted) return
      table.set(event.entity_id, {
        ...current,
        deleted: true,
        deleted_at: event.at,
        seq,
        at: event.at,
      })
      return
    }
    case "restore": {
      if (!current) return void state.rejected.push({ event, reason: "restore-on-missing" })
      table.set(event.entity_id, {
        ...current,
        fields: { ...current.fields, ...event.patch },
        deleted: false,
        deleted_at: null,
        seq,
        at: event.at,
      })
      return
    }
  }
}

const bySeq = (a: RuminateEvent, b: RuminateEvent) => (a.seq ?? 0) - (b.seq ?? 0)

/** The state a log describes: a left fold, in `seq` order. */
export function fold(events: readonly RuminateEvent[], into: LogState = emptyLogState()): LogState {
  for (const event of [...events].sort(bySeq)) applyEvent(into, event)
  return into
}

/** The state as of `seq` (inclusive) — time travel, by folding a prefix. */
export function stateAt(events: readonly RuminateEvent[], seq: number): LogState {
  return fold(events.filter((event) => (event.seq ?? 0) <= seq))
}

/** One entity's events, oldest first — its version history. */
export function historyOf(
  events: readonly RuminateEvent[],
  entity: Entity,
  entityId: string,
): RuminateEvent[] {
  return events
    .filter((event) => event.entity === entity && event.entity_id === entityId)
    .sort(bySeq)
}

/**
 * Bring an old event up to `EVENT_VERSION`. Events are never rewritten in
 * place — the log is append-only — so every shape this app has ever written
 * must stay readable, and this is the one place that knows the old shapes.
 * Version 1 is the first, so today it is the identity; the next change to a
 * patch's fields adds a case here rather than a data migration.
 */
function upcast(event: RuminateEvent): RuminateEvent {
  return event
}

// -----------------------------------------------------------------------------
// The projection: state → rows
// -----------------------------------------------------------------------------

/** The rows a state projects to — what `nodes`, `link` and `views` hold. */
export function projectRows(state: LogState): {
  nodes: NodeRow[]
  links: LinkRow[]
  views: ViewRow[]
} {
  const stamp = <T extends object>(row: T, entity: EntityState<unknown>): T => ({
    ...row,
    updated_at: entity.at,
    seq: entity.seq,
    ...(entity.deleted ? { deleted_at: entity.deleted_at ?? entity.at } : {}),
  })
  const nodes: NodeRow[] = []
  for (const [id, block] of state.blocks) {
    const { notes_id, ...fields } = block.fields
    nodes.push(stamp({ id, ...fields, ...(notes_id ? { notes_id } : {}) } as NodeRow, block))
  }
  const links: LinkRow[] = []
  for (const link of state.links.values()) links.push(stamp({ ...link.fields } as LinkRow, link))
  const views: ViewRow[] = []
  for (const [id, view] of state.views) views.push(stamp({ id, ...view.fields } as ViewRow, view))
  return { nodes, links, views }
}

// -----------------------------------------------------------------------------
// Rolling up
// -----------------------------------------------------------------------------

/** The net effect of a run of events on one entity. */
export interface NetChange {
  entity: Entity
  entity_id: string
  /** Every field, when the run creates the entity (later updates folded in). */
  created: Record<string, unknown> | null
  /** The last value of each field the run set. */
  set: Record<string, unknown>
  /** true = ends deleted, false = ends live (created/restored), null = untouched. */
  deleted: boolean | null
  /** The last event of the run: whose `seq` the projection row takes. */
  last_event: string
  at: number
}

/**
 * Roll a run of events up to one net change per entity, in first-touched
 * order. Because patches are absolute, this is "last value of each field
 * wins" — no event is read twice and none needs the state it was written
 * against. It is what lets an append of any size project in a fixed number of
 * statements (`planEventAppend`).
 */
export function netChanges(events: readonly RuminateEvent[]): NetChange[] {
  const net = new Map<string, NetChange>()
  for (const event of events) {
    const key = `${event.entity}\x1f${event.entity_id}`
    let change = net.get(key)
    if (!change) {
      change = {
        entity: event.entity,
        entity_id: event.entity_id,
        created: null,
        set: {},
        deleted: null,
        last_event: event.id,
        at: event.at,
      }
      net.set(key, change)
    }
    change.last_event = event.id
    change.at = event.at
    if (event.action === "delete") {
      change.deleted = true
      continue
    }
    const { deleted_at, ...fields } = event.patch as Record<string, unknown>
    if (event.action === "create") change.created = { ...(change.created ?? {}), ...fields }
    else if (change.created) Object.assign(change.created, fields)
    Object.assign(change.set, fields)
    if (event.action === "create") change.deleted = typeof deleted_at === "number"
    if (event.action === "restore") change.deleted = false
  }
  return [...net.values()]
}

/**
 * Coalesce a typing run before it is pushed: consecutive text-only updates to
 * one block, from one device, each within `windowMs` of the last, become the
 * final one. A word is one event, not one per keystroke — without this the
 * log grows by a row every 150ms of typing (`OPS_FLUSH_MS`).
 *
 * The survivor keeps the FIRST event's `base_seq`: what the writer believed
 * it was changing when the run began. Any other event touching the block
 * ends the run, so a history never loses a structural step.
 */
export function coalesceTyping(
  events: readonly RuminateEvent[],
  windowMs = 30_000,
): RuminateEvent[] {
  const out: RuminateEvent[] = []
  /** Index in `out` of the open typing run per block. */
  const open = new Map<string, number>()
  const textOnly = (event: RuminateEvent) =>
    event.entity === "block" &&
    event.action === "update" &&
    Object.keys(event.patch).length === 1 &&
    "text" in event.patch

  for (const event of events) {
    if (event.entity !== "block") {
      out.push(event)
      continue
    }
    const at = open.get(event.entity_id)
    if (textOnly(event) && at !== undefined) {
      const previous = out[at]
      if (previous.device === event.device && event.at - previous.at <= windowMs) {
        out[at] = { ...event, base_seq: previous.base_seq }
        continue
      }
    }
    out.push(event)
    if (textOnly(event)) open.set(event.entity_id, out.length - 1)
    else open.delete(event.entity_id)
  }
  return out
}

// -----------------------------------------------------------------------------
// Ops → events (the client's write path)
// -----------------------------------------------------------------------------

export interface EventContext {
  batch: string
  device: string
  cause?: string
  at: number
  /** Mints an event id (`evt_…`). Injected: this module makes no ids. */
  mintId: () => string
}

const envelope = (ctx: EventContext, baseSeq: number | null = null): EventEnvelope => ({
  id: ctx.mintId(),
  batch: ctx.batch,
  device: ctx.device,
  ...(ctx.cause ? { cause: ctx.cause } : {}),
  base_seq: baseSeq,
  at: ctx.at,
  v: EVENT_VERSION,
})

/**
 * The events a batch of ops (`src/data/ops.ts`) amounts to, against the
 * snapshot it was planned on. The ops stay the editor's language; this is the
 * translation at the boundary, so nothing above `database-mode.ts` changes.
 *
 * Within the batch a block's `set*` ops fold into its `create` or into one
 * `update`, so one gesture yields at most one event per entity per action.
 */
export function opsToEvents(
  snapshot: GraphSnapshot,
  ops: readonly Op[],
  ctx: EventContext,
): RuminateEvent[] {
  const events: RuminateEvent[] = []
  /** The open create/update per block, to fold later `set*` ops into. */
  const openBlock = new Map<string, BlockEvent>()
  const liveLink = (source: string, destination: string) =>
    (snapshot.childLinks.get(source) ?? []).find((link) => link.destination_id === destination)
  const linked = new Set<string>()

  const setField = (id: string, patch: Partial<BlockFields>) => {
    const open = openBlock.get(id)
    if (open && (open.action === "create" || open.action === "update")) {
      Object.assign(open.patch, patch)
      return
    }
    const node = snapshot.nodes.get(id)
    if (!node) return
    const event: BlockEvent = {
      ...envelope(ctx, node.seq ?? null),
      entity: "block",
      entity_id: id,
      action: "update",
      patch,
    }
    openBlock.set(id, event)
    events.push(event)
  }

  for (const op of ops) {
    switch (op.op) {
      case "create": {
        const event: BlockEvent = {
          ...envelope(ctx),
          entity: "block",
          entity_id: op.id,
          action: "create",
          patch: { type: op.type, text: op.text, props: op.props, notes_id: op.notesId ?? null },
        }
        openBlock.set(op.id, event)
        events.push(event)
        break
      }
      case "setText":
        setField(op.id, { text: op.text })
        break
      case "setType":
        setField(op.id, { type: op.type })
        break
      case "setProps":
        setField(op.id, { props: op.props })
        break
      case "link": {
        const id = linkEntityId(op.source, op.destination)
        const existing = liveLink(op.source, op.destination)
        if (existing && existing.sort_key === op.sortKey) break
        const known = existing !== undefined || linked.has(id)
        linked.add(id)
        events.push(
          known
            ? {
                ...envelope(ctx, existing?.seq ?? null),
                entity: "link",
                entity_id: id,
                action: "update",
                patch: { sort_key: op.sortKey },
              }
            : {
                ...envelope(ctx),
                entity: "link",
                entity_id: id,
                action: "create",
                patch: {
                  source_id: op.source,
                  destination_id: op.destination,
                  kind: "child",
                  sort_key: op.sortKey,
                },
              },
        )
        break
      }
      case "unlink": {
        const existing = liveLink(op.source, op.destination)
        events.push({
          ...envelope(ctx, existing?.seq ?? null),
          entity: "link",
          entity_id: linkEntityId(op.source, op.destination),
          action: "delete",
          patch: {},
        })
        break
      }
      case "delete": {
        openBlock.delete(op.id)
        events.push({
          ...envelope(ctx, snapshot.nodes.get(op.id)?.seq ?? null),
          entity: "block",
          entity_id: op.id,
          action: "delete",
          patch: {},
        })
        break
      }
    }
  }
  return events
}

/** The event a change to a view row amounts to (views are written as rows,
 * not ops — `src/data/views.ts`). Null when nothing changed. */
export function viewChangeToEvent(
  before: ViewRow | undefined,
  after: ViewRow | undefined,
  ctx: EventContext,
): ViewEvent | null {
  const fieldsOf = (row: ViewRow): ViewFields => ({
    root_id: row.root_id,
    filter: row.filter,
    sort: row.sort,
    pinned: row.pinned,
    sort_key: row.sort_key,
  })
  const live = (row: ViewRow | undefined) => row !== undefined && row.deleted_at === undefined
  if (!live(before) && live(after)) {
    const row = after as ViewRow
    return before
      ? {
          ...envelope(ctx, before.seq ?? null),
          entity: "view",
          entity_id: row.id,
          action: "restore",
          patch: fieldsOf(row),
        }
      : {
          ...envelope(ctx),
          entity: "view",
          entity_id: row.id,
          action: "create",
          patch: fieldsOf(row),
        }
  }
  if (live(before) && !live(after)) {
    const row = before as ViewRow
    return {
      ...envelope(ctx, row.seq ?? null),
      entity: "view",
      entity_id: row.id,
      action: "delete",
      patch: {},
    }
  }
  if (!before || !after) return null
  const patch: Partial<ViewFields> = {}
  const was = fieldsOf(before)
  const now = fieldsOf(after)
  for (const key of Object.keys(now) as (keyof ViewFields)[]) {
    if (was[key] !== now[key]) Object.assign(patch, { [key]: now[key] })
  }
  if (Object.keys(patch).length === 0) return null
  return {
    ...envelope(ctx, before.seq ?? null),
    entity: "view",
    entity_id: after.id,
    action: "update",
    patch,
  }
}

// -----------------------------------------------------------------------------
// Restore
// -----------------------------------------------------------------------------

const differing = <F extends object>(then: F, now: F): Partial<F> => {
  const patch: Partial<F> = {}
  for (const key of Object.keys(then) as (keyof F)[]) {
    if (then[key] !== now[key]) patch[key] = then[key]
  }
  return patch
}

/**
 * The `restore` events that return one entity to its state as of `asOfSeq`.
 * Empty when it is already there; null when it did not exist then.
 *
 * A restore is an EVENT, appended like any other — never a rewind of the log.
 * So it is itself undoable, it replicates to every device by the ordinary
 * pull, and the history shows that it happened and what it returned to.
 */
export function planRestore(
  events: readonly RuminateEvent[],
  entity: Entity,
  entityId: string,
  asOfSeq: number,
  ctx: EventContext,
): RuminateEvent[] | null {
  const then = tableOf(stateAt(events, asOfSeq), entity).get(entityId)
  if (!then || then.deleted) return null
  const now = tableOf(fold(events), entity).get(entityId)
  if (!now) return null
  const patch = differing(then.fields, now.fields)
  if (!now.deleted && Object.keys(patch).length === 0) return []
  return [
    {
      ...envelope(ctx, now.seq),
      ref_seq: asOfSeq,
      entity,
      entity_id: entityId,
      action: "restore",
      patch,
    } as RuminateEvent,
  ]
}

/**
 * Return a block, everything beneath it, and its place under its parents to
 * the state of `asOfSeq` — "put this section back the way it was at 11:06".
 *
 * Walks the links that were live THEN, so blocks since unlinked or deleted
 * are found; restores each block and link that differs now. Links made since
 * are left alone: a restore brings things back, it does not take later work
 * away (the block may now also sit somewhere it did not before).
 */
export function planRestoreSubtree(
  events: readonly RuminateEvent[],
  blockId: string,
  asOfSeq: number,
  ctx: EventContext,
): RuminateEvent[] {
  const then = stateAt(events, asOfSeq)
  const childrenThen = new Map<string, EntityState<LinkFields>[]>()
  const parentsThen = new Map<string, EntityState<LinkFields>[]>()
  for (const link of then.links.values()) {
    if (link.deleted) continue
    const down = childrenThen.get(link.fields.source_id) ?? []
    down.push(link)
    childrenThen.set(link.fields.source_id, down)
    const up = parentsThen.get(link.fields.destination_id) ?? []
    up.push(link)
    parentsThen.set(link.fields.destination_id, up)
  }

  const out: RuminateEvent[] = []
  const restore = (entity: Entity, id: string) => {
    out.push(...(planRestore(events, entity, id, asOfSeq, ctx) ?? []))
  }
  const linkIdOf = (link: EntityState<LinkFields>) =>
    linkEntityId(link.fields.source_id, link.fields.destination_id, link.fields.kind)

  for (const link of parentsThen.get(blockId) ?? []) restore("link", linkIdOf(link))
  const seen = new Set<string>()
  const queue = [blockId]
  while (queue.length > 0) {
    const id = queue.shift() as string
    if (seen.has(id)) continue
    seen.add(id)
    restore("block", id)
    for (const link of childrenThen.get(id) ?? []) {
      restore("link", linkIdOf(link))
      queue.push(link.fields.destination_id)
    }
  }
  return out
}
