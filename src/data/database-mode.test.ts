import { getDefaultStore } from "jotai"
import { afterEach, describe, expect, it, vi } from "vitest"
import type {
  GraphDiff,
  ReplicaChangesBody,
  ReplicaCorpusBody,
} from "../../worker/handlers/replica-payload"
import type { NoteId } from "../schema"
import { parse } from "../blocks/parse"
import { serialize } from "../blocks/serialize"
import { docToOps } from "./ops"
import {
  CACHE_GENERATION,
  EMPTY_GRAPH,
  databaseFilesAtom,
  databaseGraphAtom,
  databaseModeStatusAtom,
  databaseApplyOps,
  databaseWriteFiles,
  databaseDeleteFile,
  flushDatabaseMode,
  isDatabaseModeActive,
  requestAmbientDatabasePull,
  requestDatabasePull,
  startDatabaseMode,
  stopDatabaseMode,
} from "./database-mode"
import type { D1NoteSource } from "./d1-note-source"
import { docToGraph, pageDoc } from "./graph"
import type { ReplicaSyncHandle } from "./replica-sync"
import { createNodeSqlDriver } from "./sql-node-test-driver"
import { openSqlNoteStore, type SqlNoteStore } from "./sql-note-store"

/**
 * Boot-flow tests for database-authoritative mode, at the highest level the
 * node harness allows: a REAL SqlNoteStore (node:sqlite, same migrations as
 * production), with only the network (D1 source) and the push loop stubbed.
 */

function stubReplica(pending: NoteId[] = []) {
  const calls = { changes: [] as { noteIds: NoteId[]; diff: GraphDiff }[], stopped: false }
  const handle: ReplicaSyncHandle = {
    notifyGraphChange: (noteIds, diff) => calls.changes.push({ noteIds, diff }),
    requestFullPush: () => {},
    refreshRemoteStatus: () => {},
    pendingNoteIds: () => new Set(pending),
    stop: () => {
      calls.stopped = true
    },
    flush: () => Promise.resolve(),
  }
  return { handle, calls }
}

function stubSource(responses: {
  full?: ReplicaCorpusBody | (() => ReplicaCorpusBody)
  since?: (cursor: string) => ReplicaChangesBody
  fail?: boolean
}) {
  const calls = { full: 0, since: [] as string[] }
  const source: D1NoteSource = {
    pullFull: async () => {
      calls.full += 1
      if (responses.fail) throw new Error("offline")
      const full = responses.full ?? { nodes: [], links: [], cursor: null }
      return typeof full === "function" ? full() : full
    },
    pullSince: async (cursor) => {
      calls.since.push(cursor)
      if (responses.fail) throw new Error("offline")
      if (!responses.since) throw new Error("unexpected since-pull")
      return responses.since(cursor)
    },
  }
  return { source, calls }
}

/** Remote row corpus built from note markdown — what a real replica holds. */
function remoteCorpus(notes: Record<string, string>, updatedAt = 1, cursor: string | null = null) {
  const body: ReplicaCorpusBody = { nodes: [], links: [], cursor }
  for (const [id, markdown] of Object.entries(notes)) {
    const { nodes, links } = docToGraph(id, markdown, updatedAt)
    body.nodes.push(...nodes)
    body.links.push(...links)
  }
  return body
}

/** The since-pull shape: only the rows that changed, plus the new cursor. */
function remoteChanges(
  changed: Record<string, string>,
  updatedAt: number,
  cursor: string,
): ReplicaChangesBody {
  return { ...remoteCorpus(changed, updatedAt), cursor }
}

/** Every row of these notes, tombstoned — how a remote delete travels. */
function remoteDeletion(
  deleted: Record<string, string>,
  updatedAt: number,
  cursor: string,
): ReplicaChangesBody {
  const body = remoteCorpus(deleted, updatedAt)
  return {
    nodes: body.nodes.map((node) => ({ ...node, deleted_at: updatedAt })),
    links: body.links.map((link) => ({ ...link, deleted_at: updatedAt })),
    cursor,
  }
}

/** Seed a store that a CURRENT client would have left behind: notes, a pull
 * cursor, and this release's cache generation (see CACHE_GENERATION). */
async function boot(options: {
  store?: SqlNoteStore
  source: D1NoteSource
  replica?: ReplicaSyncHandle | null
  owner?: string
}) {
  const store = options.store ?? (await openSqlNoteStore(createNodeSqlDriver()))
  startDatabaseMode({
    owner: options.owner,
    openStore: async () => ({ store, persistence: "memory" }),
    openReplicaSync: async () => options.replica ?? null,
    source: options.source,
    pullRetryMs: 10 * 60_000, // effectively disabled; stop() clears the timer
  })
  await flushDatabaseMode()
  return store
}

const jotai = getDefaultStore()
const files = () => jotai.get(databaseFilesAtom)
const graph = () => jotai.get(databaseGraphAtom)
/** The note's doc as the graph atom holds it, as bytes (or null). */
const walked = (id: string) => {
  const doc = pageDoc(id, graph())
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

/** The generation `database-mode.ts` expects a local cache to carry. */

/** A local store as the current app leaves it: rows, a cursor, and the cache
 * generation those rows belong to. */
async function seededStore(
  notes: Record<string, string>,
  cursor = "500",
  generation: string = CACHE_GENERATION,
  owner?: string,
) {
  const store = await openSqlNoteStore(createNodeSqlDriver())
  await store.writeNotes(notes)
  await store.setMeta("d1_pull_cursor", cursor)
  await store.setMeta("cache_generation", generation)
  if (owner !== undefined) await store.setMeta("store_owner", owner)
  return store
}

describe("database mode boot", () => {
  it("first boot: full pull populates the store, the files atom, and the cursor", async () => {
    const { source, calls } = stubSource({
      full: remoteCorpus({ "note-a": NOTE_A, "note-b": NOTE_B }, 1, "1000"),
    })
    const store = await boot({ source })

    expect(calls.full).toBe(1)
    expect(await store.getAllNotes()).toEqual({ "note-a": NOTE_A, "note-b": NOTE_B })
    expect(await store.getMeta("d1_pull_cursor")).toBe("1000")
    // The files atom carries the repo-file-shaped map every consumer reads.
    expect(files()).toEqual({ "note-a.md": NOTE_A, "note-b.md": NOTE_B })
    expect(status()).toMatchObject({ status: "ready", pull: "idle", emptyOffline: false })
    expect(isDatabaseModeActive()).toBe(true)
  })

  it("later boots serve local contents and pull with the stored cursor", async () => {
    const seeded = await seededStore({ "note-a": "- local A\n  id:: blk_a000000000\n" }, "500")

    const { source, calls } = stubSource({
      since: () => remoteChanges({ "note-b": NOTE_B }, 600, "600"),
    })
    const store = await boot({ store: seeded, source })

    expect(calls.full).toBe(0)
    expect(calls.since).toEqual(["500"])
    expect(await store.getAllNotes()).toEqual({
      "note-a": "- local A\n  id:: blk_a000000000\n",
      "note-b": NOTE_B,
    })
    expect(await store.getMeta("d1_pull_cursor")).toBe("600")
  })

  it("first-ever boot offline: empty state flagged, cleared by the first write", async () => {
    const { source } = stubSource({ fail: true })
    await boot({ source })

    expect(status()).toMatchObject({ status: "ready", pull: "error", emptyOffline: true })
    expect(status().lastPullError).toBe("offline")
    expect(files()).toEqual({})

    databaseWriteFiles({ "first.md": "- written offline\n" })
    expect(status().emptyOffline).toBe(false)
    expect(files()["first.md"]).toBe("- written offline\n")
  })
})

describe("database mode saves", () => {
  it("a save writes the SQL store, updates the atom, and hands its diff to the push queue", async () => {
    const { source } = stubSource({})
    const { handle, calls } = stubReplica()
    const store = await boot({ source, replica: handle })

    databaseWriteFiles({ "note-a.md": "- hello\n  id:: blk_a000000000\n" })
    expect(files()["note-a.md"]).toBe("- hello\n  id:: blk_a000000000\n") // optimistic, pre-flush
    await flushDatabaseMode()

    expect(await store.getNote("note-a")).toBe("- hello\n  id:: blk_a000000000\n")
    expect(calls.changes).toHaveLength(1)
    expect(calls.changes[0].noteIds).toEqual(["note-a"])
    const diff = calls.changes[0].diff
    expect(diff.nodes.map((node) => node.id).sort()).toEqual(["blk_a000000000", "note-a"])
    expect(diff.links).toHaveLength(1)
    expect(diff.deleteNodes).toEqual([])
  })

  it("a delete tombstones the note's rows and pushes the tombstones", async () => {
    const { source } = stubSource({ full: remoteCorpus({ "note-a": NOTE_A }) })
    const { handle, calls } = stubReplica()
    const store = await boot({ source, replica: handle })

    databaseDeleteFile("note-a.md")
    await flushDatabaseMode()

    expect(await store.getNote("note-a")).toBeNull()
    expect(files()).toEqual({})
    // Deleted rows travel as ordinary rows carrying `deleted_at` — that is how
    // the delete reaches another device — and they all share one stamp.
    const diff = calls.changes[0].diff
    expect(diff.deleteNodes).toEqual([])
    const tombstoned = diff.nodes.filter((node) => node.deleted_at !== undefined)
    expect(tombstoned.map((node) => node.id).sort()).toEqual(["blk_a000000000", "note-a"])
    expect(new Set(tombstoned.map((node) => node.deleted_at)).size).toBe(1)
  })

  it("ops apply to the graph atom at once and land as rows after the coalescing window", async () => {
    const { source } = stubSource({ full: remoteCorpus({ "note-a": NOTE_A }) })
    const { handle, calls } = stubReplica()
    const store = await boot({ source, replica: handle })
    expect(walked("note-a")).toBe(NOTE_A)

    const edited = "- A edited\n  id:: blk_a000000000\n- new\n  id:: blk_n000000000\n"
    databaseApplyOps(docToOps("note-a", parse(edited), graph()))
    // On screen at once…
    expect(walked("note-a")).toBe(edited)
    // …in the store and the files map only once the run is written.
    expect(await store.getNote("note-a")).toBe(NOTE_A)
    expect(files()["note-a.md"]).toBe(NOTE_A)
    await flushDatabaseMode()

    expect(await store.getNote("note-a")).toBe(edited)
    expect(files()["note-a.md"]).toBe(edited)
    expect(walked("note-a")).toBe(edited)
    expect(calls.changes).toHaveLength(1)
    expect(calls.changes[0].noteIds).toEqual(["note-a"])
    expect(calls.changes[0].diff.nodes.map((node) => node.id).sort()).toEqual([
      "blk_a000000000",
      "blk_n000000000",
    ])
  })

  it("a run of ops is one store write, and a markdown write never lands behind it", async () => {
    const { source } = stubSource({ full: remoteCorpus({ "note-a": NOTE_A }) })
    const { handle, calls } = stubReplica()
    const store = await boot({ source, replica: handle })

    databaseApplyOps([{ op: "setText", id: "blk_a000000000", text: "A1" }])
    databaseApplyOps([{ op: "setText", id: "blk_a000000000", text: "A12" }])
    databaseApplyOps([{ op: "setText", id: "blk_a000000000", text: "A123" }])
    // A markdown write queued meanwhile flushes the ops first, so the store
    // is never rebuilt or read behind what the screen shows.
    databaseWriteFiles({ "note-b.md": NOTE_B })
    await flushDatabaseMode()

    expect(await store.getNote("note-a")).toBe("- A123\n  id:: blk_a000000000\n")
    expect(await store.getNote("note-b")).toBe(NOTE_B)
    expect(walked("note-a")).toBe("- A123\n  id:: blk_a000000000\n")
    expect(calls.changes.map((change) => change.noteIds)).toEqual([["note-a"], ["note-b"]])
  })

  it("a pull never clobbers ops still coalescing", async () => {
    const { source } = stubSource({
      full: remoteCorpus({ "note-a": NOTE_A }, 1, "100"),
      since: () => remoteChanges({ "note-b": NOTE_B }, 200, "200"),
    })
    // The push queue reports note-a pending only once the edit is made.
    const pending: NoteId[] = []
    const { handle } = stubReplica(pending)
    const store = await boot({ source, replica: handle })

    databaseApplyOps([{ op: "setText", id: "blk_a000000000", text: "typed" }])
    pending.push("note-a")
    requestDatabasePull()
    await flushDatabaseMode()

    expect(walked("note-a")).toBe("- typed\n  id:: blk_a000000000\n")
    expect(await store.getNote("note-a")).toBe("- typed\n  id:: blk_a000000000\n")
    expect(walked("note-b")).toBe(NOTE_B)
  })

  it("removing a page's last block through ops tombstones the rows", async () => {
    const { source } = stubSource({ full: remoteCorpus({ "note-a": NOTE_A }) })
    const { handle, calls } = stubReplica()
    const store = await boot({ source, replica: handle })

    databaseApplyOps(docToOps("note-a", parse(""), graph()))
    expect(walked("note-a")).toBe(serialize(parse("")))
    await flushDatabaseMode()

    expect(await store.getNote("note-a")).toBe(serialize(parse("")))
    expect(files()["note-a.md"]).toBe(serialize(parse("")))
    expect(calls.changes[0].diff.nodes.map((n) => [n.id, n.deleted_at != null])).toEqual([
      ["blk_a000000000", true],
    ])
  })

  it("the graph atom follows pulls and file writes too", async () => {
    const { source } = stubSource({
      full: remoteCorpus({ "note-a": NOTE_A }, 1, "100"),
      since: () => remoteChanges({ "note-b": NOTE_B }, 200, "200"),
    })
    await boot({ source, replica: null })
    expect(walked("note-a")).toBe(NOTE_A)
    expect(walked("note-b")).toBeNull()

    databaseWriteFiles({ "note-c.md": "- C\n  id:: blk_c000000000\n" })
    await flushDatabaseMode()
    expect(walked("note-c")).toBe("- C\n  id:: blk_c000000000\n")

    requestDatabasePull()
    await flushDatabaseMode()
    expect(walked("note-b")).toBe(NOTE_B)
  })

  it("non-note file writes are dropped (nothing else lives in the graph)", async () => {
    const { source } = stubSource({})
    const { handle, calls } = stubReplica()
    await boot({ source, replica: handle })

    databaseWriteFiles({ ".ruminate/view-state/x.json": "[]" })
    await flushDatabaseMode()
    expect(files()).toEqual({})
    expect(calls.changes).toEqual([])
  })
})

describe("database mode since-pulls", () => {
  it("applies remote row changes", async () => {
    const KEEP_V2 = "- keep v2\n  id:: blk_keep000000\n"
    const { source } = stubSource({
      full: remoteCorpus({ keep: "- keep\n  id:: blk_keep000000\n" }, 1, "100"),
      since: () => remoteChanges({ keep: KEEP_V2 }, 200, "200"),
    })
    const store = await boot({ source })

    requestDatabasePull()
    await flushDatabaseMode()

    expect(await store.getAllNotes()).toEqual({ keep: KEEP_V2 })
    expect(files()).toEqual({ "keep.md": KEEP_V2 })
    expect(await store.getMeta("d1_pull_cursor")).toBe("200")
  })

  it("a remote deletion arrives as tombstoned rows — no key list needed", async () => {
    // The property that makes dropping the key lists safe: the since-pull
    // says nothing at all about `keep` (unchanged, so not a change), and
    // `gone` disappears purely because its rows came back carrying
    // `deleted_at`.
    const KEEP = "- keep\n  id:: blk_keep000000\n"
    const GONE = "- gone\n  id:: blk_gone000000\n"
    const { source } = stubSource({
      full: remoteCorpus({ keep: KEEP, gone: GONE }, 1, "100"),
      since: () => remoteDeletion({ gone: GONE }, 200, "200"),
    })
    const store = await boot({ source })
    expect(await store.getAllNotes()).toEqual({ keep: KEEP, gone: GONE })

    requestDatabasePull()
    await flushDatabaseMode()

    expect(await store.getAllNotes()).toEqual({ keep: KEEP })
    expect(files()).toEqual({ "keep.md": KEEP })
    expect(await store.getMeta("d1_pull_cursor")).toBe("200")
  })

  it("a since-pull that mentions nothing changes nothing (silence is not deletion)", async () => {
    const KEEP = "- keep\n  id:: blk_keep000000\n"
    const { source } = stubSource({
      full: remoteCorpus({ keep: KEEP }, 1, "100"),
      since: () => remoteChanges({}, 200, "200"),
    })
    const store = await boot({ source })

    requestDatabasePull()
    await flushDatabaseMode()

    expect(await store.getAllNotes()).toEqual({ keep: KEEP })
  })

  it("never clobbers notes with queued local pushes (last-writer-wins by push)", async () => {
    const LOCAL_EDIT = "- local edit\n  id:: blk_a000000000\n"
    const CREATED = "- brand new\n  id:: blk_new0000000\n"
    const REMOTE_EDIT = "- remote edit\n  id:: blk_a000000000\n"
    const { source } = stubSource({
      full: remoteCorpus({ "note-a": "- original\n  id:: blk_a000000000\n" }, 1, "100"),
      // The locally created note is unknown remotely.
      since: () => remoteChanges({ "note-a": REMOTE_EDIT }, 9999, "200"),
    })
    const { handle } = stubReplica(["note-a", "created"])
    const store = await boot({ source, replica: handle })

    databaseWriteFiles({ "note-a.md": LOCAL_EDIT, "created.md": CREATED })
    await flushDatabaseMode()
    requestDatabasePull()
    await flushDatabaseMode()

    // The pull neither reverted the local edit nor deleted the unpushed note.
    expect(await store.getNote("note-a")).toBe(LOCAL_EDIT)
    expect(await store.getNote("created")).toBe(CREATED)
  })
})

describe("database mode lifecycle", () => {
  it("stop closes the store, stops the push loop, and resets the atoms", async () => {
    const { source } = stubSource({ full: remoteCorpus({ a: NOTE_A }) })
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
 * The local store is a CACHE of D1, never a source of truth, so it is never
 * data-migrated: a copy from an older generation is discarded and rebuilt by a
 * full pull. This is what stops a device that predates a server-side migration
 * merging its stale rows with the pulled, migrated ones.
 */
describe("cache generation", () => {
  it("a stale generation wipes the local copy and re-pulls in full", async () => {
    const seeded = await seededStore({ "note-a": NOTE_A }, "500", "1")

    const { source, calls } = stubSource({
      full: remoteCorpus({ "note-b": NOTE_B }, 1, "900"),
    })
    const store = await boot({ store: seeded, source })

    // The stale cursor went with the rows, so the pull was a FULL one — the
    // whole point: a since-pull would have merged two generations.
    expect(calls.full).toBe(1)
    expect(calls.since).toEqual([])
    expect(await store.getAllNotes()).toEqual({ "note-b": NOTE_B })
    expect(files()).toEqual({ "note-b.md": NOTE_B })
    expect(await store.getMeta("cache_generation")).toBe(CACHE_GENERATION)
    expect(await store.getMeta("d1_pull_cursor")).toBe("900")
  })

  it("a matching generation leaves the local copy and its cursor alone", async () => {
    const seeded = await seededStore({ "note-a": NOTE_A })

    const { source, calls } = stubSource({
      since: (cursor) => remoteChanges({}, 2, cursor),
    })
    const store = await boot({ store: seeded, source })

    expect(calls.full).toBe(0)
    expect(calls.since).toEqual(["500"])
    expect(await store.getAllNotes()).toEqual({ "note-a": NOTE_A })
  })

  it("a fresh store boots normally and records the generation", async () => {
    const { source, calls } = stubSource({
      full: remoteCorpus({ "note-a": NOTE_A }, 1, "1000"),
    })
    const store = await boot({ source })

    expect(calls.full).toBe(1)
    expect(await store.getAllNotes()).toEqual({ "note-a": NOTE_A })
    expect(await store.getMeta("cache_generation")).toBe(CACHE_GENERATION)
    expect(await store.getMeta("d1_pull_cursor")).toBe("1000")
  })

  it("keeps the owner binding intact across a generation wipe", async () => {
    // The two wipes are independent: bumping the generation must not sign the
    // browser out of its own cache and re-wipe it on the next boot.
    const seeded = await seededStore({ "note-a": NOTE_A }, "500", "1")
    await seeded.setMeta("store_owner", "42")

    const { source } = stubSource({ full: { nodes: [], links: [], cursor: null } })
    const store = await boot({ store: seeded, source, owner: "42" })

    expect(await store.getMeta("store_owner")).toBe("42")
    expect(await store.getAllNotes()).toEqual({})
  })
})

describe("owner binding", () => {
  it("records the owner on first boot", async () => {
    const { source } = stubSource({ full: remoteCorpus({ "note-a": NOTE_A }, 1, "1000") })
    const store = await boot({ source, owner: "42" })
    expect(await store.getMeta("store_owner")).toBe("42")
    expect(await store.getAllNotes()).toEqual({ "note-a": NOTE_A })
  })

  it("the same owner keeps the local cache and cursor (since-pull, no wipe)", async () => {
    const seeded = await seededStore({ "note-a": NOTE_A }, "500", CACHE_GENERATION, "42")

    const { source, calls } = stubSource({ since: (cursor) => remoteChanges({}, 2, cursor) })
    const store = await boot({ store: seeded, source, owner: "42" })
    expect(calls.since).toEqual(["500"])
    expect(calls.full).toBe(0)
    expect(await store.getAllNotes()).toEqual({ "note-a": NOTE_A })
  })

  it("a different signed-in identity wipes the local cache before anything renders", async () => {
    const seeded = await seededStore({ "note-a": NOTE_A }, "500", CACHE_GENERATION, "42")

    // A different account signs in on this browser: the previous owner's
    // rows and cursor are gone, the pull starts from scratch (and for a
    // non-owner the replica would 403 — an empty corpus, never leaked notes).
    const { source, calls } = stubSource({ full: { nodes: [], links: [], cursor: null } })
    const store = await boot({ store: seeded, source, owner: "7" })
    expect(await store.getMeta("store_owner")).toBe("7")
    expect(calls.full).toBe(1)
    expect(calls.since).toEqual([])
    expect(await store.getAllNotes()).toEqual({})
    expect(files()).toEqual({})
  })

  it("an ownerless boot leaves an owned store untouched", async () => {
    const seeded = await seededStore({ "note-a": NOTE_A }, "500", CACHE_GENERATION, "42")

    const { source } = stubSource({ since: (cursor) => remoteChanges({}, 2, cursor) })
    const store = await boot({ store: seeded, source })
    expect(await store.getMeta("store_owner")).toBe("42")
    expect(await store.getAllNotes()).toEqual({ "note-a": NOTE_A })
  })
})

describe("cache generation", () => {
  it("a cache from an older generation is discarded and re-pulled in full", async () => {
    // A store left by a client that predates this release: no generation
    // stamp, and possibly rows the replica hard-deleted before tombstones
    // existed — which nothing would ever tell this client about again.
    const stale = await openSqlNoteStore(createNodeSqlDriver())
    await stale.writeNotes({ "note-a": NOTE_A, purged: "- purged\n  id:: blk_purged000\n" })
    await stale.setMeta("d1_pull_cursor", "500")

    const { source, calls } = stubSource({ full: remoteCorpus({ "note-a": NOTE_A }, 1, "900") })
    const store = await boot({ store: stale, source })

    expect(calls.since).toEqual([]) // the cursor went with the cache
    expect(calls.full).toBe(1)
    expect(await store.getAllNotes()).toEqual({ "note-a": NOTE_A })
    expect(files()).toEqual({ "note-a.md": NOTE_A })
    expect(await store.getMeta("cache_generation")).toBe(CACHE_GENERATION)
    expect(await store.getMeta("d1_pull_cursor")).toBe("900")
  })

  it("a cache of the current generation is kept (the wipe happens once)", async () => {
    const seeded = await seededStore({ "note-a": NOTE_A }, "500")

    const { source, calls } = stubSource({ since: (cursor) => remoteChanges({}, 2, cursor) })
    const store = await boot({ store: seeded, source })

    expect(calls.full).toBe(0)
    expect(calls.since).toEqual(["500"])
    expect(await store.getAllNotes()).toEqual({ "note-a": NOTE_A })
  })
})

/**
 * Ambient pull coalescing. `focus`, `visibilitychange` and `online` fire on
 * every alt-tab, in pairs, for every open tab — wired straight to a pull they
 * spent 61% of a day's D1 read budget learning nothing. The gap is the fix;
 * these tests are what stop it being quietly removed.
 */
describe("ambient pull coalescing", () => {
  const seeded = () => ({
    full: remoteCorpus({ keep: "- keep\n  id:: blk_keep000000\n" }, 1, "100"),
    since: () => remoteChanges({}, 200, "200"),
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("collapses a burst of triggers into a single pull", async () => {
    vi.useFakeTimers()
    const { source, calls } = stubSource(seeded())
    await boot({ source })
    expect(calls.since).toHaveLength(0)

    // Four alt-tabs in quick succession — eight events in the real browser,
    // since a tab switch raises focus AND visibilitychange.
    for (let i = 0; i < 8; i += 1) requestAmbientDatabasePull()
    await flushDatabaseMode()
    expect(calls.since).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(30_000)
    await flushDatabaseMode()
    expect(calls.since).toHaveLength(1)
  })

  it("pulls immediately once the gap has passed", async () => {
    vi.useFakeTimers()
    const { source, calls } = stubSource(seeded())
    await boot({ source })

    await vi.advanceTimersByTimeAsync(30_000)
    requestAmbientDatabasePull()
    await flushDatabaseMode()
    expect(calls.since).toHaveLength(1)
  })

  it("nothing is dropped — a later burst still gets its own pull", async () => {
    vi.useFakeTimers()
    const { source, calls } = stubSource(seeded())
    await boot({ source })

    requestAmbientDatabasePull()
    await vi.advanceTimersByTimeAsync(30_000)
    await flushDatabaseMode()
    expect(calls.since).toHaveLength(1)

    requestAmbientDatabasePull()
    await vi.advanceTimersByTimeAsync(30_000)
    await flushDatabaseMode()
    expect(calls.since).toHaveLength(2)
  })

  it("a deliberate pull is never coalesced — the sync button answers now", async () => {
    vi.useFakeTimers()
    const { source, calls } = stubSource(seeded())
    await boot({ source })

    // Inside the gap, where an ambient trigger would only schedule one.
    requestDatabasePull()
    await flushDatabaseMode()
    expect(calls.since).toHaveLength(1)
  })
})
