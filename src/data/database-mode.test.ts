import { getDefaultStore } from "jotai"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type {
  CachePageBody,
  CachePageCursor,
  LinkRow,
  NodeRow,
  ReplicaCorpusBody,
  ViewRow,
} from "../../worker/handlers/replica-payload"
import type { NoteId } from "../schema"
import { parse } from "../blocks/parse"
import { serialize } from "../blocks/serialize"
import { cacheRowOf, foldEventsToCache, type CacheRow } from "./cache-rows"
import { deleteBlockOps, deleteNoteOps, docToOps } from "./ops"
import {
  CACHE_GENERATION,
  EMPTY_GRAPH,
  databaseGraphAtom,
  databaseModeStatusAtom,
  databaseApplyOps,
  databaseEnsureAll,
  databaseEventLog,
  eventLogVersionAtom,
  flushDatabaseMode,
  isDatabaseModeActive,
  requestAmbientDatabasePull,
  requestDatabasePull,
  startDatabaseMode,
  stopDatabaseMode,
} from "./database-mode"
import type { D1NoteSource } from "./d1-note-source"
import { NOTE_TYPE, docToGraph, noteDoc, rollup } from "./graph"
import type { ReplicaSyncHandle } from "./replica-sync"
import { createNodeSqlDriver } from "./sql-node-test-driver"
import type { NoteStore } from "./note-store"
import { openSqlNoteStore } from "./sql-note-store"
import { applyOpsToStore } from "./store-test-support"
import { linkEntityId, rowsToEvents, type LoggedEvent } from "./events"
import type { KeyEvent, LoggedKeyEvent } from "./key-events"
import { keyed } from "./store-test-support"
import { decodeHlc } from "./hlc"
import { writerTimezone } from "./writer-identity"

/**
 * Boot-flow tests for database-authoritative mode, at the highest level the
 * node harness allows: a REAL NoteStore (node:sqlite, same migrations as
 * production), with only the network (the replica's cache and log) and the
 * push loop stubbed.
 */

function stubReplica(pending: NoteId[] = []) {
  const calls = { changes: [] as { noteIds: NoteId[] }[], stopped: false }
  const handle: ReplicaSyncHandle = {
    notifyChange: (noteIds) => calls.changes.push({ noteIds }),
    pendingNoteIds: () => new Set(pending),
    inFlightEventIds: () => new Set(),
    stop: () => {
      calls.stopped = true
    },
    flush: () => Promise.resolve(),
  }
  return { handle, calls }
}

/** The key of a cache row, for the snapshot's order and its cursor. */
const keyOf = (row: CacheRow): CachePageCursor => [row.entity, row.entity_id, row.key]
const compareKeys = (a: CachePageCursor, b: CachePageCursor) => {
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
  return 0
}

/**
 * The replica, as a device sees it: a log of old-shaped events, and the
 * cache of its fold (docs/events-log-cache.md) served page by page. Rows
 * given later (`add`) append the events they amount to, as the Worker's row
 * door does (`rowsToEvents`), so the log and the cache stay one thing.
 */
function stubSource(responses: {
  /** Rows the replica holds at the start, as a full pull once carried them. */
  rows?: ReplicaCorpusBody
  /** The tenant's log, given outright: everything past `since`, paged. */
  events?: LoggedEvent[]
  fail?: boolean
  replicaId?: string
}) {
  const calls = {
    cache: [] as [CachePageCursor | null, number][],
    events: [] as [number, number][],
  }
  const log: LoggedEvent[] = responses.events ?? []
  const held = {
    nodes: new Map<string, NodeRow>(),
    links: new Map<string, LinkRow>(),
    views: new Map<string, ViewRow>(),
  }
  const add = (body: { nodes: NodeRow[]; links: LinkRow[] }) => {
    const events = rowsToEvents(held, body, {
      batch: `bat_rows_${log.length}`,
      device: "other.tab",
      now: 0,
    })
    for (const event of events) {
      const seq = log.length + 1
      log.push({ ...event, seq, origin: "replica", actor: 111, received_at: event.at })
    }
    for (const node of body.nodes) held.nodes.set(node.id, node)
    for (const link of body.links) {
      held.links.set(linkEntityId(link.source_id, link.destination_id, link.kind), link)
    }
  }
  if (responses.rows) add(responses.rows)
  const id = responses.replicaId === undefined ? {} : { replica_id: responses.replicaId }
  /** The cache: the fold by stamp of the log, in primary-key order. */
  const cacheRows = () =>
    [...foldEventsToCache(keyed(log)).values()].sort((a, b) => compareKeys(keyOf(a), keyOf(b)))
  const source: D1NoteSource = {
    pullCache: async (after, limit) => {
      calls.cache.push([after, limit])
      if (responses.fail) throw new Error("offline")
      const rows = cacheRows()
        .filter((row) => after === null || compareKeys(keyOf(row), after) > 0)
        .slice(0, limit)
      const page: CachePageBody = {
        rows,
        seq: log.length,
        cursor: rows.length === limit ? keyOf(rows[rows.length - 1]) : null,
        ...id,
      }
      return page
    },
    pullEvents: async (since, limit) => {
      calls.events.push([since, limit])
      if (responses.fail) throw new Error("offline")
      // Served per key, as the replica's per-key log serves it.
      const events = keyed(log)
        .filter((e) => e.seq > since)
        .slice(0, limit)
      return { events, cursor: events.at(-1)?.seq ?? null, ...id }
    },
  }
  return { source, calls, add }
}

/** A placed event of the replica's log, as the events pull serves it. */
const placed = (seq: number, id: string, text: string, at = seq * 1_000): LoggedEvent => ({
  id: `evt_remote_${seq}`,
  seq,
  entity: "block",
  entity_id: id,
  action: "create",
  patch: { type: "note", text, props: null, notes_id: null },
  batch: `bat_remote_${seq}`,
  device: "other.tab",
  at,
  tz: 0,
  v: 1,
  origin: "replica",
  actor: 111,
  received_at: at,
})

/** Remote row corpus built from note markdown — what a real replica holds. */
function remoteCorpus(notes: Record<string, string>, updatedAt = 1, cursor: string | null = null) {
  const body: ReplicaCorpusBody = { nodes: [], links: [], views: [], cursor }
  for (const [id, markdown] of Object.entries(notes)) {
    const { nodes, links } = docToGraph(id, markdown, updatedAt)
    body.nodes.push(...nodes)
    body.links.push(...links)
  }
  return body
}

/** Every row of these notes, tombstoned — how a remote delete travels. */
function remoteDeletion(deleted: Record<string, string>, updatedAt: number) {
  const body = remoteCorpus(deleted, updatedAt)
  return {
    nodes: body.nodes.map((node) => ({ ...node, deleted_at: updatedAt })),
    links: body.links.map((link) => ({ ...link, deleted_at: updatedAt })),
  }
}

/** Boot the runtime on a store, with the network and the push loop stubbed. */
async function boot(options: {
  store?: NoteStore
  source: D1NoteSource
  replica?: ReplicaSyncHandle | null
  owner?: string
  foldCheckMs?: number
}) {
  const store = options.store ?? (await openSqlNoteStore(createNodeSqlDriver()))
  startDatabaseMode({
    owner: options.owner,
    openStore: async () => ({ store, persistence: "memory" }),
    openReplicaSync: async () => options.replica ?? null,
    source: options.source,
    pullRetryMs: 10 * 60_000, // effectively disabled; stop() clears the timer
    foldCheckMs: options.foldCheckMs,
  })
  await flushDatabaseMode()
  return store
}

const jotai = getDefaultStore()
/** Every note's rollup, keyed `<id>.md` — the shape the old files map had,
 * derived from the graph atom for the assertions below. */
const files = () => {
  const out: Record<string, string> = {}
  const snapshot = jotai.get(databaseGraphAtom)
  for (const node of snapshot.nodes.values()) {
    if (node.type === NOTE_TYPE) out[`${node.id}.md`] = rollup(node.id, snapshot) as string
  }
  return out
}
/** Write a note's markdown as the ops its doc derives to (the editor's path). */
const writeNote = (id: string, markdown: string) =>
  databaseApplyOps(docToOps(id, parse(markdown), jotai.get(databaseGraphAtom)))
const graph = () => jotai.get(databaseGraphAtom)
/** The note's doc as the graph atom holds it, as bytes (or null). */
const walked = (id: string) => {
  const doc = noteDoc(id, graph())
  return doc ? serialize(doc) : null
}
const status = () => jotai.get(databaseModeStatusAtom)

afterEach(async () => {
  stopDatabaseMode()
  await flushDatabaseMode()
  vi.restoreAllMocks()
})

const NOTE_A = "- A\n  id:: blk_a000000000\n"
const NOTE_B = "- B\n  id:: blk_b000000000\n"

/** Save notes as the app does: each doc diffed against the live graph into
 * ops, applied in turn. Markdown is only the fixture's spelling. */
async function seedNotes(store: NoteStore, notes: Record<string, string>) {
  for (const [id, markdown] of Object.entries(notes)) {
    await applyOpsToStore(store, docToOps(id, parse(markdown), await store.getGraph()))
  }
}

/** The store's queue as `[entity.action, entity_id]`, in the order made. */
const queued = async (store: NoteStore) => {
  const out: [string, string][] = []
  for (const row of await store.unpushedEvents()) {
    const last = out.at(-1)
    // A set after a row of the same entity is part of that gesture.
    if ((row.action === "set" || row.action === "unset") && last && last[1] === row.entity_id) {
      continue
    }
    const action = row.action === "set" || row.action === "unset" ? "update" : row.action
    out.push([`${row.entity}.${action}`, row.entity_id])
  }
  return out
}
const ofEntity = (events: KeyEvent[], entity: KeyEvent["entity"]) =>
  events.filter((event) => event.entity === entity)

/** A note's markdown projection off the store's live graph, or null. */
const noteOf = async (store: NoteStore, id: string) => rollup(id, await store.getGraph())

/** Every note's markdown projection, keyed by id — what the store holds. */
async function notesOf(store: NoteStore): Promise<Record<string, string>> {
  const graph = await store.getGraph()
  const notes: Record<string, string> = {}
  for (const node of graph.nodes.values()) {
    if (node.type !== NOTE_TYPE) continue
    const markdown = rollup(node.id, graph)
    if (markdown !== null) notes[node.id] = markdown
  }
  return notes
}

/** A local store as the current app leaves it: a cache it took a snapshot
 * for, an events cursor, and the cache generation those rows belong to. */
async function seededStore(
  notes: Record<string, string>,
  cursor = "500",
  generation: string = CACHE_GENERATION,
  owner?: string,
) {
  const store = await openSqlNoteStore(createNodeSqlDriver())
  await seedNotes(store, notes)
  await store.setMeta("cache_seeded", "1")
  await store.setMeta("events_pull_cursor", cursor)
  await store.setMeta("cache_generation", generation)
  if (owner !== undefined) await store.setMeta("store_owner", owner)
  return store
}

/** A cache row planted straight into the store, as the replica would hold
 * it: a register of a block at a stamp of the planter's choosing. */
const planted = (
  id: string,
  key: string,
  value: unknown,
  ms: number,
  action: "set" | "create" = "set",
): CacheRow =>
  cacheRowOf({
    id: `evt_plant_${id}_${key}`,
    entity: "block",
    entity_id: id,
    action,
    key: action === "set" ? key : "",
    value,
    batch: "plant",
    device: "planter",
    at: ms,
    v: 2,
    hlc: `${String(ms).padStart(15, "0")}-0000-planter`,
  }) as CacheRow

describe("database mode boot", () => {
  it("first boot: the snapshot populates the store and the atom, then the log follows", async () => {
    const { source, calls } = stubSource({
      rows: remoteCorpus({ "note-a": NOTE_A, "note-b": NOTE_B }),
    })
    const store = await boot({ source })

    // One page of the cache, then the log from the start.
    expect(calls.cache).toEqual([[null, 20_000]])
    expect(calls.events[0]).toEqual([0, 2_000])
    expect(await notesOf(store)).toEqual({ "note-a": NOTE_A, "note-b": NOTE_B })
    expect(await store.getMeta("cache_seeded")).not.toBeNull()
    expect(Number(await store.getMeta("events_pull_cursor"))).toBeGreaterThan(0)
    // The files atom carries the repo-file-shaped map every consumer reads.
    expect(files()).toEqual({ "note-a.md": NOTE_A, "note-b.md": NOTE_B })
    expect(status()).toMatchObject({ status: "ready", pull: "idle", emptyOffline: false })
    expect(isDatabaseModeActive()).toBe(true)
  })

  it("later boots serve local contents and pull only the log past the stored cursor", async () => {
    const seeded = await seededStore({ "note-a": "- local A\n  id:: blk_a000000000\n" }, "500")

    const { source, calls } = stubSource({ events: [placed(6, "note-b", "B")] })
    const store = await boot({ store: seeded, source })

    expect(calls.cache).toEqual([])
    expect(calls.events).toEqual([[500, 2_000]])
    expect(await notesOf(store)).toEqual({
      "note-a": "- local A\n  id:: blk_a000000000\n",
      // A note with a title and no blocks serializes to its one empty line.
      "note-b": "\n",
    })
    expect(await store.getMeta("events_pull_cursor")).toBe("603")
  })

  it("while the browser says offline, no pull is attempted — it waits for the network", async () => {
    // `navigator.onLine === false` is a definite "no network": a pull would
    // only fail and read as "Sync failed". It is skipped instead — nothing
    // recorded as an error, a first-ever boot still gets the empty-offline
    // notice — and the `online` event's pull runs once the network is back.
    Object.defineProperty(navigator, "onLine", { configurable: true, get: () => false })
    try {
      const { source, calls } = stubSource({ rows: remoteCorpus({ "note-a": NOTE_A }) })
      const store = await boot({ source })
      expect(calls.cache).toHaveLength(0)
      expect(status()).toMatchObject({
        status: "ready",
        pull: "idle",
        lastPullError: null,
        emptyOffline: true,
      })

      Object.defineProperty(navigator, "onLine", { configurable: true, get: () => true })
      requestDatabasePull()
      await flushDatabaseMode()
      expect(calls.cache).toHaveLength(1)
      expect(await notesOf(store)).toEqual({ "note-a": NOTE_A })
      expect(status()).toMatchObject({ pull: "idle", emptyOffline: false })
    } finally {
      delete (navigator as { onLine?: boolean }).onLine
    }
  })

  it("first-ever boot offline: empty state flagged, cleared by the first write", async () => {
    const { source } = stubSource({ fail: true })
    await boot({ source })

    expect(status()).toMatchObject({ status: "ready", pull: "error", emptyOffline: true })
    expect(status().lastPullError).toBe("offline")
    expect(files()).toEqual({})

    writeNote("first", "- written offline\n  id:: blk_first00000\n")
    expect(status().emptyOffline).toBe(false)
    expect(files()["first.md"]).toBe("- written offline\n  id:: blk_first00000\n")
  })
})

describe("database mode saves", () => {
  it("a new note's ops write the SQL store, update the atom, and queue their events for the push", async () => {
    const { source } = stubSource({})
    const { handle, calls } = stubReplica()
    const store = await boot({ source, replica: handle })

    writeNote("note-a", "- hello\n  id:: blk_a000000000\n")
    expect(files()["note-a.md"]).toBe("- hello\n  id:: blk_a000000000\n") // optimistic, pre-flush
    await flushDatabaseMode()

    expect(await noteOf(store, "note-a")).toBe("- hello\n  id:: blk_a000000000\n")
    expect(calls.changes).toHaveLength(1)
    expect(calls.changes[0].noteIds).toEqual(["note-a"])
    // The store's log holds what the editor did, as events the push loop sends.
    expect(await queued(store)).toEqual([
      ["block.create", "note-a"],
      ["block.create", "blk_a000000000"],
      ["link.create", "note-a|blk_a000000000|child"],
    ])
    const [created] = await store.unpushedEvents()
    expect(created).toMatchObject({
      device: expect.stringMatching(/^[0-9a-z]+\.[0-9a-z]{6}$/),
      // The writer's own offset, in minutes east of UTC: 0 only where the
      // machine runs on UTC, so read it as the store did.
      tz: writerTimezone(),
    })
  })

  it("a delete tombstones the note's rows and pushes the tombstones", async () => {
    const { source } = stubSource({ rows: remoteCorpus({ "note-a": NOTE_A }) })
    const { handle, calls } = stubReplica()
    const store = await boot({ source, replica: handle })

    databaseApplyOps(deleteNoteOps("note-a", jotai.get(databaseGraphAtom)))
    await flushDatabaseMode()

    expect(await noteOf(store, "note-a")).toBeNull()
    expect(files()).toEqual({})
    expect(calls.changes).toHaveLength(1)
    // A delete is an event per block — that is how it reaches another device
    // — and the whole gesture shares one clock, so one stamp.
    const deletes = ofEntity(await store.unpushedEvents(), "block").filter(
      (event) => event.action === "delete",
    )
    expect(deletes.map((event) => event.entity_id).sort()).toEqual(["blk_a000000000", "note-a"])
    expect(new Set(deletes.map((event) => event.at)).size).toBe(1)
    const rows = (await store.getAllRows()).nodes
    expect(new Set(rows.map((node) => node.deleted_at)).size).toBe(1)
  })

  it("ops apply to the graph atom at once and land as rows after the coalescing window", async () => {
    const { source } = stubSource({ rows: remoteCorpus({ "note-a": NOTE_A }) })
    const { handle, calls } = stubReplica()
    const store = await boot({ source, replica: handle })
    expect(walked("note-a")).toBe(NOTE_A)

    const edited = "- A edited\n  id:: blk_a000000000\n- new\n  id:: blk_n000000000\n"
    databaseApplyOps(docToOps("note-a", parse(edited), graph()))
    // On screen at once…
    expect(walked("note-a")).toBe(edited)
    // …in the store only once the run is written.
    expect(await noteOf(store, "note-a")).toBe(NOTE_A)
    await flushDatabaseMode()

    expect(await noteOf(store, "note-a")).toBe(edited)
    expect(files()["note-a.md"]).toBe(edited)
    expect(walked("note-a")).toBe(edited)
    expect(calls.changes).toHaveLength(1)
    expect(calls.changes[0].noteIds).toEqual(["note-a"])
    // Each block's rows as the gesture they are: a create with its sets, or
    // an update.
    const gestures = new Map<string, string>()
    for (const row of ofEntity(await store.unpushedEvents(), "block")) {
      if (row.action === "create" || !gestures.has(row.entity_id)) {
        gestures.set(row.entity_id, row.action === "set" ? "update" : row.action)
      }
    }
    expect([...gestures].map(([id, action]) => `${action}:${id}`).sort()).toEqual([
      "create:blk_n000000000",
      "update:blk_a000000000",
    ])
  })

  it("a run of ops is one store write, and a later batch never lands ahead of it", async () => {
    const { source } = stubSource({ rows: remoteCorpus({ "note-a": NOTE_A }) })
    const { handle, calls } = stubReplica()
    const store = await boot({ source, replica: handle })

    databaseApplyOps([{ op: "setText", id: "blk_a000000000", text: "A1" }])
    databaseApplyOps([{ op: "setText", id: "blk_a000000000", text: "A12" }])
    databaseApplyOps([{ op: "setText", id: "blk_a000000000", text: "A123" }])
    writeNote("note-b", NOTE_B)
    await flushDatabaseMode()

    expect(await noteOf(store, "note-a")).toBe("- A123\n  id:: blk_a000000000\n")
    expect(await noteOf(store, "note-b")).toBe(NOTE_B)
    expect(walked("note-a")).toBe("- A123\n  id:: blk_a000000000\n")
    expect(calls.changes).toHaveLength(1)
    expect(calls.changes[0].noteIds.sort()).toEqual(["note-a", "note-b"])
    // The typing run is ONE event, carrying its last text.
    const typed = ofEntity(await store.unpushedEvents(), "block").filter(
      (event) => event.entity_id === "blk_a000000000",
    )
    expect(typed).toHaveLength(1)
    expect(typed[0]).toMatchObject({ action: "set", key: "text", value: "A123" })
  })

  it("a pull never clobbers ops still coalescing", async () => {
    const { source, add } = stubSource({ rows: remoteCorpus({ "note-a": NOTE_A }) })
    // The push queue reports note-a pending only once the edit is made.
    const pending: NoteId[] = []
    const { handle } = stubReplica(pending)
    const store = await boot({ source, replica: handle })

    databaseApplyOps([{ op: "setText", id: "blk_a000000000", text: "typed" }])
    pending.push("note-a")
    add(remoteCorpus({ "note-b": NOTE_B }, 200))
    requestDatabasePull()
    await flushDatabaseMode()

    expect(walked("note-a")).toBe("- typed\n  id:: blk_a000000000\n")
    expect(await noteOf(store, "note-a")).toBe("- typed\n  id:: blk_a000000000\n")
    expect(walked("note-b")).toBe(NOTE_B)
  })

  it("deleting a note's last block through ops tombstones the rows", async () => {
    const { source } = stubSource({ rows: remoteCorpus({ "note-a": NOTE_A }) })
    const { handle, calls } = stubReplica()
    const store = await boot({ source, replica: handle })

    databaseApplyOps(deleteBlockOps("blk_a000000000", graph()))
    expect(walked("note-a")).toBe(serialize(parse("")))
    await flushDatabaseMode()

    expect(await noteOf(store, "note-a")).toBe(serialize(parse("")))
    expect(files()["note-a.md"]).toBe(serialize(parse("")))
    expect(calls.changes).toHaveLength(1)
    expect(
      ofEntity(await store.unpushedEvents(), "block").map((e) => [e.entity_id, e.action]),
    ).toEqual([["blk_a000000000", "delete"]])
  })

  it("the graph atom follows pulls too", async () => {
    const { source, add } = stubSource({ rows: remoteCorpus({ "note-a": NOTE_A }) })
    await boot({ source, replica: null })
    expect(walked("note-a")).toBe(NOTE_A)
    expect(walked("note-b")).toBeNull()

    writeNote("note-c", "- C\n  id:: blk_c000000000\n")
    await flushDatabaseMode()
    expect(walked("note-c")).toBe("- C\n  id:: blk_c000000000\n")

    add(remoteCorpus({ "note-b": NOTE_B }, 200))
    requestDatabasePull()
    await flushDatabaseMode()
    expect(walked("note-b")).toBe(NOTE_B)
  })
})

/**
 * Sync is the log and nothing else (docs/events-log-cache.md): a pull is
 * the log past the device's cursor, and each page lands in the cache and
 * patches the graph with the entities it touched.
 */
describe("database mode pulls the log", () => {
  it("applies remote changes", async () => {
    const KEEP_V2 = "- keep v2\n  id:: blk_keep000000\n"
    const { source, add } = stubSource({
      rows: remoteCorpus({ keep: "- keep\n  id:: blk_keep000000\n" }),
    })
    const store = await boot({ source })
    const before = Number(await store.getMeta("events_pull_cursor"))

    add(remoteCorpus({ keep: KEEP_V2 }, 200))
    requestDatabasePull()
    await flushDatabaseMode()

    expect(await notesOf(store)).toEqual({ keep: KEEP_V2 })
    expect(files()).toEqual({ "keep.md": KEEP_V2 })
    expect(Number(await store.getMeta("events_pull_cursor"))).toBeGreaterThan(before)
  })

  it("a remote deletion arrives as events of the rows, and nothing else is said", async () => {
    // The pull says nothing at all about `keep` (unchanged, so no event), and
    // `gone` disappears purely because its delete events came.
    const KEEP = "- keep\n  id:: blk_keep000000\n"
    const GONE = "- gone\n  id:: blk_gone000000\n"
    const { source, add } = stubSource({ rows: remoteCorpus({ keep: KEEP, gone: GONE }) })
    const store = await boot({ source })
    expect(await notesOf(store)).toEqual({ keep: KEEP, gone: GONE })

    add(remoteDeletion({ gone: GONE }, 200))
    requestDatabasePull()
    await flushDatabaseMode()

    expect(await notesOf(store)).toEqual({ keep: KEEP })
    expect(files()).toEqual({ "keep.md": KEEP })
  })

  it("a pull that brings nothing changes nothing (silence is not deletion)", async () => {
    const KEEP = "- keep\n  id:: blk_keep000000\n"
    const { source, calls } = stubSource({ rows: remoteCorpus({ keep: KEEP }) })
    const store = await boot({ source })
    const cursor = await store.getMeta("events_pull_cursor")

    requestDatabasePull()
    await flushDatabaseMode()

    expect(calls.events.at(-1)).toEqual([Number(cursor), 2_000])
    expect(await notesOf(store)).toEqual({ keep: KEEP })
    expect(await store.getMeta("events_pull_cursor")).toBe(cursor)
  })

  it("never clobbers notes with queued local pushes (the local edit's stamp is higher)", async () => {
    const LOCAL_EDIT = "- local edit\n  id:: blk_a000000000\n"
    const CREATED = "- brand new\n  id:: blk_new0000000\n"
    const REMOTE_EDIT = "- remote edit\n  id:: blk_a000000000\n"
    const { source, add } = stubSource({
      rows: remoteCorpus({ "note-a": "- original\n  id:: blk_a000000000\n" }),
    })
    const pending: NoteId[] = []
    const { handle } = stubReplica(pending)
    const store = await boot({ source, replica: handle })

    writeNote("note-a", LOCAL_EDIT)
    writeNote("created", CREATED)
    pending.push("note-a", "created")
    await flushDatabaseMode()
    // The remote edit is older than the local one, by stamp; the locally
    // created note is unknown remotely.
    add(remoteCorpus({ "note-a": REMOTE_EDIT }, 9999))
    requestDatabasePull()
    await flushDatabaseMode()

    // The pull neither reverted the local edit nor deleted the unpushed note.
    expect(await noteOf(store, "note-a")).toBe(LOCAL_EDIT)
    expect(await noteOf(store, "created")).toBe(CREATED)
    // On screen, the fold: the local edit has the higher stamp.
    expect(walked("note-a")).toBe(LOCAL_EDIT)
    expect(walked("created")).toBe(CREATED)
  })

  it("each page of the log patches the graph as it lands, not only after the run", async () => {
    // A device that took its snapshot long ago and is far behind the log:
    // the second page is slow, and the first page's notes are on screen
    // while it waits.
    const events = Array.from({ length: 2_001 }, (_, i) => placed(i + 1, `note-${i}`, `N${i}`))
    const { source } = stubSource({ events })
    let asked = 0
    let release = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    const pullEvents = source.pullEvents
    source.pullEvents = async (since, limit) => {
      asked += 1
      if (since > 0) await gate
      return pullEvents(since, limit)
    }
    const store = await seededStore({}, "0")
    startDatabaseMode({
      openStore: async () => ({ store, persistence: "memory" }),
      openReplicaSync: async () => null,
      source,
      pullRetryMs: 10 * 60_000,
    })
    try {
      // Folding a page of 2,000 rows — 500 of these creates — takes a moment.
      await vi.waitFor(() => expect(asked).toBe(2), { timeout: 30_000 })
      await vi.waitFor(() => expect(graph().nodes.size).toBe(500), { timeout: 5_000 })
    } finally {
      release()
    }
    await flushDatabaseMode()
    expect(graph().nodes.size).toBe(2_001)
  }, 60_000)
})

/**
 * The store's cache is the fold of its log, key by key (docs/events-log-
 * cache.md): boot reads it, each batch of edits and each page of pulled
 * events updates it, and the fold check compares it in the background with
 * the log, reporting a difference with `console.error`.
 */
describe("database mode reads the fold", () => {
  let errors: { mock: { calls: unknown[][] } }
  beforeEach(() => {
    errors = vi.spyOn(console, "error").mockImplementation(() => {})
  })
  /** Every line the fold check has reported. */
  const reported = () =>
    errors.mock.calls
      .filter((call) => String(call[0]).includes("fold check:"))
      .flatMap((call) => call[1] as string[])
  /** Let the fold check's timer fire, then wait for the queue. */
  const checked = async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await flushDatabaseMode()
  }

  it("boots from the cache with nothing to fold, and checks nothing no batch touched", async () => {
    const store = await seededStore({ "note-a": NOTE_A, "note-b": NOTE_B })
    // A row only the cache holds: no event made it.
    await store.importCacheRows([
      planted("blk_x", "", null, 1, "create"),
      planted("blk_x", "type", "paragraph", 1),
      planted("blk_x", "text", "x", 1),
    ])
    const folds = vi.spyOn(store, "foldOfLog")

    const { source } = stubSource({})
    await boot({ store, source, foldCheckMs: 0 })
    expect(files()).toEqual({ "note-a.md": NOTE_A, "note-b.md": NOTE_B })
    // A block no note reaches is not on the first screen: it is in the
    // graph once the whole corpus is asked for.
    expect(graph().nodes.has("blk_x")).toBe(false)
    await databaseEnsureAll()
    expect(graph().nodes.has("blk_x")).toBe(true)

    // Nothing was touched, so no check ran, and nothing is reported.
    await checked()
    expect(folds).not.toHaveBeenCalled()
    expect(reported()).toEqual([])
  })

  it("a check after a batch reads only what it touched, and reports a difference by its key", async () => {
    const { source } = stubSource({ rows: remoteCorpus({ "note-a": NOTE_A }) })
    const store = await boot({ source, foldCheckMs: 0 })
    await checked()
    // The snapshot and the log's events match the cache.
    expect(reported()).toEqual([])

    // A row only the cache holds: no batch touches it, so it is not read.
    await store.importCacheRows([
      planted("blk_x", "", null, 1, "create"),
      planted("blk_x", "type", "paragraph", 1),
      planted("blk_x", "text", "x", 1),
    ])
    const folds = vi.spyOn(store, "foldOfLog")
    writeNote("note-b", NOTE_B)
    await flushDatabaseMode()
    // A register a batch touched, changed under the log: a later stamp the
    // log never saw.
    await store.importCacheRows([planted("blk_b000000000", "text", "planted", 9e12)])
    await checked()
    expect(reported()).toEqual(["block blk_b000000000 text: value, hlc"])
    const [keys] = folds.mock.calls[0]
    expect(keys?.blocks.has("blk_b000000000")).toBe(true)
    expect(keys?.blocks.has("blk_x")).toBe(false)
  })

  it("an edit and a pulled event both reach the fold, and the check finds no difference", async () => {
    const EDIT = "- edited\n  id:: blk_a000000000\n"
    const REMOTE = "- from elsewhere\n  id:: blk_b000000000\n"
    const { source, add } = stubSource({ rows: remoteCorpus({ "note-a": NOTE_A }) })
    await boot({ source, foldCheckMs: 0 })
    await checked()
    expect(reported()).toEqual([])

    writeNote("note-a", EDIT)
    await flushDatabaseMode()
    add(remoteCorpus({ "note-b": REMOTE }, 5))
    // The pull's events patch the screen from the cache: the edit is in it.
    requestDatabasePull()
    await flushDatabaseMode()
    expect(files()).toEqual({ "note-a.md": EDIT, "note-b.md": REMOTE })

    await checked()
    expect(reported()).toEqual([])
  })

  it("a fresh device draws the snapshot at once, before any page of the log", async () => {
    // Finn's report of 2026-10-28: a fresh profile pulled 27 pages of the log
    // and showed nothing until the last had folded. Here the log never
    // answers until released: the notes are on screen from the snapshot
    // alone, and the fold check, once the log has caught up, finds the
    // cache and the log agree.
    const { source, calls } = stubSource({
      rows: remoteCorpus({ "note-a": NOTE_A, "note-b": NOTE_B }),
    })
    let release = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    const pullEvents = source.pullEvents
    source.pullEvents = async (since, limit) => {
      await gate
      return pullEvents(since, limit)
    }
    const store = await openSqlNoteStore(createNodeSqlDriver())
    startDatabaseMode({
      openStore: async () => ({ store, persistence: "memory" }),
      openReplicaSync: async () => null,
      source,
      foldCheckMs: 0,
      pullRetryMs: 10 * 60_000,
    })
    try {
      await vi.waitFor(() => expect(graph().nodes.get("blk_a000000000")?.text).toBe("A"))
      expect(graph().nodes.get("blk_b000000000")?.text).toBe("B")
      expect(calls.cache).toHaveLength(1)
      // Nothing of the log has landed: the snapshot alone drew the screen.
      expect(await store.eventLog()).toEqual([])
      expect((await store.getMeta("events_pull_cursor")) ?? "").toBe("")
    } finally {
      release()
    }
    await flushDatabaseMode()
    expect((await store.eventLog()).length).toBeGreaterThan(0)
    expect(graph().nodes.get("blk_a000000000")?.text).toBe("A")
    await checked()
    expect(reported()).toEqual([])
  })

  it("pulls a long log to its end before the check, and shows all of it", async () => {
    // Four rows per create: just past ten pages of 2,000 rows.
    const events = Array.from({ length: 5_001 }, (_, i) => placed(i + 1, `note-${i}`, `N${i}`))
    const { source, calls } = stubSource({ events })
    await boot({ source, foldCheckMs: 0 })
    await flushDatabaseMode()
    // Ten pages in the pull, then the next run of pages queued at once.
    expect(calls.events).toHaveLength(11)
    expect(graph().nodes.size).toBe(5_001)
    await checked()
    expect(reported()).toEqual([])
  }, 30_000)
})

/**
 * The device's copy of the tenant's log (docs/event-sourcing.md): brought
 * down by the pull, page by page, after the snapshot — and read back whole,
 * with this device's own unpushed events placed after everything else.
 */
describe("database mode event log", () => {
  it("a pull brings the log down after the snapshot, stores its cursor, and pulls only past it next time", async () => {
    const { source, calls } = stubSource({
      events: [placed(1, "note-a", "A"), placed(2, "note-b", "B")],
    })
    const store = await boot({ source, replica: stubReplica().handle })
    expect(calls.cache).toHaveLength(1)
    expect(calls.events).toEqual([[0, 2_000]])
    // The cursor is the per-key log's own seq: the last row of the second event.
    expect(await store.getMeta("events_pull_cursor")).toBe("203")
    expect((await store.eventLog()).map((event) => [event.seq, event.origin, event.actor])).toEqual(
      keyed([placed(1, "note-a", "A"), placed(2, "note-b", "B")]).map((row) => [
        row.seq,
        "replica",
        111,
      ]),
    )
    expect(await noteOf(store, "note-b")).not.toBeNull()

    requestDatabasePull()
    await flushDatabaseMode()
    expect(calls.events.at(-1)).toEqual([203, 2_000])
    expect(jotai.get(eventLogVersionAtom)).toBeGreaterThan(0)
  })

  it("places this device's own event when the pull brings it back, and reads the log whole", async () => {
    const { source } = stubSource({ events: [placed(1, "note-a", "A")] })
    const store = await boot({ source, replica: stubReplica().handle })
    writeNote("note-c", "- C\n  id:: blk_c000000000\n")
    await flushDatabaseMode()
    const own = await store.unpushedEvents()
    expect(own.length).toBeGreaterThan(0)
    const log = (await databaseEventLog()) as LoggedKeyEvent[]
    // Placed first (the remote create's four rows), then the unpushed,
    // provisionally after them.
    expect(log[0]).toMatchObject({ seq: 100, event: "evt_remote_1" })
    expect(log.slice(4).map((event) => event.pending)).toEqual(own.map(() => true))
    expect(log.slice(4).map((event) => event.seq)).toEqual(own.map((_, i) => 104 + i))
  })

  it("a device that has taken its snapshot takes none again", async () => {
    const { source, calls } = stubSource({ events: [placed(1, "note-a", "A")] })
    const store = await seededStore({}, "999")
    await boot({ store, source, replica: stubReplica().handle })
    expect(calls.cache).toEqual([])
    expect(calls.events).toEqual([[999, 2_000]])
    expect(await noteOf(store, "note-a")).toBeNull()
  })

  it("a wiped cache takes a snapshot again and pulls the log again from the start", async () => {
    const { source, calls } = stubSource({ events: [placed(1, "note-a", "A")] })
    const store = await seededStore({ "note-a": NOTE_A }, "9", "0")
    await boot({ store, source, replica: stubReplica().handle })
    // The stale generation wiped the cache, cursors included, so the
    // snapshot was taken and the log was pulled from zero.
    expect(calls.cache).toHaveLength(1)
    expect(calls.events[0]).toEqual([0, 2_000])
    // The log kept the device's own unpushed events, and took the remote one.
    const log = await store.eventLog()
    expect(log.some((event) => event.event === "evt_remote_1")).toBe(true)
    expect((await store.unpushedEvents()).length).toBeGreaterThan(0)
  })
})

describe("database mode lifecycle", () => {
  it("stop closes the store, stops the push loop, and resets the atoms", async () => {
    const { source } = stubSource({ rows: remoteCorpus({ a: NOTE_A }) })
    const { handle, calls } = stubReplica()
    const store = await boot({ source, replica: handle })
    const close = vi.spyOn(store, "close")

    stopDatabaseMode()
    await flushDatabaseMode()

    expect(calls.stopped).toBe(true)
    expect(close).toHaveBeenCalled()
    expect(files()).toEqual({})
    expect(graph()).toBe(EMPTY_GRAPH)
    expect(status().status).toBe("off")
    expect(isDatabaseModeActive()).toBe(false)
  })
})

/**
 * A different database behind the same URL — a preview clone rebuilt from
 * production (docs/preview-databases.md). The cursor the device holds was
 * issued by the old database and means nothing against the new one, so the
 * cache is wiped and a snapshot taken again, as for a stale generation.
 */
describe("replica identity", () => {
  it("a changed replica_id wipes the cache and takes a snapshot of the new database", async () => {
    const seeded = await seededStore({ "note-a": NOTE_A }, "500")
    await seeded.setMeta("replica_id", "clone-one")

    // The log answers with the NEW database's id: its sequence is behind the
    // stored cursor, so the page is empty, and the id says why.
    const { source, calls } = stubSource({
      rows: remoteCorpus({ "note-b": NOTE_B }),
      replicaId: "clone-two",
    })
    const store = await boot({ store: seeded, source })

    expect(calls.events[0]).toEqual([500, 2_000])
    expect(calls.cache).toHaveLength(1)
    expect(await notesOf(store)).toEqual({ "note-b": NOTE_B })
    expect(files()).toEqual({ "note-b.md": NOTE_B })
    expect(await store.getMeta("replica_id")).toBe("clone-two")
  })

  it("the same replica_id, or none at all, leaves the local copy alone", async () => {
    const seeded = await seededStore({ "note-a": NOTE_A })
    await seeded.setMeta("replica_id", "production")

    const { source, calls } = stubSource({ replicaId: "production" })
    const store = await boot({ store: seeded, source })
    expect(calls.cache).toHaveLength(0)
    expect(await notesOf(store)).toEqual({ "note-a": NOTE_A })
    stopDatabaseMode()
    await flushDatabaseMode()

    // An older Worker sends no id: not evidence of a swap.
    const labelled = await seededStore({ "note-a": NOTE_A })
    await labelled.setMeta("replica_id", "production")
    const silent = stubSource({})
    const kept = await boot({ store: labelled, source: silent.source })
    expect(silent.calls.cache).toHaveLength(0)
    expect(await notesOf(kept)).toEqual({ "note-a": NOTE_A })
    expect(await kept.getMeta("replica_id")).toBe("production")
  })

  it("first contact adopts the id without wiping", async () => {
    const seeded = await seededStore({ "note-a": NOTE_A })
    expect(await seeded.getMeta("replica_id")).toBeNull()

    const { source, calls } = stubSource({ replicaId: "production" })
    const store = await boot({ store: seeded, source })
    expect(calls.cache).toHaveLength(0)
    expect(await notesOf(store)).toEqual({ "note-a": NOTE_A })
    expect(await store.getMeta("replica_id")).toBe("production")
  })

  it("a snapshot from a changed replica lands on a cleared cache", async () => {
    // No snapshot taken yet (a fresh boot after an owner wipe) but rows from
    // the old clone still local: the snapshot is already the right pull, and
    // the clear must still happen so nothing of the old clone survives it.
    const seeded = await openSqlNoteStore(createNodeSqlDriver())
    await seedNotes(seeded, { "note-a": NOTE_A })
    await seeded.setMeta("cache_generation", CACHE_GENERATION)
    await seeded.setMeta("replica_id", "clone-one")

    const { source, calls } = stubSource({
      rows: remoteCorpus({ "note-b": NOTE_B }),
      replicaId: "clone-two",
    })
    const store = await boot({ store: seeded, source })
    // The first page said "clone-two": the cache was wiped and the snapshot
    // started over.
    expect(calls.cache).toHaveLength(2)
    expect(await notesOf(store)).toEqual({ "note-b": NOTE_B })
  })
})

/**
 * The local store is a CACHE of D1, never a source of truth, so it is never
 * data-migrated: a copy from an older generation is discarded and rebuilt
 * from a snapshot. This is what stops a device that predates a server-side
 * migration merging its stale rows with the pulled, migrated ones. The log
 * stays: what this device made and has not pushed is still its own to push.
 */
describe("cache generation", () => {
  it("a stale generation wipes the cache and takes a snapshot", async () => {
    const seeded = await seededStore({ "note-a": NOTE_A }, "500", "1")

    const { source, calls } = stubSource({ rows: remoteCorpus({ "note-b": NOTE_B }) })
    const store = await boot({ store: seeded, source })

    // The cursors went with the cache, so the pull took the snapshot and the
    // log from zero — the whole point: a pull past the old cursor would have
    // merged two generations.
    expect(calls.cache).toHaveLength(1)
    expect(calls.events[0]).toEqual([0, 2_000])
    // The snapshot's note, and the device's own unpushed note replayed on
    // top of it: the log stays across a generation wipe.
    expect(await notesOf(store)).toEqual({ "note-a": NOTE_A, "note-b": NOTE_B })
    expect(files()).toEqual({ "note-a.md": NOTE_A, "note-b.md": NOTE_B })
    expect(await store.getMeta("cache_generation")).toBe(CACHE_GENERATION)
    expect(await store.getMeta("cache_seeded")).not.toBe("")
  })

  it("a matching generation leaves the local copy and its cursor alone", async () => {
    const seeded = await seededStore({ "note-a": NOTE_A })

    const { source, calls } = stubSource({})
    const store = await boot({ store: seeded, source })

    expect(calls.cache).toHaveLength(0)
    expect(calls.events).toEqual([[500, 2_000]])
    expect(await notesOf(store)).toEqual({ "note-a": NOTE_A })
  })

  it("a fresh store boots normally and records the generation", async () => {
    const { source, calls } = stubSource({ rows: remoteCorpus({ "note-a": NOTE_A }) })
    const store = await boot({ source })

    expect(calls.cache).toHaveLength(1)
    expect(await notesOf(store)).toEqual({ "note-a": NOTE_A })
    expect(await store.getMeta("cache_generation")).toBe(CACHE_GENERATION)
  })

  it("keeps the owner binding intact across a generation wipe", async () => {
    // The two wipes are independent: bumping the generation must not sign the
    // browser out of its own cache and re-wipe it on the next boot.
    const seeded = await seededStore({ "note-a": NOTE_A }, "500", "1")
    await seeded.setMeta("store_owner", "42")

    const { source } = stubSource({})
    const store = await boot({ store: seeded, source, owner: "42" })

    expect(await store.getMeta("store_owner")).toBe("42")
    // The owner's own unpushed note is still theirs, replayed on the snapshot.
    expect(await notesOf(store)).toEqual({ "note-a": NOTE_A })
  })

  it("keeps the log across a generation wipe: unpushed events are replayed on top of the snapshot", async () => {
    const seeded = await seededStore({ "note-a": NOTE_A }, "500", "1")
    const unpushed = (await seeded.unpushedEvents()).length
    expect(unpushed).toBeGreaterThan(0)

    const { source } = stubSource({ rows: remoteCorpus({ "note-b": NOTE_B }) })
    const store = await boot({ store: seeded, source })

    // The snapshot brought note-b; the device's own unpushed note-a is
    // still queued, and back in the cache on top of the snapshot.
    expect((await store.unpushedEvents()).length).toBe(unpushed)
    expect(await notesOf(store)).toEqual({ "note-a": NOTE_A, "note-b": NOTE_B })
  })

  it("a cache from a client before generations is discarded and snapshotted again", async () => {
    // A store left by a client that predates this release: no generation
    // stamp at all.
    const stale = await openSqlNoteStore(createNodeSqlDriver())
    await seedNotes(stale, { purged: "- purged\n  id:: blk_purged000\n" })
    await stale.setMeta("cache_seeded", "1")
    await stale.setMeta("events_pull_cursor", "500")

    const { source, calls } = stubSource({ rows: remoteCorpus({ "note-a": NOTE_A }) })
    const store = await boot({ store: stale, source })

    expect(calls.cache).toHaveLength(1) // the cursors went with the cache
    expect(calls.events[0]).toEqual([0, 2_000])
    expect(await store.getMeta("cache_generation")).toBe(CACHE_GENERATION)
    // The snapshot, plus what the device had not pushed (its own log).
    expect(await notesOf(store)).toEqual({
      "note-a": NOTE_A,
      purged: "- purged\n  id:: blk_purged000\n",
    })
  })
})

describe("owner binding", () => {
  it("records the owner on first boot", async () => {
    const { source } = stubSource({ rows: remoteCorpus({ "note-a": NOTE_A }) })
    const store = await boot({ source, owner: "42" })
    expect(await store.getMeta("store_owner")).toBe("42")
    expect(await notesOf(store)).toEqual({ "note-a": NOTE_A })
  })

  it("the same owner keeps the local cache and cursor (no snapshot, no wipe)", async () => {
    const seeded = await seededStore({ "note-a": NOTE_A }, "500", CACHE_GENERATION, "42")

    const { source, calls } = stubSource({})
    const store = await boot({ store: seeded, source, owner: "42" })
    expect(calls.events).toEqual([[500, 2_000]])
    expect(calls.cache).toHaveLength(0)
    expect(await notesOf(store)).toEqual({ "note-a": NOTE_A })
  })

  it("a different signed-in identity wipes the local cache before anything renders", async () => {
    const seeded = await seededStore({ "note-a": NOTE_A }, "500", CACHE_GENERATION, "42")

    // A different account signs in on this browser: the previous owner's
    // rows, log and cursor are gone, the pull starts from scratch (and for a
    // non-owner the replica would 403 — an empty corpus, never leaked notes).
    const { source, calls } = stubSource({})
    const store = await boot({ store: seeded, source, owner: "7" })
    expect(await store.getMeta("store_owner")).toBe("7")
    expect(calls.cache).toHaveLength(1)
    expect(calls.events[0]).toEqual([0, 2_000])
    expect(await notesOf(store)).toEqual({})
    expect(await store.eventLog()).toEqual([])
    expect(files()).toEqual({})
  })

  it("an ownerless boot leaves an owned store untouched", async () => {
    const seeded = await seededStore({ "note-a": NOTE_A }, "500", CACHE_GENERATION, "42")

    const { source } = stubSource({})
    const store = await boot({ store: seeded, source })
    expect(await store.getMeta("store_owner")).toBe("42")
    expect(await notesOf(store)).toEqual({ "note-a": NOTE_A })
  })
})

describe("database mode stamps", () => {
  /** A stamp from a clock far ahead of this one. */
  const AHEAD = "009999999999999-0003-other.tab"

  it("stamps each event after every stamp it has pulled, in the order made, and saves the last", async () => {
    const { source } = stubSource({
      // One from a fast clock, and one from before stamps.
      events: [{ ...placed(1, "note-a", "A"), hlc: AHEAD }, placed(2, "note-b", "B")],
    })
    const store = await boot({ source, replica: stubReplica().handle })
    writeNote("note-c", "- C\n  id:: blk_c000000000\n")
    await flushDatabaseMode()
    const stamps = (await store.unpushedEvents()).map((event) => event.hlc as string)
    expect(stamps.length).toBeGreaterThan(1)
    expect(stamps.every((stamp) => stamp > AHEAD)).toBe(true)
    expect([...stamps].sort()).toEqual(stamps)
    expect(decodeHlc(stamps[0])).toMatchObject({ ms: 9_999_999_999_999, counter: 4 })
    expect(await store.getMeta("hlc_last")).toBe(stamps.at(-1))
  })

  it("a new session stamps after the stamp the last one saved", async () => {
    const store = await seededStore({ "note-a": NOTE_A })
    await store.setMeta("hlc_last", AHEAD)
    const { source } = stubSource({})
    await boot({ store, source, replica: stubReplica().handle })
    // The seeded events are the test's own; only the session's are judged.
    const seeded = (await store.unpushedEvents()).length
    writeNote("note-c", "- C\n  id:: blk_c000000000\n")
    await flushDatabaseMode()
    const stamps = (await store.unpushedEvents())
      .slice(seeded)
      .map((event) => event.hlc)
      .filter((stamp) => stamp !== undefined)
    expect(stamps.length).toBeGreaterThan(0)
    expect(stamps.every((stamp) => stamp > AHEAD)).toBe(true)
  })
})

/**
 * Ambient pull coalescing. `focus`, `visibilitychange` and `online` fire on
 * every alt-tab, in pairs, for every open tab — wired straight to a pull they
 * spent 61% of a day's D1 read budget learning nothing. The gap is the fix;
 * these tests are what stop it being quietly removed.
 */
describe("ambient pull coalescing", () => {
  const seeded = () => ({ rows: remoteCorpus({ keep: "- keep\n  id:: blk_keep000000\n" }) })
  /** The pulls after the boot's own. */
  const pulls = (calls: { events: unknown[] }) => calls.events.length - 1

  afterEach(() => {
    vi.useRealTimers()
  })

  it("collapses a burst of triggers into a single pull", async () => {
    vi.useFakeTimers()
    const { source, calls } = stubSource(seeded())
    await boot({ source })
    expect(pulls(calls)).toBe(0)

    // Four alt-tabs in quick succession — eight events in the real browser,
    // since a tab switch raises focus AND visibilitychange.
    for (let i = 0; i < 8; i += 1) requestAmbientDatabasePull()
    await flushDatabaseMode()
    expect(pulls(calls)).toBe(0)

    await vi.advanceTimersByTimeAsync(30_000)
    await flushDatabaseMode()
    expect(pulls(calls)).toBe(1)
  })

  it("pulls immediately once the gap has passed", async () => {
    vi.useFakeTimers()
    const { source, calls } = stubSource(seeded())
    await boot({ source })

    await vi.advanceTimersByTimeAsync(30_000)
    requestAmbientDatabasePull()
    await flushDatabaseMode()
    expect(pulls(calls)).toBe(1)
  })

  it("nothing is dropped — a later burst still gets its own pull", async () => {
    vi.useFakeTimers()
    const { source, calls } = stubSource(seeded())
    await boot({ source })

    requestAmbientDatabasePull()
    await vi.advanceTimersByTimeAsync(30_000)
    await flushDatabaseMode()
    expect(pulls(calls)).toBe(1)

    requestAmbientDatabasePull()
    await vi.advanceTimersByTimeAsync(30_000)
    await flushDatabaseMode()
    expect(pulls(calls)).toBe(2)
  })

  it("a deliberate pull is never coalesced — the sync button answers now", async () => {
    vi.useFakeTimers()
    const { source, calls } = stubSource(seeded())
    await boot({ source })

    // Inside the gap, where an ambient trigger would only schedule one.
    requestDatabasePull()
    await flushDatabaseMode()
    expect(pulls(calls)).toBe(1)
  })
})

/**
 * Views are gone (docs/removing-views.md): the log may still carry view
 * events as history, the cache holds no row for them, and no edit writes a
 * view event.
 */
describe("database mode, no views", () => {
  it("boots past the view events a log still carries, and deleting a note writes no view event", async () => {
    const viewEvent: LoggedEvent = {
      id: "evt_remote_view",
      seq: 2,
      entity: "view",
      entity_id: "note-a",
      action: "create",
      patch: { root_id: "note-a", filter: null, sort: null, pinned: true, sort_key: null },
      batch: "bat_remote_view",
      device: "other.tab",
      at: 2_000,
      tz: 0,
      v: 1,
      origin: "replica",
      actor: 111,
      received_at: 2_000,
    }
    const { source } = stubSource({ events: [placed(1, "note-a", "A"), viewEvent] })
    const store = await boot({ source, replica: stubReplica().handle })
    expect(jotai.get(databaseGraphAtom).nodes.has("note-a")).toBe(true)
    databaseApplyOps(deleteNoteOps("note-a", jotai.get(databaseGraphAtom)))
    await flushDatabaseMode()
    expect(ofEntity(await store.unpushedEvents(), "view")).toEqual([])
  })
})
