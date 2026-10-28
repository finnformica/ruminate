// The per-key event log's vocabulary and its arithmetic (docs/event-sourcing.md,
// "Per-key events", migrations/0028).
//
// Pure, like `events.ts`: no SQL, no clock, no ids of its own making. The
// Worker imports it to validate, expand, collapse and roll up what it appends
// (`worker/handlers/event-log.ts`); the browser turns its ops into per-key
// events with the same vocabulary (`opsToKeyEvents`) and folds its own log
// with the same folds.
//
// ## The model
//
// A **key event** is one change to ONE KEY of one entity. The entity kinds
// are the old log's (`block`, `link`, `view`); the keys are the entity's
// REGISTERS: a block's `type`, `text` and `notes_id`, and one `props.<name>`
// per entry of its props; a link's `source_id`, `destination_id`, `kind` and
// `sort_key`; a view's `root_id`, `filter`, `sort`, `pinned`, `sort_key` and
// `stack`. Five things can happen:
//
//   create   the entity comes into being (key "", value = `deleted_at` or null)
//   set      one key takes a value                      (value = the value)
//   unset    one props key is gone                      (value = null)
//   delete   the entity is tombstoned                   (key "", value = `deleted_at` or null)
//   restore  the entity is live again                   (key "", `ref_seq` = the moment)
//
// A run of key events rolls up per (entity, key): the last value of each key
// wins, by `seq` in the fold by `seq` and by stamp in the fold by stamp. Two
// devices that change two keys of one block both keep their change — which a
// whole-`props` patch could not give (docs/event-sourcing.md, "Patches are
// absolute values").
//
// ## The two shapes
//
// Every old event has a per-key reading (`expandEvent`): its liveness row,
// one `set` per field it names, and — for a whole-`props` patch — one `set`
// per key whose value differs from the props before it, plus one `unset` per
// key that disappeared. The migration's backfill and the Worker's fill spell
// the same reading in SQL (`migrations/0028_events_log.sql`,
// `planLogFill`); a test pins the three together. The other way,
// `collapseKeyEvents` folds a batch of key events back into the old shape,
// so both logs are written on every push until the old one is retired.
//
// ## Validation
//
// The wire and the stores accept only what `keyEventSchema` accepts: one
// zod schema per action, one per entity's registers, and one per block
// type's known props keys (`BLOCK_PROP_SCHEMAS`), with every props key held
// to `KEY_PATTERN`. An invalid event is refused at write, in the browser
// and at the replica; on read a bad row is logged and skipped
// (`parseStoredKeyEvent`), never thrown over: a log is forever.

import { z } from "zod"
import type { ViewRow } from "../../worker/handlers/replica-payload"
import {
  EVENT_VERSION,
  eventStamp,
  linkEntityId,
  viewChangeToEvent,
  type Entity,
  type EventContext,
  type LogState,
  type RuminateEvent,
  type StampedEntity,
  type StampedState,
} from "./events"
import { CHILD_KIND, parseProps, type GraphSnapshot } from "./graph"
import { decodeHlc } from "./hlc"
import type { Op } from "./ops"
import { trackerSeriesKeys } from "./tracker"

/** The shape per-key events are written in; the old log writes `1`. */
export const KEY_EVENT_VERSION = 2

type KeyAction = "create" | "set" | "unset" | "delete" | "restore"

/** The register a props entry lives in: `props.<name>`. */
const PROPS_PREFIX = "props."

/**
 * What a props key may be: a word of letters, digits, `_`, `.`, `:` and `-`,
 * starting with a letter or `_`, at most 128 long. The same pattern is a
 * CHECK on `events_log.key` and `delta_mat_values.key` (migrations/0028), spelled
 * as two GLOBs there. Every key the app writes (docs/metadata.md, the figure
 * and link props) matches; an agent's key that does not is refused at write.
 */
export const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/

/** The registers of each entity that are columns of its row. A block's
 * other registers are its `props.*` keys. */
const COLUMN_REGISTERS: Record<Entity, readonly string[]> = {
  block: ["type", "text", "notes_id"],
  link: ["source_id", "destination_id", "kind", "sort_key"],
  view: ["root_id", "filter", "sort", "pinned", "sort_key", "stack"],
}

export const isPropsRegister = (key: string): boolean => key.startsWith(PROPS_PREFIX)
export const propsRegister = (name: string): string => PROPS_PREFIX + name
export const propNameOf = (register: string): string => register.slice(PROPS_PREFIX.length)

/** What every key event carries besides its change: the old envelope, plus
 * the old-shaped event it mirrors while both logs are written. */
export interface KeyEvent {
  /** Writer-minted, unique per tenant: the idempotency key. */
  id: string
  entity: Entity
  entity_id: string
  action: KeyAction
  /** A register name for `set` and `unset`; `""` for the liveness rows. */
  key: string
  /** The value set (JSON); null for an unset, and for a liveness row the
   * tombstone's stamp (`deleted_at`) or null. */
  value: unknown
  /** Assigned by the replica at append; absent on an event not yet pushed. */
  seq?: number
  batch: string
  device: string
  cause?: string
  base_seq?: number | null
  ref_seq?: number | null
  at: number
  tz?: number | null
  hlc?: string
  v: number
  /** The `events` row this mirrors (`events.id`), and its `seq` there — the
   * old log's order, which the row cursors still count in. */
  event?: string
  event_seq?: number
}

/** A key event as a device's log holds it once placed (`LoggedEvent`). */
export type LoggedKeyEvent = KeyEvent & {
  seq: number
  pending?: boolean
  origin?: string
  actor?: number
  received_at?: number
}

type PropsMap = Record<string, unknown>

/**
 * The stamp a key event resolves by: its own, or one derived as the old
 * event it mirrors derives it (`eventStamp`): from its `at` and the OLD
 * log's `seq`, so a backfilled row of an event from before stamps resolves
 * exactly as the event did.
 */
export function keyEventStamp(event: KeyEvent): string {
  if (event.hlc !== undefined) return event.hlc
  return eventStamp({ at: event.at, seq: event.event_seq ?? event.seq } as RuminateEvent)
}

// -----------------------------------------------------------------------------
// Props as keys
// -----------------------------------------------------------------------------

/** The live entries of a props object: a null value is no value, as the app
 * writes it (`notePropsOps`: a null removes the key). */
function liveEntries(props: PropsMap | null | undefined): PropsMap {
  const out: PropsMap = {}
  if (!props) return out
  for (const [key, value] of Object.entries(props)) {
    if (value !== null && value !== undefined) out[key] = value
  }
  return out
}

/** A props string as a map of its live entries, or null when it has none
 * (or is not JSON, which a bad row may be). */
const propsMapOf = (props: string | null | undefined): PropsMap | null => {
  if (props === null || props === undefined) return null
  const parsed = parseProps(props)
  return parsed === null ? null : liveEntries(parsed)
}

/** JSON with every object's keys sorted, at every depth: the one spelling of
 * a value, whatever order it was written in. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value as object).sort()
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as PropsMap)[key])}`)
      .join(",")}}`
  }
  return JSON.stringify(value) ?? "null"
}

/** Do two props strings say the same thing? The order of keys is not a
 * difference, and no live entry is the same as none. */
export function propsEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  return canonicalJson(propsMapOf(a) ?? {}) === canonicalJson(propsMapOf(b) ?? {})
}

/**
 * The `props` column a set of `props.*` registers projects to: the live
 * keys in sorted order as one JSON object, or null when there are none —
 * the same spelling on every device and at the replica.
 */
export function derivedProps(fields: Readonly<Record<string, unknown>>): string | null {
  const keys = Object.keys(fields)
    .filter((key) => isPropsRegister(key) && fields[key] !== null && fields[key] !== undefined)
    .sort()
  if (keys.length === 0) return null
  const out: PropsMap = {}
  for (const key of keys) out[propNameOf(key)] = fields[key]
  return JSON.stringify(out)
}

// -----------------------------------------------------------------------------
// Expanding an old event, collapsing key events
// -----------------------------------------------------------------------------

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/**
 * The per-key reading of one old event, against the props the entity held
 * before it (`prior`: a block's live entries, null for none): its liveness
 * row, a `set` per field named, and for a whole-`props` patch a `set` per key
 * whose value differs and an `unset` per key gone. Keys that do not match
 * `KEY_PATTERN` are left out, as the SQL backfill leaves them out. Rows are
 * numbered in the order the SQL numbers them (liveness, the columns in
 * `COLUMN_REGISTERS` order, props sets by key, props unsets by key), and
 * `idOf` names each by that number: `<event id>#<n>` by default.
 */
export function expandEvent(
  event: RuminateEvent,
  prior: PropsMap | null,
  idOf: (n: number) => string = (n) => `${event.id}#${n}`,
): KeyEvent[] {
  const out: KeyEvent[] = []
  const envelope = {
    batch: event.batch,
    device: event.device,
    ...(event.cause !== undefined ? { cause: event.cause } : {}),
    ...(event.base_seq !== undefined ? { base_seq: event.base_seq } : {}),
    // A restore names what it returns to, or says it cannot (null): a row
    // derived from a pushed row (`rowsToEvents`) has no moment to name.
    ...(event.ref_seq !== undefined
      ? { ref_seq: event.ref_seq }
      : event.action === "restore"
        ? { ref_seq: null }
        : {}),
    at: event.at,
    ...(event.tz !== undefined ? { tz: event.tz } : {}),
    ...(event.hlc !== undefined ? { hlc: event.hlc } : {}),
    v: KEY_EVENT_VERSION,
    event: event.id,
    ...(event.seq !== undefined ? { event_seq: event.seq } : {}),
  }
  const row = (action: KeyAction, key: string, value: unknown) =>
    out.push({
      ...envelope,
      id: idOf(out.length),
      entity: event.entity,
      entity_id: event.entity_id,
      action,
      key,
      value,
    })
  const { deleted_at, ...patch } = event.patch as Record<string, unknown>
  if (event.action !== "update") {
    row(event.action, "", typeof deleted_at === "number" ? deleted_at : null)
  }
  for (const name of COLUMN_REGISTERS[event.entity]) {
    if (patch[name] !== undefined) row("set", name, patch[name])
  }
  if (event.entity === "block" && patch.props !== undefined) {
    const before = liveEntries(prior)
    const after = liveEntries(propsMapOf(patch.props as string | null))
    const sets = Object.keys(after)
      .filter(
        (key) => KEY_PATTERN.test(key) && (!(key in before) || !sameJson(before[key], after[key])),
      )
      .sort()
    for (const key of sets) row("set", propsRegister(key), after[key])
    const unsets = Object.keys(before)
      .filter((key) => KEY_PATTERN.test(key) && !(key in after))
      .sort()
    for (const key of unsets) row("unset", propsRegister(key), null)
  }
  return out
}

/**
 * The per-key reading of a whole old log, in `seq` order, each event read
 * against the props the fold by `seq` held before it — what the migration's
 * backfill does in SQL. The props before an event are the last whole-`props`
 * patch the block's events named, as the backfill reads them with `LAG`.
 */
export function expandLog(events: readonly RuminateEvent[]): KeyEvent[] {
  const out: KeyEvent[] = []
  const prior = new Map<string, PropsMap | null>()
  const sorted = [...events].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
  for (const event of sorted) {
    out.push(...expandEvent(event, prior.get(event.entity_id) ?? null))
    if (event.entity === "block") {
      const props = (event.patch as { props?: string | null }).props
      if (props !== undefined) prior.set(event.entity_id, propsMapOf(props))
    }
  }
  return out
}

/** The old-shaped event of each group of a collapse (`collapseKeyEvents`). */
export interface Collapsed {
  events: RuminateEvent[]
  /** Each key event's id → the id of the old event it was folded into. */
  eventOf: Map<string, string>
}

const COLUMN_DEFAULTS: Record<Entity, Record<string, unknown>> = {
  block: { type: "text", text: "", notes_id: null },
  link: { source_id: "", destination_id: "", kind: CHILD_KIND, sort_key: "" },
  view: { root_id: "", filter: null, sort: null, pinned: false, sort_key: null },
}

/**
 * Fold a run of key events back into the old shape, one old event per
 * (batch, entity, action group): a `create` and the sets after it in the
 * same batch become one `create` with every field; sets and unsets with no
 * create become one `update`; a `delete` is a `delete`; a `restore` and its
 * sets a `restore`. A block's `props` is the props it held (`heldProps`: the
 * replica's row, or the fold's) with the group's sets and unsets applied,
 * so the old log reads exactly what the per-key log says. The old event
 * takes the id its rows name (`event`, when they were read out of one) or
 * the group's first id, so a re-sent push folds to the same ids.
 */
export function collapseKeyEvents(
  events: readonly KeyEvent[],
  heldProps: (entityId: string) => PropsMap | null,
): Collapsed {
  interface Group {
    first: KeyEvent
    kind: "create" | "update" | "delete" | "restore"
    columns: Record<string, unknown>
    sets: PropsMap
    unsets: Set<string>
    deleted_at: number | null
    /** The group's highest stamp; "" while no row of it carries one. */
    stamp: string
    ids: string[]
  }
  const groups: Group[] = []
  const open = new Map<string, Group>()
  const propsNow = new Map<string, PropsMap>()
  const eventOf = new Map<string, string>()

  const propsOf = (id: string) => {
    let props = propsNow.get(id)
    if (!props) {
      props = liveEntries(heldProps(id))
      propsNow.set(id, props)
    }
    return props
  }
  const groupKey = (event: KeyEvent) =>
    `${event.batch}\x1f${event.entity}\x1f${event.entity_id}\x1f${event.event ?? ""}`
  const start = (event: KeyEvent, kind: Group["kind"]): Group => {
    const group: Group = {
      first: event,
      kind,
      columns: {},
      sets: {},
      unsets: new Set(),
      deleted_at: typeof event.value === "number" ? event.value : null,
      stamp: "",
      ids: [],
    }
    groups.push(group)
    return group
  }
  for (const event of events) {
    const key = groupKey(event)
    let group: Group | undefined
    if (event.action === "create" || event.action === "restore" || event.action === "delete") {
      group = start(event, event.action)
      // A delete closes the entity's groups: a set after it in the same
      // batch is an edit under the tombstone, its own update.
      if (event.action === "delete") open.delete(key)
      else open.set(key, group)
    } else {
      group = open.get(key)
      if (!group) {
        group = start(event, "update")
        open.set(key, group)
      }
      if (isPropsRegister(event.key)) {
        const name = propNameOf(event.key)
        if (event.action === "set") {
          group.sets[name] = event.value
          group.unsets.delete(name)
        } else {
          group.unsets.add(name)
          delete group.sets[name]
        }
      } else {
        group.columns[event.key] = event.value
      }
    }
    group.ids.push(event.id)
    if (event.hlc !== undefined && event.hlc > group.stamp) group.stamp = event.hlc
  }

  const out: RuminateEvent[] = []
  for (const group of groups) {
    const { first } = group
    const oldId = first.event ?? first.id
    for (const id of group.ids) eventOf.set(id, oldId)
    const envelope = {
      id: oldId,
      batch: first.batch,
      device: first.device,
      ...(first.cause !== undefined ? { cause: first.cause } : {}),
      base_seq: first.base_seq ?? null,
      ...(group.kind === "restore" ? { ref_seq: first.ref_seq ?? null } : {}),
      at: first.at,
      ...(first.tz !== undefined ? { tz: first.tz } : {}),
      ...(group.stamp !== "" ? { hlc: group.stamp } : {}),
      v: EVENT_VERSION,
      entity: first.entity,
      entity_id: first.entity_id,
    }
    const touchesProps = Object.keys(group.sets).length > 0 || group.unsets.size > 0
    const nextProps = () => {
      const props = { ...propsOf(first.entity_id), ...group.sets }
      for (const name of group.unsets) delete props[name]
      propsNow.set(first.entity_id, props)
      const keys = Object.keys(props).sort()
      if (keys.length === 0) return null
      const sorted: PropsMap = {}
      for (const key of keys) sorted[key] = props[key]
      return JSON.stringify(sorted)
    }
    if (group.kind === "delete") {
      out.push({
        ...envelope,
        action: "delete",
        patch: group.deleted_at === null ? {} : { deleted_at: group.deleted_at },
      } as RuminateEvent)
      continue
    }
    const patch: Record<string, unknown> = {}
    if (group.kind === "create") {
      for (const name of COLUMN_REGISTERS[first.entity]) {
        if (name in group.columns) patch[name] = group.columns[name]
        else if (name in COLUMN_DEFAULTS[first.entity])
          patch[name] = COLUMN_DEFAULTS[first.entity][name]
      }
      if (first.entity === "block") patch.props = nextProps()
      if (group.deleted_at !== null) patch.deleted_at = group.deleted_at
    } else {
      Object.assign(patch, group.columns)
      if (touchesProps) patch.props = nextProps()
    }
    if (group.kind === "update" && Object.keys(patch).length === 0) continue
    out.push({ ...envelope, action: group.kind, patch } as RuminateEvent)
  }
  return { events: out, eventOf }
}

// -----------------------------------------------------------------------------
// The folds
// -----------------------------------------------------------------------------

interface KeyEntityState {
  fields: Record<string, unknown>
  deleted: boolean
  created_seq: number
  seq: number
  at: number
  deleted_at: number | null
}

type LinkFields = LogState["links"] extends Map<string, { fields: infer F }> ? F : never
type ViewFields = LogState["views"] extends Map<string, { fields: infer F }> ? F : never

export interface KeyLogState {
  blocks: Map<string, KeyEntityState>
  links: Map<string, KeyEntityState>
  views: Map<string, KeyEntityState>
  rejected: { event: KeyEvent; reason: string }[]
}

const tableOf = (state: KeyLogState, entity: Entity) =>
  entity === "block" ? state.blocks : entity === "link" ? state.links : state.views

const bySeq = (a: KeyEvent, b: KeyEvent) => (a.seq ?? 0) - (b.seq ?? 0)

/** The state a per-key log describes: a left fold in `seq` order, total as
 * `fold` is — an event on an entity it has never seen is set aside. */
export function foldKeys(
  events: readonly KeyEvent[],
  into: KeyLogState = { blocks: new Map(), links: new Map(), views: new Map(), rejected: [] },
): KeyLogState {
  for (const event of [...events].sort(bySeq)) {
    const table = tableOf(into, event.entity)
    const current = table.get(event.entity_id)
    // The state's `seq` is the old log's, as the rows hold it; this log's
    // own only orders the fold.
    const seq = event.event_seq ?? event.seq ?? 0
    if (event.action === "create") {
      const deletedAt = typeof event.value === "number" ? event.value : null
      table.set(event.entity_id, {
        fields: current ? { ...current.fields } : {},
        deleted: deletedAt !== null,
        created_seq: current?.created_seq ?? seq,
        seq,
        at: event.at,
        deleted_at: deletedAt,
      })
      continue
    }
    if (!current) {
      into.rejected.push({ event, reason: `${event.action}-on-missing` })
      continue
    }
    const next = { ...current, fields: { ...current.fields }, seq, at: event.at }
    switch (event.action) {
      case "set":
        next.fields[event.key] = event.value
        break
      case "unset":
        delete next.fields[event.key]
        break
      case "delete":
        next.deleted = true
        next.deleted_at = typeof event.value === "number" ? event.value : event.at
        break
      case "restore":
        next.deleted = false
        next.deleted_at = null
        break
    }
    table.set(event.entity_id, next)
  }
  return into
}

/** The per-key fold's state in the old fold's shape, props assembled, so
 * every reader of a `LogState` (`projectRows`, the calendar) reads it. */
export function assembleLogState(state: KeyLogState): LogState {
  const out: LogState = {
    blocks: new Map(),
    links: new Map(),
    views: new Map(),
    rejected: [],
  }
  for (const [id, block] of state.blocks) {
    const { fields } = block
    out.blocks.set(id, {
      ...block,
      fields: {
        type: String(fields.type ?? ""),
        text: String(fields.text ?? ""),
        props: derivedProps(fields),
        notes_id: (fields.notes_id as string | null | undefined) ?? null,
      },
    })
  }
  for (const [id, link] of state.links) {
    out.links.set(id, { ...link, fields: link.fields as unknown as LinkFields })
  }
  for (const [id, view] of state.views) {
    const { stack, ...fields } = view.fields
    out.views.set(id, {
      ...view,
      fields: {
        ...(fields as unknown as ViewFields),
        ...(stack === undefined ? {} : { stack: stack as string | null }),
      },
    })
  }
  return out
}

/** `stateAt` for key events: the fold of a prefix, by the OLD log's seq when
 * the events carry one (`event_seq`), else their own. */
export function keyStateAt(events: readonly KeyEvent[], seq: number): KeyLogState {
  return foldKeys(events.filter((event) => (event.event_seq ?? event.seq ?? 0) <= seq))
}

type AnyStamped = StampedEntity<Record<string, unknown>>

const stampedTableOf = (state: StampedState, entity: Entity) =>
  (entity === "block"
    ? state.blocks
    : entity === "link"
      ? state.links
      : state.views) as unknown as Map<string, AnyStamped>

/**
 * The fold by stamp of per-key events (`foldByStamp`, per key): each
 * register — a column, a `props.<name>`, and `alive` — is a last-writer-wins
 * register on the stamp of the event that set it. An unset key keeps its
 * stamp with a null value, so a later-arriving older set loses to it. The
 * entities hold the registers as they are; `assembleStamped` gives the
 * state in the old shape, props assembled.
 */
export function foldKeysByStamp(
  events: readonly KeyEvent[],
  into: StampedState = { blocks: new Map(), links: new Map(), views: new Map() },
): StampedState {
  for (const event of events) {
    const table = stampedTableOf(into, event.entity)
    const stamp = keyEventStamp(event)
    const entity: AnyStamped = table.get(event.entity_id) ?? {
      fields: {},
      stamps: {},
      alive: false,
      deleted_at: null,
      created: false,
      stamp: "",
      seq: 0,
      at: 0,
    }
    if (event.action === "set" || event.action === "unset") {
      if (stamp > (entity.stamps[event.key] ?? "")) {
        entity.fields[event.key] = event.action === "set" ? event.value : null
        entity.stamps[event.key] = stamp
      }
    } else {
      const tombstone = typeof event.value === "number" ? event.value : null
      const alive = event.action === "restore" || (event.action === "create" && tombstone === null)
      if (stamp > (entity.stamps.alive ?? "")) {
        entity.alive = alive
        entity.stamps.alive = stamp
        entity.deleted_at = alive ? null : (tombstone ?? event.at)
      }
      if (event.action === "create") entity.created = true
    }
    if (stamp > entity.stamp) {
      entity.stamp = stamp
      entity.at = event.at
    }
    entity.seq = Math.max(entity.seq, event.event_seq ?? event.seq ?? 0)
    table.set(event.entity_id, entity)
  }
  return into
}

/** The highest stamp among an entity's `props.*` registers, or undefined
 * when it has none: what the `props` register's stamp reads as. */
export function propsStampOf(
  stamps: Readonly<Record<string, string | undefined>>,
): string | undefined {
  let top: string | undefined
  for (const [key, stamp] of Object.entries(stamps)) {
    if (isPropsRegister(key) && stamp !== undefined && (top === undefined || stamp > top))
      top = stamp
  }
  return top
}

/**
 * A per-key state in the old fold's shape: each block's `props.*` registers
 * become one `props` field (`derivedProps`) with the highest of their stamps,
 * so `readOutEntities`, `toGraphSnapshot` and `toViewRows` read it.
 */
export function assembleStamped(state: StampedState): StampedState {
  const blocks = new Map<string, AnyStamped>()
  for (const [id, block] of state.blocks as unknown as Map<string, AnyStamped>) {
    const fields: Record<string, unknown> = {}
    const stamps: Record<string, string> = {}
    for (const [key, value] of Object.entries(block.fields)) {
      if (!isPropsRegister(key)) fields[key] = value
    }
    for (const [key, stamp] of Object.entries(block.stamps)) {
      if (!isPropsRegister(key) && stamp !== undefined) stamps[key] = stamp
    }
    // A block's `props` is a field of the old shape whatever it holds: null
    // for no keys, as a row reads it.
    fields.props = derivedProps(block.fields)
    const propsStamp = propsStampOf(block.stamps)
    if (propsStamp !== undefined) stamps.props = propsStamp
    blocks.set(id, { ...block, fields, stamps })
  }
  return { ...state, blocks: blocks as unknown as StampedState["blocks"] }
}

// -----------------------------------------------------------------------------
// Ops → key events (the client's write path)
// -----------------------------------------------------------------------------

/**
 * The key events a batch of ops amounts to, against the snapshot it was
 * planned on (`opsToEvents`, per key). A block's `set*` ops fold into the
 * rows of its open create or update: a later value replaces the row's, and
 * a `setProps` is read against the props the batch has built so far, so one
 * gesture yields at most one row per key per entity.
 */
export function opsToKeyEvents(
  snapshot: GraphSnapshot,
  ops: readonly Op[],
  ctx: EventContext,
): KeyEvent[] {
  const events: KeyEvent[] = []
  interface Open {
    rows: Map<string, KeyEvent>
    props: PropsMap
  }
  const openBlock = new Map<string, Open>()
  const liveLink = (source: string, destination: string) =>
    (snapshot.childLinks.get(source) ?? []).find((link) => link.destination_id === destination)
  const linked = new Set<string>()

  const envelope = (baseSeq: number | null = null) => ({
    id: ctx.mintId(),
    batch: ctx.batch,
    device: ctx.device,
    ...(ctx.cause ? { cause: ctx.cause } : {}),
    base_seq: baseSeq,
    at: ctx.at,
    ...(ctx.tz === undefined ? {} : { tz: ctx.tz }),
    ...(ctx.stamp ? { hlc: ctx.stamp() } : {}),
    v: KEY_EVENT_VERSION,
  })
  const row = (
    entity: Entity,
    id: string,
    action: KeyAction,
    key: string,
    value: unknown,
    baseSeq: number | null = null,
  ): KeyEvent => {
    const event: KeyEvent = { ...envelope(baseSeq), entity, entity_id: id, action, key, value }
    events.push(event)
    return event
  }
  const openFor = (id: string): Open | null => {
    const open = openBlock.get(id)
    if (open) return open
    const node = snapshot.nodes.get(id)
    if (!node) return null
    const made: Open = { rows: new Map(), props: liveEntries(propsMapOf(node.props)) }
    openBlock.set(id, made)
    return made
  }
  const setKey = (id: string, key: string, action: "set" | "unset", value: unknown) => {
    const open = openFor(id)
    if (!open) return
    const held = open.rows.get(key)
    if (held) {
      held.action = action
      held.value = value
      return
    }
    open.rows.set(key, row("block", id, action, key, value, snapshot.nodes.get(id)?.seq ?? null))
  }

  for (const op of ops) {
    switch (op.op) {
      case "create": {
        row("block", op.id, "create", "", null)
        const open: Open = { rows: new Map(), props: {} }
        openBlock.set(op.id, open)
        for (const [key, value] of [
          ["type", op.type],
          ["text", op.text],
          ["notes_id", op.notesId ?? null],
        ] as const) {
          open.rows.set(key, row("block", op.id, "set", key, value))
        }
        for (const [name, value] of Object.entries(liveEntries(propsMapOf(op.props)))) {
          if (!KEY_PATTERN.test(name)) continue
          open.props[name] = value
          open.rows.set(propsRegister(name), row("block", op.id, "set", propsRegister(name), value))
        }
        break
      }
      case "setText":
        setKey(op.id, "text", "set", op.text)
        break
      case "setType":
        setKey(op.id, "type", "set", op.type)
        break
      case "setProps": {
        const open = openFor(op.id)
        if (!open) break
        const after = liveEntries(propsMapOf(op.props))
        for (const [name, value] of Object.entries(after)) {
          if (!KEY_PATTERN.test(name)) continue
          if (name in open.props && sameJson(open.props[name], value)) continue
          setKey(op.id, propsRegister(name), "set", value)
        }
        for (const name of Object.keys(open.props)) {
          if (!(name in after) && KEY_PATTERN.test(name))
            setKey(op.id, propsRegister(name), "unset", null)
        }
        open.props = after
        break
      }
      case "link": {
        const id = linkEntityId(op.source, op.destination)
        const existing = liveLink(op.source, op.destination)
        if (existing && existing.sort_key === op.sortKey) break
        const known = existing !== undefined || linked.has(id)
        linked.add(id)
        if (known) {
          row("link", id, "set", "sort_key", op.sortKey, existing?.seq ?? null)
        } else {
          row("link", id, "create", "", null)
          row("link", id, "set", "source_id", op.source)
          row("link", id, "set", "destination_id", op.destination)
          row("link", id, "set", "kind", CHILD_KIND)
          row("link", id, "set", "sort_key", op.sortKey)
        }
        break
      }
      case "unlink": {
        const existing = liveLink(op.source, op.destination)
        if (!existing && !linked.has(linkEntityId(op.source, op.destination))) break
        row(
          "link",
          linkEntityId(op.source, op.destination),
          "delete",
          "",
          null,
          existing?.seq ?? null,
        )
        break
      }
      case "delete": {
        if (!snapshot.nodes.has(op.id) && !openBlock.has(op.id)) break
        openBlock.delete(op.id)
        row("block", op.id, "delete", "", null, snapshot.nodes.get(op.id)?.seq ?? null)
        break
      }
    }
  }
  return events
}

/** The key events a change to a view row amounts to (`viewChangeToEvent`,
 * expanded): none when nothing changed. */
export function viewChangeToKeyEvents(
  before: ViewRow | undefined,
  after: ViewRow | undefined,
  ctx: EventContext,
): KeyEvent[] {
  const event = viewChangeToEvent(before, after, ctx)
  if (event === null) return []
  const rows = expandEvent(event, null, () => ctx.mintId())
  for (const row of rows) delete row.event
  return rows
}

/**
 * Coalesce a typing run of key events (`coalesceTyping`): consecutive `set
 * text` rows on one block from one device, each within `windowMs` of the
 * last, become the final one, keeping the first's `base_seq`. Any other row
 * on the block ends the run.
 */
export function coalesceTypingKeys(events: readonly KeyEvent[], windowMs = 30_000): KeyEvent[] {
  const out: KeyEvent[] = []
  const open = new Map<string, number>()
  const typing = (event: KeyEvent) =>
    event.entity === "block" && event.action === "set" && event.key === "text"
  for (const event of events) {
    if (event.entity !== "block") {
      out.push(event)
      continue
    }
    const at = open.get(event.entity_id)
    if (typing(event) && at !== undefined) {
      const previous = out[at]
      if (previous.device === event.device && event.at - previous.at <= windowMs) {
        out[at] = { ...event, base_seq: previous.base_seq }
        continue
      }
    }
    out.push(event)
    if (typing(event)) open.set(event.entity_id, out.length - 1)
    else open.delete(event.entity_id)
  }
  return out
}

// -----------------------------------------------------------------------------
// Validation: the schemas
// -----------------------------------------------------------------------------

const MAX_ID_LENGTH = 64
const MAX_LABEL_LENGTH = 128
const MAX_TZ_MINUTES = 15 * 60
const MAX_HLC_LENGTH = 96

const nullableString = z.string().nullable()
const nullableInteger = z.int().nullable()

/** The known props keys of each block type, each with the shape the app
 * writes it in (`src/blocks/figure.ts`, `image.ts`, `link.ts`, the note's
 * metadata in docs/metadata.md, a tracker's series in
 * `src/data/tracker.ts`). Other keys are allowed with any JSON value, held
 * to `KEY_PATTERN`. */
const BLOCK_PROP_SCHEMAS = {
  // A tracker's series is a text block (docs/trackers.md); its entries are
  // text, with no keys of their own.
  text: trackerSeriesKeys,
  note: z.object({
    title: z.string().optional(),
    font: z.string().optional(),
    width: z.union([z.string(), z.number()]).optional(),
    updated_at: z.string().optional(),
  }),
  board: z.object({ title: z.string().optional(), updated_at: z.string().optional() }),
  image: z.object({
    image: z.string().optional(),
    src: z.string().optional(),
    width: z.number().optional(),
    height: z.number().optional(),
    thumbhash: z.string().optional(),
    align: z.enum(["left", "right"]).optional(),
    size: z.number().optional(),
  }),
  link: z.object({
    url: z.string().optional(),
    description: z.string().optional(),
    image: z.string().optional(),
    favicon: z.string().optional(),
    site: z.string().optional(),
    align: z.enum(["left", "right"]).optional(),
    size: z.number().optional(),
  }),
  code: z.object({ language: z.string().optional() }),
} as const

/** Every known props key with the union of the shapes its types give it —
 * what a `set props.<key>` is held to, since a key event does not say its
 * block's type. */
const KNOWN_PROP_VALUES: Record<string, z.ZodType> = {}
for (const schema of Object.values(BLOCK_PROP_SCHEMAS)) {
  for (const [key, value] of Object.entries(schema.shape)) {
    const inner = (value as z.ZodOptional<z.ZodType>).unwrap()
    KNOWN_PROP_VALUES[key] =
      key in KNOWN_PROP_VALUES ? z.union([KNOWN_PROP_VALUES[key], inner]) : inner
  }
}

/** Is `props` a props object a block of `type` may carry? */
export function validateProps(
  type: string,
  props: PropsMap,
): { ok: true } | { ok: false; message: string } {
  for (const key of Object.keys(props)) {
    if (!KEY_PATTERN.test(key)) return { ok: false, message: `props key "${key}" is not a key` }
  }
  const schema = (BLOCK_PROP_SCHEMAS as Record<string, z.ZodObject<z.ZodRawShape>>)[type]
  if (!schema) return { ok: true }
  const result = schema.loose().safeParse(liveEntries(props))
  return result.success
    ? { ok: true }
    : { ok: false, message: result.error.issues.map((issue) => issue.message).join("; ") }
}

/** A JSON value: what a `value` column may hold. */
const jsonValue: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValue),
    z.record(z.string(), jsonValue),
  ]),
)

const COLUMN_VALUES: Record<Entity, Record<string, z.ZodType>> = {
  block: { type: z.string(), text: z.string(), notes_id: nullableString },
  link: {
    source_id: z.string(),
    destination_id: z.string(),
    kind: z.string(),
    sort_key: z.string(),
  },
  view: {
    root_id: z.string(),
    filter: nullableString,
    sort: nullableString,
    pinned: z.boolean(),
    sort_key: nullableString,
    stack: nullableString,
  },
}

const envelopeSchema = z.object({
  id: z.string().min(1).max(MAX_ID_LENGTH),
  entity: z.enum(["block", "link", "view"]),
  entity_id: z
    .string()
    .min(1)
    .max(MAX_LABEL_LENGTH * 3),
  batch: z.string().min(1).max(MAX_ID_LENGTH),
  device: z.string().min(1).max(MAX_ID_LENGTH),
  cause: z.string().min(1).max(MAX_LABEL_LENGTH).optional(),
  base_seq: nullableInteger.optional(),
  ref_seq: nullableInteger.optional(),
  at: z.number(),
  tz: z.number().int().min(-MAX_TZ_MINUTES).max(MAX_TZ_MINUTES).nullable().optional(),
  hlc: z
    .string()
    .min(1)
    .max(MAX_HLC_LENGTH)
    .refine((hlc) => decodeHlc(hlc) !== null, "not a stamp")
    .optional(),
  v: z.literal(KEY_EVENT_VERSION),
  event: z
    .string()
    .min(1)
    .max(MAX_ID_LENGTH * 2)
    .optional(),
  event_seq: z.int().optional(),
})

const liveness = { key: z.literal(""), value: z.int().nullable() }

/** The schema of one key event: the envelope, and by action what key and
 * value it may carry, the value held to the register's shape. */
const keyEventSchema = envelopeSchema
  .and(
    z.discriminatedUnion("action", [
      z.object({ action: z.literal("create"), ...liveness }),
      z.object({ action: z.literal("delete"), ...liveness }),
      z.object({ action: z.literal("restore"), key: z.literal(""), value: z.null() }),
      z.object({
        action: z.literal("set"),
        key: z
          .string()
          .min(1)
          .max(MAX_LABEL_LENGTH + PROPS_PREFIX.length),
        value: jsonValue,
      }),
      z.object({
        action: z.literal("unset"),
        key: z
          .string()
          .min(1)
          .max(MAX_LABEL_LENGTH + PROPS_PREFIX.length),
        value: z.null(),
      }),
    ]),
  )
  .superRefine((event, ctx) => {
    if (event.action === "restore" && event.ref_seq === undefined) {
      ctx.addIssue({ code: "custom", message: "a restore names what it returns to" })
    }
    if (event.entity === "link" && event.action === "set" && event.key !== "sort_key") {
      // A link's key is spelled by its create and never changes: its three
      // columns may be set only on the create, and must agree with its id.
      if (!["source_id", "destination_id", "kind"].includes(event.key)) {
        ctx.addIssue({ code: "custom", message: `a link has no key "${event.key}"` })
      }
    }
    if (event.action !== "set" && event.action !== "unset") return
    if (isPropsRegister(event.key)) {
      if (event.entity !== "block") {
        ctx.addIssue({ code: "custom", message: `a ${event.entity} has no props` })
        return
      }
      const name = propNameOf(event.key)
      if (!KEY_PATTERN.test(name)) {
        ctx.addIssue({ code: "custom", message: `"${name}" is not a props key` })
        return
      }
      if (event.action === "set") {
        if (event.value === null) {
          ctx.addIssue({ code: "custom", message: "a props key set to null is an unset" })
          return
        }
        const known = KNOWN_PROP_VALUES[name]
        if (known && !known.safeParse(event.value).success) {
          ctx.addIssue({ code: "custom", message: `props.${name} is not of its shape` })
        }
      }
      return
    }
    if (event.action === "unset") {
      ctx.addIssue({ code: "custom", message: "only a props key can be unset" })
      return
    }
    const shape = COLUMN_VALUES[event.entity][event.key]
    if (!shape) {
      ctx.addIssue({ code: "custom", message: `a ${event.entity} has no key "${event.key}"` })
      return
    }
    if (!shape.safeParse(event.value).success) {
      ctx.addIssue({ code: "custom", message: `${event.key} is not of its shape` })
    }
  })

/**
 * One key event as a client may push it, or null. Built from the parse, so
 * anything a client adds beyond the schema is dropped and `seq` stays the
 * replica's to assign.
 */
export function parseKeyEvent(raw: unknown): KeyEvent | null {
  const result = keyEventSchema.safeParse(raw)
  if (!result.success) return null
  const x = result.data
  const event: KeyEvent = {
    id: x.id,
    entity: x.entity,
    entity_id: x.entity_id,
    action: x.action,
    key: x.key,
    value: x.value,
    batch: x.batch,
    device: x.device,
    at: x.at,
    v: KEY_EVENT_VERSION,
  }
  if (x.cause !== undefined) event.cause = x.cause
  if (x.base_seq !== undefined) event.base_seq = x.base_seq
  if (x.ref_seq !== undefined) event.ref_seq = x.ref_seq
  if (x.tz !== undefined) event.tz = x.tz
  if (x.hlc !== undefined) event.hlc = x.hlc
  if (x.event !== undefined) event.event = x.event
  if (x.event_seq !== undefined) event.event_seq = x.event_seq
  return event
}

/** Why a key event is refused, for a message; null when it is not. */
export function keyEventProblem(raw: unknown): string | null {
  const result = keyEventSchema.safeParse(raw)
  if (result.success) return null
  const issue = result.error.issues[0]
  return issue ? `${issue.path.join(".") || "event"}: ${issue.message}` : "invalid event"
}

/** Body of a per-key `PUT /api/replica/events`. */
export interface KeyEventsPutPayload {
  events: KeyEvent[]
  cursor?: string
}

/** Body of a successful per-key `PUT /api/replica/events`: as
 * `EventsPutResult`, each `seqs` entry adding the old log's seq of the
 * event the key event mirrors — the order the row cursors count in. */
export interface KeyEventsPutResult {
  ok: true
  appended: number
  stale: number
  seqs: [id: string, seq: number, eventSeq: number | null][]
  cursor: string | null
}

/** The most key events one push may carry. */
export const MAX_KEY_EVENTS_PER_PUT = 2_000

/** The body of a per-key push, or null when any part of it is not what a
 * client of this build sends. All or nothing, as the old door is. */
export function parseKeyEventsPayload(body: unknown): KeyEventsPutPayload | null {
  if (typeof body !== "object" || body === null) return null
  const x = body as Record<string, unknown>
  if (!Array.isArray(x.events) || x.events.length > MAX_KEY_EVENTS_PER_PUT) return null
  if (!(x.cursor === undefined || typeof x.cursor === "string")) return null
  const events: KeyEvent[] = []
  for (const raw of x.events) {
    const event = parseKeyEvent(raw)
    if (event === null) return null
    events.push(event)
  }
  return x.cursor === undefined ? { events } : { events, cursor: x.cursor }
}

/** Is every event of a push in the per-key shape? A push is one shape or
 * the other, never both. */
export const isKeyEventsBody = (body: unknown): boolean =>
  typeof body === "object" &&
  body !== null &&
  Array.isArray((body as { events?: unknown }).events) &&
  ((body as { events: unknown[] }).events.length === 0 ||
    (body as { events: { v?: unknown }[] }).events.every((event) => event?.v === KEY_EVENT_VERSION))

/**
 * A stored row read back as a key event, or null — with the reason logged —
 * when the row is not one. A reader skips such a row and goes on: the log
 * is forever, and one bad row must not make it unreadable.
 */
export function parseStoredKeyEvent(
  raw: Record<string, unknown>,
  report: (message: string) => void = (message) =>
    console.error(`[ruminate] events_log: ${message}`),
): LoggedKeyEvent | null {
  let value: unknown
  try {
    value = typeof raw.value === "string" ? JSON.parse(raw.value) : null
  } catch {
    report(`row ${String(raw.id)} holds a value that is not JSON`)
    return null
  }
  const candidate = {
    id: raw.id,
    entity: raw.entity,
    entity_id: raw.entity_id,
    action: raw.action,
    key: raw.key,
    value,
    batch: raw.batch,
    device: raw.device,
    ...(raw.cause === null || raw.cause === undefined ? {} : { cause: raw.cause }),
    // Null is "the writer did not say" (`EventEnvelope.base_seq`), kept as
    // the old store read it back.
    base_seq: raw.base_seq === null || raw.base_seq === undefined ? null : Number(raw.base_seq),
    ...(raw.ref_seq !== null && raw.ref_seq !== undefined
      ? { ref_seq: Number(raw.ref_seq) }
      : raw.action === "restore"
        ? { ref_seq: null }
        : {}),
    at: Number(raw.at),
    ...(raw.tz === null || raw.tz === undefined ? {} : { tz: Number(raw.tz) }),
    ...(raw.hlc === null || raw.hlc === undefined ? {} : { hlc: String(raw.hlc) }),
    v: Number(raw.v),
    ...(raw.event_id === null || raw.event_id === undefined ? {} : { event: String(raw.event_id) }),
    ...(raw.event_seq === null || raw.event_seq === undefined
      ? {}
      : { event_seq: Number(raw.event_seq) }),
  }
  const problem = keyEventProblem(candidate)
  if (problem !== null) {
    report(`row ${String(raw.id)} skipped: ${problem}`)
    return null
  }
  const event = parseKeyEvent(candidate) as LoggedKeyEvent
  event.seq = raw.seq === null || raw.seq === undefined ? 0 : Number(raw.seq)
  if (raw.origin !== null && raw.origin !== undefined) event.origin = String(raw.origin)
  if (raw.actor !== null && raw.actor !== undefined) event.actor = Number(raw.actor)
  if (raw.received_at !== null && raw.received_at !== undefined) {
    event.received_at = Number(raw.received_at)
  }
  return event
}

// -----------------------------------------------------------------------------
// Rows the per-key fold projects to
// -----------------------------------------------------------------------------

/** One row of `delta_mat_values`: a block's key, its value (null = unset, the
 * tombstone of a key), and the stamp and place of the event that set it. */
export interface DeltaMatValueRow {
  block_id: string
  key: string
  value: string | null
  hlc: string
  seq?: number
  updated_at: number
}
