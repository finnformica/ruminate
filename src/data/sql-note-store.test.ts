// tenant-guard: exempt — these tests read and seed raw storage on purpose
// (that is how they pin what the store wrote, tombstones included).
import { describe, expect, it } from "vitest"
import migration0001 from "../../migrations/0001_init.sql?raw"
import migration0002 from "../../migrations/0002_nodes.sql?raw"
import { parse } from "../blocks/parse"
import type { BlockProps } from "../blocks/types"
import { linkEntityId, opsToEvents, viewChangeToEvent, type RuminateEvent } from "./events"
import { rollup } from "./graph"
import type { NoteStore } from "./note-store"
import { deleteBlockOps, deleteNoteOps, docToOps, type Op } from "./ops"
import { createNodeSqlDriver } from "./sql-node-test-driver"
import { openSqlNoteStore } from "./sql-note-store"
import { applyOpsToStore, testEventContext } from "./store-test-support"
import type { ViewRow } from "./views"

async function makeStoreWithDriver() {
  const driver = createNodeSqlDriver()
  const store = await openSqlNoteStore(driver)
  return { driver, store }
}

/** Save a note as the app does: diff the doc against the live graph into ops,
 * apply them as events. Markdown is only the fixture's spelling. Returns the
 * events the save amounted to. */
async function seed(
  store: NoteStore,
  id: string,
  markdown: string,
  props: BlockProps | null = null,
) {
  return applyOpsToStore(store, docToOps(id, { ...parse(markdown), props }, await store.getGraph()))
}

/** Ops as the runtime would hand them over. */
const applyOps = (store: NoteStore, ops: readonly Op[]) => applyOpsToStore(store, ops)

/** Events as `entity.action entity_id`, in order. */
const named = (events: readonly RuminateEvent[]) =>
  events.map((event) => `${event.entity}.${event.action} ${event.entity_id}`)

/** A note's markdown projection off the live graph, or null when absent. */
const noteOf = async (store: NoteStore, id: string) => rollup(id, await store.getGraph())

describe("openSqlNoteStore", () => {
  it("lands a saved note as typed node and link rows", async () => {
    const { driver, store } = await makeStoreWithDriver()
    await seed(store, "a", "# Hello\n  id:: blk_aaaaaaaaaa\n[ ] task\n  id:: blk_bbbbbbbbbb\n")

    const nodes = await driver.exec("SELECT id, type, text FROM nodes ORDER BY id")
    expect(nodes).toEqual([
      { id: "a", type: "note", text: "a" },
      { id: "blk_aaaaaaaaaa", type: "h1", text: "Hello" },
      { id: "blk_bbbbbbbbbb", type: "todo", text: "task" },
    ])

    const links = await driver.exec(
      "SELECT source_id, destination_id, kind FROM link ORDER BY sort_key",
    )
    expect(links).toEqual([
      { source_id: "a", destination_id: "blk_aaaaaaaaaa", kind: "child" },
      { source_id: "a", destination_id: "blk_bbbbbbbbbb", kind: "child" },
    ])
    expect(await noteOf(store, "a")).toBe(
      "# Hello\n  id:: blk_aaaaaaaaaa\n[ ] task\n  id:: blk_bbbbbbbbbb\n",
    )
  })

  it("writes only the rows the ops name: untouched rows keep their updated_at and sort keys", async () => {
    const { driver, store } = await makeStoreWithDriver()
    await seed(store, "a", "- one\n  id:: blk_aaaaaaaaaa\n- two\n  id:: blk_bbbbbbbbbb\n")
    const beforeLinks = await driver.exec(
      "SELECT destination_id, sort_key, updated_at FROM link ORDER BY destination_id",
    )
    const beforeOne = await driver.exec("SELECT * FROM nodes WHERE id = 'blk_aaaaaaaaaa'")

    // Touch only the second block.
    const events = await seed(
      store,
      "a",
      "- one\n  id:: blk_aaaaaaaaaa\n- two edited\n  id:: blk_bbbbbbbbbb\n",
    )
    expect(named(events)).toEqual(["block.update blk_bbbbbbbbbb"])
    expect(events[0].patch).toEqual({ text: "two edited" })

    // Link rows and the untouched node are byte-identical, updated_at included.
    expect(
      await driver.exec(
        "SELECT destination_id, sort_key, updated_at FROM link ORDER BY destination_id",
      ),
    ).toEqual(beforeLinks)
    expect(await driver.exec("SELECT * FROM nodes WHERE id = 'blk_aaaaaaaaaa'")).toEqual(beforeOne)
    expect(await driver.exec("SELECT text FROM nodes WHERE id = 'blk_bbbbbbbbbb'")).toEqual([
      { text: "two edited" },
    ])
  })

  it("an empty batch is a no-op (no events, no row churn)", async () => {
    const { store } = await makeStoreWithDriver()
    const content = "- one\n  id:: blk_aaaaaaaaaa\n  - two\n    id:: blk_bbbbbbbbbb\n"
    const first = await seed(store, "a", content)
    // An identical doc diffs to no ops at all, so nothing reaches the rows.
    expect(await seed(store, "a", content)).toEqual([])
    expect(await store.unpushedEvents()).toHaveLength(first.length)
  })

  it("drops a set on a node it does not hold (deleted underneath)", async () => {
    const { driver, store } = await makeStoreWithDriver()
    expect(await applyOps(store, [{ op: "setText", id: "blk_ghost00000", text: "boo" }])).toEqual(
      [],
    )
    expect(await driver.exec("SELECT COUNT(*) AS n FROM nodes")).toEqual([{ n: 0 }])
    expect(await store.unpushedEvents()).toEqual([])
  })

  it("removing a block from a note tombstones its link row and keeps its node (diffed)", async () => {
    const { driver, store } = await makeStoreWithDriver()
    await seed(store, "a", "- keep\n  id:: blk_aaaaaaaaaa\n- drop\n  id:: blk_bbbbbbbbbb\n")
    const events = await seed(store, "a", "- keep\n  id:: blk_aaaaaaaaaa\n")
    // An unlink, not a delete: the block is out of reach (the basket's), its
    // row live, and only the link's tombstone travels.
    expect(named(events)).toEqual([`link.delete ${linkEntityId("a", "blk_bbbbbbbbbb")}`])
    expect(await driver.exec("SELECT deleted_at FROM nodes WHERE id = 'blk_bbbbbbbbbb'")).toEqual([
      { deleted_at: null },
    ])
    expect(
      await driver.exec("SELECT deleted_at FROM link WHERE destination_id = 'blk_bbbbbbbbbb'"),
    ).toEqual([{ deleted_at: events[0].at }])
    expect(await noteOf(store, "a")).toBe("- keep\n  id:: blk_aaaaaaaaaa\n")
  })

  it("deleting a block tombstones its node and link rows (diffed)", async () => {
    const { driver, store } = await makeStoreWithDriver()
    await seed(store, "a", "- keep\n  id:: blk_aaaaaaaaaa\n- drop\n  id:: blk_bbbbbbbbbb\n")
    const events = await applyOps(store, deleteBlockOps("blk_bbbbbbbbbb", await store.getGraph()))
    // Nothing is removed: a delete is an event per row, and the rows stay as
    // tombstones, so the delete replicates like any other change.
    expect(named(events).sort()).toEqual([
      "block.delete blk_bbbbbbbbbb",
      `link.delete ${linkEntityId("a", "blk_bbbbbbbbbb")}`,
    ])
    expect(await driver.exec("SELECT deleted_at FROM nodes WHERE id = 'blk_bbbbbbbbbb'")).toEqual([
      { deleted_at: expect.any(Number) },
    ])
    expect(await noteOf(store, "a")).toBe("- keep\n  id:: blk_aaaaaaaaaa\n")
  })

  it("tombstones a note's rows on delete and reports the diff", async () => {
    const { driver, store } = await makeStoreWithDriver()
    await seed(store, "a", "# A note\n  id:: blk_aaaaaaaaaa\n")
    const events = await applyOps(store, deleteNoteOps("a", await store.getGraph()))

    const deletes = events.filter((event) => event.entity === "block")
    expect(deletes.map((event) => event.entity_id).sort()).toEqual(["a", "blk_aaaaaaaaaa"])
    expect(deletes.every((event) => event.action === "delete")).toBe(true)
    // ONE stamp for the whole delete: a future restore is "revive the rows
    // stamped at T".
    expect(new Set(deletes.map((event) => event.at)).size).toBe(1)
    expect(
      await driver.exec("SELECT DISTINCT deleted_at FROM nodes WHERE deleted_at IS NOT NULL"),
    ).toEqual([{ deleted_at: deletes[0].at }])
    expect(await noteOf(store, "a")).toBeNull()
    expect((await store.getGraph()).nodes.size).toBe(0)
    // The rows — and the link that positions the block under the note — are
    // still there, which is what makes a restore possible at all.
    expect(await driver.exec("SELECT COUNT(*) AS n FROM nodes")).toEqual([{ n: 2 }])
    expect(await driver.exec("SELECT COUNT(*) AS n FROM link")).toEqual([{ n: 1 }])
  })

  it("retitling a note rewrites exactly one row — the note's", async () => {
    const { driver, store } = await makeStoreWithDriver()
    const id = "blk_note00000"
    await seed(store, id, "keep me\n  id:: blk_aaaaaaaaaa\n", { title: "Old Name" })
    const before = await driver.exec("SELECT id, text, updated_at FROM nodes ORDER BY id")

    const events = await seed(store, id, "keep me\n  id:: blk_aaaaaaaaaa\n", { title: "New Name" })

    // ONE event, the note's: a rename can no longer bump `updated_at` on
    // blocks the user never touched, so it cannot clobber a concurrent edit
    // to one of them under per-row LWW.
    expect(named(events)).toEqual([`block.update ${id}`])
    expect(events[0].patch).toEqual({ text: "New Name" })

    // The id is untouched, so every deep link and block row still resolves.
    const after = await driver.exec("SELECT id, text, updated_at FROM nodes ORDER BY id")
    expect(after.map((row) => row.id)).toEqual(before.map((row) => row.id))
    expect(after.find((row) => row.id === "blk_aaaaaaaaaa")).toEqual(
      before.find((row) => row.id === "blk_aaaaaaaaaa"),
    )
    expect((await store.getGraph()).nodes.get(id)?.text).toBe("New Name")
  })

  it("migrates a v1 database in place via 0002 (v1 tables dropped)", async () => {
    const driver = createNodeSqlDriver()
    // Simulate a v1 store: meta with schema_version 1 and a v1 table.
    await driver.execScript(
      "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);" +
        "INSERT INTO meta (key, value) VALUES ('schema_version', '1');" +
        "CREATE TABLE notes (id TEXT PRIMARY KEY, content TEXT NOT NULL, updated_at INTEGER);" +
        "CREATE TABLE blocks (id TEXT PRIMARY KEY, note_id TEXT NOT NULL, parent_id TEXT, position INTEGER NOT NULL, content TEXT NOT NULL);" +
        "CREATE TABLE links (from_block TEXT NOT NULL, to_note TEXT, to_block TEXT, kind TEXT NOT NULL);" +
        "CREATE TABLE view_state (note_id TEXT PRIMARY KEY, collapsed TEXT NOT NULL);",
    )
    const store = await openSqlNoteStore(driver)
    expect((await store.getGraph()).nodes.size).toBe(0)
    expect(await driver.exec("SELECT value FROM meta WHERE key = 'schema_version'")).toEqual([
      { value: "9" },
    ])
    expect(
      await driver.exec("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"),
      // The v1 tables are gone and v5's `views` and v9's `events` are there —
      // the ladder ran to the top, not just to 0002.
    ).toEqual([
      { name: "events" },
      { name: "link" },
      { name: "meta" },
      { name: "nodes" },
      { name: "views" },
    ])
  })

  it("adds the soft-delete columns to a v2 database in place, keeping its rows", async () => {
    const driver = createNodeSqlDriver()
    // A v2 store: the real ladder, stopped one step short.
    await driver.execScript(migration0001 + "\n" + migration0002)
    await driver.batch([
      {
        sql: "INSERT INTO nodes (id, type, text, props, updated_at) VALUES (?, ?, ?, ?, ?)",
        params: ["a", "note", "a", null, 100],
      },
    ])

    const store = await openSqlNoteStore(driver)
    // The row survives the DDL step, under its own id: the ladder adds
    // columns, it never rewrites rows.
    expect(await noteOf(store, "a")).toBe("\n")
    expect(await driver.exec("SELECT value FROM meta WHERE key = 'schema_version'")).toEqual([
      { value: "9" },
    ])
    // The row is live: a nullable column means NULL = never deleted.
    expect(await driver.exec("SELECT deleted_at FROM nodes WHERE id = ?", ["a"])).toEqual([
      { deleted_at: null },
    ])
  })

  it("adds notes_id to a v3 database in place, keeping its rows", async () => {
    const driver = createNodeSqlDriver()
    // A v3 store: the real ladder, stopped one step short.
    await driver.execScript(migration0001 + "\n" + migration0002)
    await driver.execScript(
      "ALTER TABLE nodes ADD COLUMN deleted_at INTEGER;" +
        "ALTER TABLE link ADD COLUMN deleted_at INTEGER;" +
        "INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '3');",
    )
    await driver.batch([
      {
        sql: "INSERT INTO nodes (id, type, text, props, updated_at) VALUES (?, ?, ?, ?, ?)",
        params: ["a", "note", "a", null, 100],
      },
    ])
    const store = await openSqlNoteStore(driver)
    expect(await noteOf(store, "a")).toBe("\n")
    expect(await driver.exec("SELECT value FROM meta WHERE key = 'schema_version'")).toEqual([
      { value: "9" },
    ])
    // No note id until a pull brings the replica's backfill down.
    expect(await driver.exec("SELECT notes_id FROM nodes WHERE id = ?", ["a"])).toEqual([
      { notes_id: null },
    ])
  })

  it("persists a created block's notes_id and reads it back", async () => {
    const { store } = await makeStoreWithDriver()
    await seed(store, "a", "- one\n  id:: blk_one0000000\n")
    const graph = await store.getGraph()
    expect(graph.nodes.get("blk_one0000000")?.notes_id).toBe("a")
    expect(graph.nodes.get("a")?.notes_id).toBeUndefined()
    // A row pushed without a notes_id (an older client) never clears one.
    const rows = await store.getAllRows()
    const one = rows.nodes.find((row) => row.id === "blk_one0000000")!
    expect(one.notes_id).toBe("a")
  })

  it("resets and re-migrates a database with an unknown schema_version", async () => {
    const { driver, store } = await makeStoreWithDriver()
    await seed(store, "a", "stale\n  id:: blk_aaaaaaaaaa\n")
    await driver.exec("UPDATE meta SET value = '999' WHERE key = 'schema_version'")

    const reopened = await openSqlNoteStore(driver)
    expect((await reopened.getGraph()).nodes.size).toBe(0)
    expect(await driver.exec("SELECT value FROM meta WHERE key = 'schema_version'")).toEqual([
      { value: "9" },
    ])
  })

  it("keeps existing data when reopening a database with the current schema", async () => {
    const { driver, store } = await makeStoreWithDriver()
    await seed(store, "blk_note0000", "keep me\n  id:: blk_aaaaaaaaaa\n")
    const reopened = await openSqlNoteStore(driver)
    expect(await noteOf(reopened, "blk_note0000")).toBe("keep me\n  id:: blk_aaaaaaaaaa\n")
  })

  it("never rewrites rows on open — a title-shaped note id is left alone", async () => {
    const { driver, store } = await makeStoreWithDriver()
    await seed(store, "Flow Engineering", "body\n  id:: blk_aaaaaaaaaa\n")
    const before = await driver.exec("SELECT id, type, text, updated_at FROM nodes ORDER BY id")

    const reopened = await openSqlNoteStore(driver)

    // Opening the store is DDL only. Data migrations are one-shot operations
    // run server-side against D1; a local copy that predates one is discarded
    // and re-pulled wholesale (`CACHE_GENERATION`, database-mode.ts), never
    // transformed in place — which is what stops a device merging rows of two
    // different generations.
    expect(await noteOf(reopened, "Flow Engineering")).toBe("body\n  id:: blk_aaaaaaaaaa\n")
    expect(await driver.exec("SELECT id, type, text, updated_at FROM nodes ORDER BY id")).toEqual(
      before,
    )
  })

  it("clear wipes every row and the log, and keeps meta", async () => {
    const { driver, store } = await makeStoreWithDriver()
    await seed(store, "old", "- gone\n  id:: blk_aaaaaaaaaa\n")
    await store.setMeta("d1_pull_cursor", "123")
    await store.clear()
    expect(await driver.exec("SELECT COUNT(*) AS n FROM nodes")).toEqual([{ n: 0 }])
    expect(await driver.exec("SELECT COUNT(*) AS n FROM link")).toEqual([{ n: 0 }])
    expect(await driver.exec("SELECT COUNT(*) AS n FROM events")).toEqual([{ n: 0 }])
    expect(await store.getMeta("d1_pull_cursor")).toBe("123")
  })

  it("adds the log and the seq columns to a v8 database in place, keeping its rows", async () => {
    const { driver, store } = await makeStoreWithDriver()
    await seed(store, "a", "- kept\n  id:: blk_aaaaaaaaaa\n")
    // Back to v8: no log, no seq. The ladder must add both without a reset.
    await driver.execScript(
      "DROP TABLE events;" +
        "ALTER TABLE nodes DROP COLUMN seq; ALTER TABLE link DROP COLUMN seq;" +
        "ALTER TABLE views DROP COLUMN seq;" +
        "INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '8');",
    )
    const reopened = await openSqlNoteStore(driver)
    expect(await noteOf(reopened, "a")).toBe("- kept\n  id:: blk_aaaaaaaaaa\n")
    expect(await driver.exec("SELECT value FROM meta WHERE key = 'schema_version'")).toEqual([
      { value: "9" },
    ])
    expect(await driver.exec("SELECT seq FROM nodes WHERE id = 'a'")).toEqual([{ seq: null }])
    expect(await reopened.unpushedEvents()).toEqual([])
  })

  it("applyPull records the replica's seq on each row, and the graph carries it", async () => {
    const { store } = await makeStoreWithDriver()
    await store.applyPull({
      nodes: [{ id: "a", type: "note", text: "a", props: null, updated_at: 1, seq: 7 }],
      links: [],
      views: [],
      deleteNodes: [],
      deleteLinks: [],
    })
    expect((await store.getGraph()).nodes.get("a")?.seq).toBe(7)
    // An edit of that row says what it believed it was changing.
    const [edit] = await applyOps(store, [{ op: "setText", id: "a", text: "A" }])
    expect(edit.base_seq).toBe(7)
  })

  it("applyPull upserts and deletes rows verbatim (remote updated_at kept)", async () => {
    const { driver, store } = await makeStoreWithDriver()
    await seed(store, "a", "- local\n  id:: blk_aaaaaaaaaa\n")
    await store.applyPull({
      nodes: [{ id: "blk_aaaaaaaaaa", type: "ul", text: "remote", props: null, updated_at: 42 }],
      links: [],
      views: [],
      deleteNodes: [],
      deleteLinks: [],
    })
    expect(
      await driver.exec("SELECT text, updated_at FROM nodes WHERE id = 'blk_aaaaaaaaaa'"),
    ).toEqual([{ text: "remote", updated_at: 42 }])
    expect(await noteOf(store, "a")).toBe("- remote\n  id:: blk_aaaaaaaaaa\n")

    await store.applyPull({ nodes: [], links: [], views: [], deleteNodes: ["a"], deleteLinks: [] })
    expect(await noteOf(store, "a")).toBeNull()
  })

  it("getAllRows returns every row of both tables", async () => {
    const { store } = await makeStoreWithDriver()
    await seed(store, "a", "- x\n  id:: blk_aaaaaaaaaa\n")
    const { nodes, links } = await store.getAllRows()
    expect(nodes.map((node) => node.id).sort()).toEqual(["a", "blk_aaaaaaaaaa"])
    expect(links).toHaveLength(1)
    expect(links[0]).toMatchObject({
      source_id: "a",
      destination_id: "blk_aaaaaaaaaa",
      kind: "child",
    })
  })

  it("getAllRows carries tombstones — a delete only replicates if it travels", async () => {
    const { store } = await makeStoreWithDriver()
    await seed(store, "a", "- x\n  id:: blk_aaaaaaaaaa\n")
    await applyOps(store, deleteBlockOps("blk_aaaaaaaaaa", await store.getGraph()))
    const { nodes } = await store.getAllRows()
    expect(nodes.find((node) => node.id === "blk_aaaaaaaaaa")?.deleted_at).toEqual(
      expect.any(Number),
    )
  })

  it("round-trips meta keys", async () => {
    const { store } = await makeStoreWithDriver()
    expect(await store.getMeta("d1_pull_cursor")).toBeNull()
    await store.setMeta("d1_pull_cursor", "123")
    expect(await store.getMeta("d1_pull_cursor")).toBe("123")
    await store.setMeta("d1_pull_cursor", "456")
    expect(await store.getMeta("d1_pull_cursor")).toBe("456")
  })
})

/**
 * Soft deletes, end to end in the store: what a delete writes, what reads do
 * with it afterwards, and what comes back when the same id returns.
 * User-visible delete behaviour — unlink plus rescue — is decided above the
 * store (`deleteBlockOps`, `docToOps`); here only the rows matter.
 */
describe("soft deletes", () => {
  const OUTLINE = "- parent\n  id:: blk_parent0000\n  - child\n    id:: blk_child00000\n"

  it("stamps every row one delete retires with ONE timestamp", async () => {
    const { driver, store } = await makeStoreWithDriver()
    await seed(store, "a", OUTLINE)
    await applyOps(store, deleteNoteOps("a", await store.getGraph()))

    const stamps = await driver.exec(
      "SELECT deleted_at FROM nodes UNION ALL SELECT deleted_at FROM link",
    )
    expect(stamps).toHaveLength(5) // note + 2 blocks + 2 retained links
    const tombstones = stamps.map((row) => row.deleted_at).filter((value) => value !== null)
    expect(tombstones).toHaveLength(3) // the three nodes; links are retained
    expect(new Set(tombstones).size).toBe(1)
  })

  it("a tombstoned node never renders, and neither does a link into it", async () => {
    const { driver, store } = await makeStoreWithDriver()
    await seed(store, "a", OUTLINE)
    await applyOps(store, deleteBlockOps("blk_child00000", await store.getGraph()))

    // The child was deleted: gone from every read…
    expect(await noteOf(store, "a")).toBe("- parent\n  id:: blk_parent0000\n")
    const graph = await store.getGraph()
    expect(graph.nodes.has("blk_child00000")).toBe(false)
    expect(graph.childLinks.get("blk_parent0000") ?? []).toEqual([])
    // …though its row is still on disk.
    expect(await driver.exec("SELECT COUNT(*) AS n FROM nodes")).toEqual([{ n: 3 }])
  })

  it("keeps the link to a deleted node — the position a restore would use", async () => {
    const { driver, store } = await makeStoreWithDriver()
    await seed(store, "a", OUTLINE)
    // Delete the note: the whole subtree is retired, but EVERY containment row
    // that describes its shape is retained, not cascaded — including the
    // note's own link to the block that was directly under it.
    await applyOps(store, deleteNoteOps("a", await store.getGraph()))

    expect(
      await driver.exec(
        "SELECT source_id, destination_id, deleted_at FROM link ORDER BY source_id",
      ),
    ).toEqual([
      { source_id: "a", destination_id: "blk_parent0000", deleted_at: null },
      { source_id: "blk_parent0000", destination_id: "blk_child00000", deleted_at: null },
    ])
  })

  it("re-creating a deleted id revives it cleanly (no stale tombstone)", async () => {
    const { driver, store } = await makeStoreWithDriver()
    await seed(store, "a", OUTLINE)
    await seed(store, "a", "- parent\n  id:: blk_parent0000\n")
    await seed(store, "a", OUTLINE)

    expect(await noteOf(store, "a")).toBe(OUTLINE)
    expect(await driver.exec("SELECT deleted_at FROM nodes WHERE id = 'blk_child00000'")).toEqual([
      { deleted_at: null },
    ])
    // And the revived row goes out live, not as a tombstone.
    const { nodes } = await store.getAllRows()
    expect(nodes.find((node) => node.id === "blk_child00000")?.deleted_at).toBeUndefined()
  })

  it("a pulled tombstone lands and hides the row, without removing it", async () => {
    const { driver, store } = await makeStoreWithDriver()
    await seed(store, "a", OUTLINE)
    const later = Date.now() + 1000
    await store.applyPull({
      nodes: [
        {
          id: "blk_child00000",
          type: "text",
          text: "child",
          props: null,
          updated_at: later,
          deleted_at: later,
        },
      ],
      links: [],
      views: [],
      deleteNodes: [],
      deleteLinks: [],
    })
    expect(await noteOf(store, "a")).toBe("- parent\n  id:: blk_parent0000\n")
    expect(await driver.exec("SELECT COUNT(*) AS n FROM nodes")).toEqual([{ n: 3 }])
  })
})

/**
 * The device's log (docs/event-sourcing.md): what the store keeps of what it
 * did, what the push loop reads from it, and how an acknowledgement lands.
 */
describe("the device's log", () => {
  const ctx = (at: number) => testEventContext({ at, device: "dev.tab" })

  it("queues every event unpushed, in the order made, and stamps it with the replica's seq", async () => {
    const { driver, store } = await makeStoreWithDriver()
    const made = await seed(store, "a", "- one\n  id:: blk_aaaaaaaaaa\n")
    const queued = await store.unpushedEvents()
    expect(queued.map((event) => event.id)).toEqual(made.map((event) => event.id))
    expect(queued[0]).toMatchObject({ device: "test.tab", tz: 0, base_seq: null })

    await store.markEventsPushed(queued.map((event, i) => [event.id, 100 + i] as const))
    expect(await store.unpushedEvents()).toEqual([])
    expect(await driver.exec("SELECT id, seq FROM events ORDER BY position")).toEqual(
      queued.map((event, i) => ({ id: event.id, seq: 100 + i })),
    )
    // A row's seq is its last event's — the note's is its create, the
    // block's its create, the link's its own.
    const block = queued.findIndex((e) => e.entity === "block" && e.entity_id === "blk_aaaaaaaaaa")
    expect(await driver.exec("SELECT seq FROM nodes WHERE id = 'blk_aaaaaaaaaa'")).toEqual([
      { seq: 100 + block },
    ])
    const link = queued.findIndex((e) => e.entity === "link")
    expect(await driver.exec("SELECT seq FROM link")).toEqual([{ seq: 100 + link }])
  })

  it("coalesces a typing run across writes into one unpushed event, carrying the run's first base", async () => {
    const { driver, store } = await makeStoreWithDriver()
    await seed(store, "a", "- x\n  id:: blk_aaaaaaaaaa\n")
    await store.markEventsPushed((await store.unpushedEvents()).map((e, i) => [e.id, i + 1]))
    const first = await applyOpsToStore(
      store,
      [{ op: "setText", id: "blk_aaaaaaaaaa", text: "xy" }],
      ctx(10_000),
    )
    await applyOpsToStore(
      store,
      [{ op: "setText", id: "blk_aaaaaaaaaa", text: "xyz" }],
      ctx(11_000),
    )
    const last = await applyOpsToStore(
      store,
      [{ op: "setText", id: "blk_aaaaaaaaaa", text: "xyzw" }],
      ctx(12_000),
    )

    const queued = await store.unpushedEvents()
    expect(queued).toHaveLength(1)
    expect(queued[0]).toMatchObject({
      id: last[0].id,
      action: "update",
      patch: { text: "xyzw" },
      base_seq: first[0].base_seq,
    })
    expect(await driver.exec("SELECT text FROM nodes WHERE id = 'blk_aaaaaaaaaa'")).toEqual([
      { text: "xyzw" },
    ])
    // The log holds exactly the pushed events plus the one survivor.
    expect(await driver.exec("SELECT COUNT(*) AS n FROM events")).toEqual([{ n: 3 + 1 }])
  })

  it("never coalesces into an event a push has in flight", async () => {
    const { store } = await makeStoreWithDriver()
    await seed(store, "a", "- x\n  id:: blk_aaaaaaaaaa\n")
    const flying = await applyOpsToStore(
      store,
      [{ op: "setText", id: "blk_aaaaaaaaaa", text: "xy" }],
      ctx(10_000),
    )
    const graph = await store.getGraph()
    const next = opsToEvents(
      graph,
      [{ op: "setText", id: "blk_aaaaaaaaaa", text: "xyz" }],
      ctx(11_000),
    )
    await store.applyEvents(next, { frozen: new Set([flying[0].id]) })
    const ids = (await store.unpushedEvents()).map((event) => event.id)
    expect(ids).toContain(flying[0].id)
    expect(ids).toContain(next[0].id)
  })

  it("a run ends at a structural change, so a history never loses a step", async () => {
    const { store } = await makeStoreWithDriver()
    await seed(store, "a", "- x\n  id:: blk_aaaaaaaaaa\n")
    await applyOpsToStore(store, [{ op: "setText", id: "blk_aaaaaaaaaa", text: "xy" }], ctx(10_000))
    await applyOpsToStore(store, [{ op: "setType", id: "blk_aaaaaaaaaa", type: "h1" }], ctx(10_100))
    await applyOpsToStore(
      store,
      [{ op: "setText", id: "blk_aaaaaaaaaa", text: "xyz" }],
      ctx(10_200),
    )
    const typed = (await store.unpushedEvents()).filter(
      (event) => event.entity === "block" && event.action === "update",
    )
    expect(typed.map((event) => event.patch)).toEqual([
      { text: "xy" },
      { type: "h1" },
      { text: "xyz" },
    ])
  })

  it("takes in the pulled log, places an own event the pull brings back, and reads the whole in order", async () => {
    const { driver, store } = await makeStoreWithDriver()
    const own = await seed(store, "a", "- one\n  id:: blk_aaaaaaaaaa\n")
    // The replica took the push but the answer was lost: the pull brings
    // this device's own events back, placed, among another device's.
    const pulled = [
      {
        id: "evt_other_1",
        seq: 1,
        entity: "block",
        entity_id: "b",
        action: "create",
        patch: { type: "note", text: "B", props: null, notes_id: null },
        batch: "bat_other",
        device: "other.tab",
        at: 500,
        tz: -300,
        v: 1,
        origin: "replica",
        actor: 222,
        received_at: 600,
      },
      ...own.map((event, i) => ({ ...event, seq: 2 + i, origin: "replica", actor: 111 })),
    ] as Parameters<typeof store.applyPulledEvents>[0]
    await store.applyPulledEvents(pulled)
    // Nothing left to push: the pull placed them.
    expect(await store.unpushedEvents()).toEqual([])
    // The rows are untouched by the log: `b` arrives by the pull of rows.
    expect(await driver.exec("SELECT COUNT(*) AS n FROM nodes WHERE id = 'b'")).toEqual([{ n: 0 }])

    // A new edit, not yet pushed, reads after everything placed.
    const typed = await applyOpsToStore(
      store,
      [{ op: "setText", id: "blk_aaaaaaaaaa", text: "one!" }],
      ctx(9_000),
    )
    const log = await store.eventLog()
    expect(log.map((event) => [event.id, event.seq, event.pending ?? false])).toEqual([
      ["evt_other_1", 1, false],
      ...own.map((event, i) => [event.id, 2 + i, false]),
      [typed[0].id, 2 + own.length, true],
    ])
    expect(log[0]).toMatchObject({ origin: "replica", actor: 222, received_at: 600, tz: -300 })
  })

  it("projects a view's events onto its row: create, update, delete, revival", async () => {
    const { driver, store } = await makeStoreWithDriver()
    const view: ViewRow = {
      id: "v1",
      root_id: "a",
      filter: null,
      sort: null,
      pinned: true,
      sort_key: null,
      updated_at: 10,
    }
    const apply = async (before: ViewRow | undefined, after: ViewRow | undefined, at: number) => {
      const event = viewChangeToEvent(before, after, ctx(at))
      if (event) await store.applyEvents([event])
      return event
    }
    await apply(undefined, view, 10)
    expect(await store.getViews()).toEqual([{ ...view, updated_at: 10 }])
    await apply(view, { ...view, filter: "type:todo", updated_at: 20 }, 20)
    expect((await store.getViews())[0]).toMatchObject({ filter: "type:todo", updated_at: 20 })
    await apply(view, { ...view, deleted_at: 30, updated_at: 30 }, 30)
    expect(await store.getViews()).toEqual([])
    expect(await driver.exec("SELECT deleted_at FROM views WHERE id = 'v1'")).toEqual([
      { deleted_at: 30 },
    ])
    await apply({ ...view, deleted_at: 30 }, { ...view, updated_at: 40 }, 40)
    expect((await store.getViews())[0]).toMatchObject({ id: "v1", updated_at: 40 })
    expect((await store.unpushedEvents()).map((e) => e.action)).toEqual([
      "create",
      "update",
      "delete",
      "restore",
    ])
  })
})
