import { getDefaultStore } from "jotai"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { ReplicaChangesBody, ReplicaCorpusBody } from "../../worker/handlers/replica-payload"
import type { NoteId } from "../schema"
import {
  databaseFilesAtom,
  databaseModeStatusAtom,
  databaseWriteFiles,
  databaseDeleteFile,
  flushDatabaseMode,
  isDatabaseModeActive,
  requestDatabasePull,
  startDatabaseMode,
  stopDatabaseMode,
} from "./database-mode"
import type { D1NoteSource } from "./d1-note-source"
import { viewStatePath } from "./paths"
import type { ReplicaSyncHandle } from "./replica-sync"
import { createNodeSqlDriver } from "./sql-node-test-driver"
import { openSqlNoteStore, type SqlNoteStore } from "./sql-note-store"

/**
 * Boot-flow tests for database-authoritative mode, at the highest level the
 * node harness allows: a REAL SqlNoteStore (node:sqlite, same migration as
 * production), with only the network (D1 source) and the push loop stubbed.
 */

function stubReplica(pending: NoteId[] = []) {
  const calls = { changed: [] as NoteId[], deleted: [] as NoteId[], stopped: false }
  const handle: ReplicaSyncHandle = {
    notifyNotesChanged: (ids) => calls.changed.push(...ids),
    notifyNotesDeleted: (ids) => calls.deleted.push(...ids),
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
      const full = responses.full ?? { notes: [], cursor: null }
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

const pullNote = (id: string, content: string, view_state: string[] = []) => ({
  note: { id, content, updated_at: null },
  view_state,
})

async function boot(options: {
  store?: SqlNoteStore
  source: D1NoteSource
  replica?: ReplicaSyncHandle | null
}) {
  const store = options.store ?? (await openSqlNoteStore(createNodeSqlDriver()))
  startDatabaseMode({
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
const status = () => jotai.get(databaseModeStatusAtom)

afterEach(async () => {
  stopDatabaseMode()
  await flushDatabaseMode()
  vi.restoreAllMocks()
})

describe("database mode boot", () => {
  it("first boot: full pull populates the store, the files atom, and the cursor", async () => {
    const { source, calls } = stubSource({
      full: {
        notes: [pullNote("note-a", "- A\n", ["blk_1"]), pullNote("note-b", "- B\n")],
        cursor: "1000",
      },
    })
    const store = await boot({ source })

    expect(calls.full).toBe(1)
    expect(await store.getAllNotes()).toEqual({ "note-a": "- A\n", "note-b": "- B\n" })
    expect(await store.getViewState("note-a")).toEqual(["blk_1"])
    expect(await store.getMeta("d1_pull_cursor")).toBe("1000")
    // The files atom carries the repo-file-shaped map every consumer reads.
    expect(files()).toEqual({
      "note-a.md": "- A\n",
      "note-b.md": "- B\n",
      [viewStatePath("note-a")]: '[\n  "blk_1"\n]',
    })
    expect(status()).toMatchObject({ status: "ready", pull: "idle", emptyOffline: false })
    expect(isDatabaseModeActive()).toBe(true)
  })

  it("later boots serve local contents and pull with the stored cursor", async () => {
    const seeded = await openSqlNoteStore(createNodeSqlDriver())
    await seeded.writeNotes({ "note-a": "- local A\n" })
    await seeded.setMeta("d1_pull_cursor", "500")

    const { source, calls } = stubSource({
      since: () => ({
        changed: [pullNote("note-b", "- B\n")],
        ids: ["note-a", "note-b"],
        cursor: "600",
      }),
    })
    const store = await boot({ store: seeded, source })

    expect(calls.full).toBe(0)
    expect(calls.since).toEqual(["500"])
    expect(await store.getAllNotes()).toEqual({ "note-a": "- local A\n", "note-b": "- B\n" })
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
  it("a save writes the SQL store, updates the atom, and marks the push queue", async () => {
    const { source } = stubSource({ full: { notes: [], cursor: null } })
    const { handle, calls } = stubReplica()
    const store = await boot({ source, replica: handle })

    databaseWriteFiles({ "note-a.md": "- hello\n" })
    expect(files()["note-a.md"]).toBe("- hello\n") // optimistic, pre-flush
    await flushDatabaseMode()

    expect(await store.getNote("note-a")).toBe("- hello\n")
    expect(calls.changed).toEqual(["note-a"])
    expect(calls.deleted).toEqual([])
  })

  it("view-state sidecar writes persist collapse state and ride the note's push", async () => {
    const { source } = stubSource({ full: { notes: [pullNote("note-a", "- A\n")], cursor: null } })
    const { handle, calls } = stubReplica()
    const store = await boot({ source, replica: handle })

    databaseWriteFiles({ [viewStatePath("note-a")]: '["blk_2","blk_1"]' })
    await flushDatabaseMode()

    expect(await store.getViewState("note-a")).toEqual(["blk_1", "blk_2"])
    expect(files()[viewStatePath("note-a")]).toBe('[\n  "blk_1",\n  "blk_2"\n]')
    expect(calls.changed).toEqual(["note-a"])
  })

  it("a delete removes the note (and its view state) and marks the delete queue", async () => {
    const { source } = stubSource({
      full: { notes: [pullNote("note-a", "- A\n", ["blk_1"])], cursor: null },
    })
    const { handle, calls } = stubReplica()
    const store = await boot({ source, replica: handle })

    databaseDeleteFile("note-a.md")
    await flushDatabaseMode()

    expect(await store.getNote("note-a")).toBeNull()
    expect(await store.getViewState("note-a")).toEqual([])
    expect(files()).toEqual({})
    expect(calls.deleted).toEqual(["note-a"])
  })
})

describe("database mode since-pulls", () => {
  it("applies remote changes and detects deletions via the ids list", async () => {
    const { source } = stubSource({
      full: {
        notes: [pullNote("keep", "- keep\n"), pullNote("gone", "- gone\n")],
        cursor: "100",
      },
      since: () => ({
        changed: [pullNote("keep", "- keep v2\n")],
        ids: ["keep"], // "gone" was deleted on another device
        cursor: "200",
      }),
    })
    const store = await boot({ source })

    requestDatabasePull()
    await flushDatabaseMode()

    expect(await store.getAllNotes()).toEqual({ keep: "- keep v2\n" })
    expect(files()).toEqual({ "keep.md": "- keep v2\n" })
    expect(await store.getMeta("d1_pull_cursor")).toBe("200")
  })

  it("never clobbers notes with queued local pushes (last-writer-wins by push)", async () => {
    const { source } = stubSource({
      full: { notes: [pullNote("note-a", "- original\n")], cursor: "100" },
      since: () => ({
        changed: [pullNote("note-a", "- remote edit\n")],
        ids: ["note-a"], // the locally created note is unknown remotely
        cursor: "200",
      }),
    })
    const { handle } = stubReplica(["note-a", "created"])
    const store = await boot({ source, replica: handle })

    databaseWriteFiles({ "note-a.md": "- local edit\n", "created.md": "- brand new\n" })
    await flushDatabaseMode()
    requestDatabasePull()
    await flushDatabaseMode()

    // The pull neither reverted the local edit nor deleted the unpushed note.
    expect(await store.getNote("note-a")).toBe("- local edit\n")
    expect(await store.getNote("created")).toBe("- brand new\n")
  })
})

describe("database mode lifecycle", () => {
  it("stop closes the store, stops the push loop, and resets the atoms", async () => {
    const { source } = stubSource({ full: { notes: [pullNote("a", "- A\n")], cursor: null } })
    const { handle, calls } = stubReplica()
    const store = await boot({ source, replica: handle })
    const close = vi.spyOn(store, "close")

    stopDatabaseMode()
    await flushDatabaseMode()

    expect(calls.stopped).toBe(true)
    expect(close).toHaveBeenCalled()
    expect(files()).toEqual({})
    expect(status().status).toBe("off")
    expect(isDatabaseModeActive()).toBe(false)
  })
})
