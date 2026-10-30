// tenant-guard: exempt — these tests read and seed raw storage on purpose
// (that is how they pin what the store wrote, tombstones included).
import { describe, expect, it } from "vitest"
import migration0001 from "../../migrations/0001_init.sql?raw"
import migration0002 from "../../migrations/0002_nodes.sql?raw"
import { parse } from "../blocks/parse"
import type { BlockProps } from "../blocks/types"
import type { SqlDriver } from "./sql-driver"
import { cacheRowKey, registerOf, type CacheRow } from "./cache-rows"
import { linkEntityId } from "./events"
import { rollup } from "./graph"
import { KEY_EVENT_VERSION, opsToKeyEvents, type KeyEvent } from "./key-events"
import type { NoteStore } from "./note-store"
import { deleteBlockOps, deleteNoteOps, docToOps, type Op } from "./ops"
import { createNodeSqlDriver } from "./sql-node-test-driver"
import { openSqlNoteStore } from "./sql-note-store"
import { applyOpsToStore, keyed, testEventContext } from "./store-test-support"

/** What step v18 takes away, put back as v17 left them — `nodes`, `link`,
 * `delta_mat_values` and the old `events` table, with every column and
 * index a step below v18 alters or drops — and what it adds, dropped: a
 * store as it was at v17, to build an older one by hand from. */
const UNDO_V18 =
  "DROP TABLE events_log_cache;" +
  "CREATE TABLE nodes (id TEXT PRIMARY KEY, type TEXT NOT NULL, text TEXT NOT NULL, " +
  "props TEXT, updated_at INTEGER NOT NULL, deleted_at INTEGER, notes_id TEXT, seq INTEGER, " +
  "stamps TEXT);" +
  "CREATE TABLE link (source_id TEXT NOT NULL, destination_id TEXT NOT NULL, " +
  "kind TEXT NOT NULL DEFAULT 'child', sort_key TEXT NOT NULL, updated_at INTEGER NOT NULL, " +
  "deleted_at INTEGER, seq INTEGER, stamps TEXT, PRIMARY KEY (source_id, destination_id, kind));" +
  "CREATE TABLE delta_mat_values (block_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT, " +
  "hlc TEXT NOT NULL, seq INTEGER, updated_at INTEGER NOT NULL, PRIMARY KEY (block_id, key));" +
  "CREATE TABLE events (id TEXT PRIMARY KEY, seq INTEGER, entity TEXT NOT NULL, " +
  "entity_id TEXT NOT NULL, action TEXT NOT NULL, patch TEXT NOT NULL, v INTEGER NOT NULL, " +
  "batch TEXT NOT NULL, device TEXT NOT NULL, cause TEXT, base_seq INTEGER, ref_seq INTEGER, " +
  "at INTEGER NOT NULL, tz INTEGER, position INTEGER NOT NULL, origin TEXT, actor INTEGER, " +
  "received_at INTEGER, hlc TEXT);" +
  "CREATE INDEX events_unpushed ON events (seq, position);" +
  "CREATE INDEX events_position ON events (position);" +
  "CREATE INDEX events_entity ON events (entity, entity_id);"
/** What step v17 takes away, put back: the `views` table as v16 left it,
 * which the steps below v17 alter. */
const UNDO_V17 =
  UNDO_V18 +
  "CREATE TABLE views (id TEXT PRIMARY KEY, root_id TEXT NOT NULL, filter TEXT, sort TEXT, " +
  "pinned INTEGER NOT NULL DEFAULT 0, sort_key TEXT, updated_at INTEGER NOT NULL, " +
  "deleted_at INTEGER, seq INTEGER, stamps TEXT, stack TEXT);"
/** What step v16 adds, taken away: a store as it was at v15. */
const UNDO_V16 = UNDO_V17 + "DROP INDEX events_log_position;"
/** What step v15 adds, taken away: a store as it was at v14. */
const UNDO_V15 = UNDO_V17 + "DROP TABLE events_log; DROP TABLE delta_mat_values;"
/** What step v14 adds, taken away: a store as it was at v13. */
const UNDO_V14 = UNDO_V15 + "ALTER TABLE views DROP COLUMN stack;"
const UNDO_V13 =
  "DROP INDEX events_entity; ALTER TABLE nodes DROP COLUMN stamps; " +
  "ALTER TABLE link DROP COLUMN stamps; ALTER TABLE views DROP COLUMN stamps; " +
  "DELETE FROM meta WHERE key = 'cache_stamps';"

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
const named = (events: readonly KeyEvent[]) =>
  events.map((event) => `${event.entity}.${event.action} ${event.entity_id}`)

/** A note's markdown projection off the live graph, or null when absent. */
const noteOf = async (store: NoteStore, id: string) => rollup(id, await store.getGraph())

/** The cache rows of one entity, by key: what a write left on disk. */
const rowsOf = (driver: SqlDriver, entity: "block" | "link", id: string) =>
  driver.exec(
    "SELECT key, value, hlc, seq, updated_at FROM events_log_cache " +
      "WHERE entity = ? AND entity_id = ? ORDER BY key",
    [entity, id],
  )

/** How many cache rows there are, in all. */
const cacheRows = async (driver: SqlDriver) =>
  Number((await driver.exec("SELECT COUNT(*) AS n FROM events_log_cache"))[0].n)

/** The tables the store holds. */
const tablesOf = async (driver: SqlDriver) =>
  (await driver.exec("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")).map(
    (row) => String(row.name),
  )

const CURRENT = [{ value: "18" }]

describe("openSqlNoteStore", () => {
  it("lands a saved note as typed node and link rows", async () => {
    const { driver, store } = await makeStoreWithDriver()
    await seed(store, "a", "# Hello\n  id:: blk_aaaaaaaaaa\n[ ] task\n  id:: blk_bbbbbbbbbb\n")

    const { nodes, links } = await store.getAllRows()
    expect(
      nodes
        .map(({ id, type, text }) => ({ id, type, text }))
        .sort((a, b) => (a.id < b.id ? -1 : 1)),
    ).toEqual([
      { id: "a", type: "note", text: "a" },
      { id: "blk_aaaaaaaaaa", type: "h1", text: "Hello" },
      { id: "blk_bbbbbbbbbb", type: "todo", text: "task" },
    ])
    expect(
      links
        .sort((a, b) => (a.sort_key < b.sort_key ? -1 : 1))
        .map(({ source_id, destination_id, kind }) => ({ source_id, destination_id, kind })),
    ).toEqual([
      { source_id: "a", destination_id: "blk_aaaaaaaaaa", kind: "child" },
      { source_id: "a", destination_id: "blk_bbbbbbbbbb", kind: "child" },
    ])
    // One row per key, as the replica holds them (docs/events-log-cache.md).
    expect(
      (await rowsOf(driver, "block", "blk_bbbbbbbbbb")).map((row) => [row.key, row.value]),
    ).toEqual([
      ["deleted", "null"],
      ["notes_id", '"a"'],
      ["text", '"task"'],
      ["type", '"todo"'],
    ])
    expect(await noteOf(store, "a")).toBe(
      "# Hello\n  id:: blk_aaaaaaaaaa\n[ ] task\n  id:: blk_bbbbbbbbbb\n",
    )
  })

  it("writes only the rows the ops name: untouched rows keep their updated_at and sort keys", async () => {
    const { driver, store } = await makeStoreWithDriver()
    await seed(store, "a", "- one\n  id:: blk_aaaaaaaaaa\n- two\n  id:: blk_bbbbbbbbbb\n")
    const linkIds = ["a|blk_aaaaaaaaaa|child", "a|blk_bbbbbbbbbb|child"]
    const linkRows = () => Promise.all(linkIds.map((id) => rowsOf(driver, "link", id)))
    const beforeLinks = await linkRows()
    const beforeOne = await rowsOf(driver, "block", "blk_aaaaaaaaaa")

    // Touch only the second block.
    const events = await seed(
      store,
      "a",
      "- one\n  id:: blk_aaaaaaaaaa\n- two edited\n  id:: blk_bbbbbbbbbb\n",
    )
    expect(named(events)).toEqual(["block.set blk_bbbbbbbbbb"])
    expect(events[0]).toMatchObject({ key: "text", value: "two edited" })

    // The links' rows and the untouched block's are byte-identical, stamps
    // and clocks included; only the edited block's `text` row moved.
    expect(await linkRows()).toEqual(beforeLinks)
    expect(await rowsOf(driver, "block", "blk_aaaaaaaaaa")).toEqual(beforeOne)
    expect(
      (await rowsOf(driver, "block", "blk_bbbbbbbbbb")).find((row) => row.key === "text"),
    ).toMatchObject({ value: '"two edited"', hlc: events[0].hlc })
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
    expect(await cacheRows(driver)).toBe(0)
    expect(await store.unpushedEvents()).toEqual([])
  })

  it("removing a block from a note tombstones its link row and keeps its node (diffed)", async () => {
    const { store } = await makeStoreWithDriver()
    await seed(store, "a", "- keep\n  id:: blk_aaaaaaaaaa\n- drop\n  id:: blk_bbbbbbbbbb\n")
    const events = await seed(store, "a", "- keep\n  id:: blk_aaaaaaaaaa\n")
    // An unlink, not a delete: the block is out of reach (the basket's), its
    // row live, and only the link's tombstone travels.
    expect(named(events)).toEqual([`link.delete ${linkEntityId("a", "blk_bbbbbbbbbb")}`])
    const { nodes, links } = await store.getAllRows()
    expect(nodes.find((node) => node.id === "blk_bbbbbbbbbb")?.deleted_at).toBeUndefined()
    expect(links.find((link) => link.destination_id === "blk_bbbbbbbbbb")?.deleted_at).toBe(
      events[0].at,
    )
    expect(await noteOf(store, "a")).toBe("- keep\n  id:: blk_aaaaaaaaaa\n")
  })

  it("deleting a block tombstones its node and link rows (diffed)", async () => {
    const { store } = await makeStoreWithDriver()
    await seed(store, "a", "- keep\n  id:: blk_aaaaaaaaaa\n- drop\n  id:: blk_bbbbbbbbbb\n")
    const events = await applyOps(store, deleteBlockOps("blk_bbbbbbbbbb", await store.getGraph()))
    // Nothing is removed: a delete is an event per row, and the rows stay as
    // tombstones, so the delete replicates like any other change.
    expect(named(events).sort()).toEqual([
      "block.delete blk_bbbbbbbbbb",
      `link.delete ${linkEntityId("a", "blk_bbbbbbbbbb")}`,
    ])
    const { nodes } = await store.getAllRows()
    expect(nodes.find((node) => node.id === "blk_bbbbbbbbbb")?.deleted_at).toEqual(
      expect.any(Number),
    )
    expect(await noteOf(store, "a")).toBe("- keep\n  id:: blk_aaaaaaaaaa\n")
  })

  it("tombstones a note's rows on delete and reports the diff", async () => {
    const { store } = await makeStoreWithDriver()
    await seed(store, "a", "# A note\n  id:: blk_aaaaaaaaaa\n")
    const events = await applyOps(store, deleteNoteOps("a", await store.getGraph()))

    const deletes = events.filter((event) => event.entity === "block")
    expect(deletes.map((event) => event.entity_id).sort()).toEqual(["a", "blk_aaaaaaaaaa"])
    expect(deletes.every((event) => event.action === "delete")).toBe(true)
    // ONE stamp for the whole delete: a future restore is "revive the rows
    // stamped at T".
    expect(new Set(deletes.map((event) => event.at)).size).toBe(1)
    const { nodes, links } = await store.getAllRows()
    expect(new Set(nodes.map((node) => node.deleted_at))).toEqual(new Set([deletes[0].at]))
    expect(await noteOf(store, "a")).toBeNull()
    expect((await store.getGraph()).nodes.size).toBe(0)
    // The rows — and the link that positions the block under the note — are
    // still there, which is what makes a restore possible at all.
    expect(nodes).toHaveLength(2)
    expect(links).toHaveLength(1)
    expect(links[0].deleted_at).toBeUndefined()
  })

  it("retitling a note rewrites exactly one row — the note's", async () => {
    const { driver, store } = await makeStoreWithDriver()
    const id = "blk_note00000"
    await seed(store, id, "keep me\n  id:: blk_aaaaaaaaaa\n", { title: "Old Name" })
    const before = await rowsOf(driver, "block", "blk_aaaaaaaaaa")

    const events = await seed(store, id, "keep me\n  id:: blk_aaaaaaaaaa\n", { title: "New Name" })

    // ONE event, the note's: a rename can no longer bump `updated_at` on
    // blocks the user never touched, so it cannot clobber a concurrent edit
    // to one of them under per-row LWW.
    expect(named(events)).toEqual([`block.set ${id}`])
    expect(events[0]).toMatchObject({ key: "text", value: "New Name" })

    // The id is untouched, so every deep link and block row still resolves,
    // and the block's rows are as they were.
    expect(await rowsOf(driver, "block", "blk_aaaaaaaaaa")).toEqual(before)
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
    expect(await driver.exec("SELECT value FROM meta WHERE key = 'schema_version'")).toEqual(
      CURRENT,
    )
    // The v1 tables are gone, and so are the graph tables 0002 made and v9's
    // `events`: at v18 the store is the log and the cache of its fold — the
    // ladder ran to the top, not just to 0002.
    expect(await tablesOf(driver)).toEqual(["events_log", "events_log_cache", "meta"])
  })

  it("climbs a v2 database to the top: the rows go with the tables the cache replaces", async () => {
    const driver = createNodeSqlDriver()
    // A v2 store: the real ladder, stopped at 0002, with a row in it.
    await driver.execScript(migration0001 + "\n" + migration0002)
    await driver.batch([
      {
        sql: "INSERT INTO nodes (id, type, text, props, updated_at) VALUES (?, ?, ?, ?, ?)",
        params: ["a", "note", "a", null, 100],
      },
    ])

    const store = await openSqlNoteStore(driver)
    // Every step below v18 ran in place, and v18 dropped the tables they
    // altered: the row is gone, and a snapshot of the replica's cache brings
    // the corpus back (`CACHE_GENERATION`, database-mode.ts).
    expect(await noteOf(store, "a")).toBeNull()
    expect(await driver.exec("SELECT value FROM meta WHERE key = 'schema_version'")).toEqual(
      CURRENT,
    )
    expect(await tablesOf(driver)).toEqual(["events_log", "events_log_cache", "meta"])
  })

  it("climbs a v3 database to the top the same way", async () => {
    const driver = createNodeSqlDriver()
    // A v3 store: the real ladder, stopped one step past 0002.
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
    expect(await noteOf(store, "a")).toBeNull()
    expect(await driver.exec("SELECT value FROM meta WHERE key = 'schema_version'")).toEqual(
      CURRENT,
    )
    expect(await tablesOf(driver)).toEqual(["events_log", "events_log_cache", "meta"])
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

  it("climbs a v9 store whose events table shipped without the pull's columns", async () => {
    const driver = createNodeSqlDriver()
    // A v9 store as the step first shipped: the ladder stopped one short, so
    // `events` has no `origin`, `actor` or `received_at` — the shape every
    // device that opened the app between the two deploys of 2026-10-10 holds.
    await openSqlNoteStore(driver)
    await driver.execScript(
      UNDO_V14 +
        UNDO_V13 +
        "DROP TABLE events;" +
        "CREATE TABLE events (id TEXT PRIMARY KEY, seq INTEGER, entity TEXT NOT NULL, " +
        "entity_id TEXT NOT NULL, action TEXT NOT NULL, patch TEXT NOT NULL, v INTEGER NOT NULL, " +
        "batch TEXT NOT NULL, device TEXT NOT NULL, cause TEXT, base_seq INTEGER, ref_seq INTEGER, " +
        "at INTEGER NOT NULL, tz INTEGER, position INTEGER NOT NULL);" +
        "CREATE INDEX events_unpushed ON events (seq, position);" +
        "INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '9');",
    )
    await driver.batch([
      {
        sql:
          "INSERT INTO events (id, seq, entity, entity_id, action, patch, v, batch, device, " +
          "at, position) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        params: [
          "evt_1",
          "block",
          "blk_aaaaaaaaaa",
          "create",
          '{"text":"queued"}',
          1,
          "b1",
          "d1",
          100,
          1,
        ],
      },
    ])

    const store = await openSqlNoteStore(driver)
    expect(await driver.exec("SELECT value FROM meta WHERE key = 'schema_version'")).toEqual(
      CURRENT,
    )
    // The old queue goes with its table at v18 (the old log has not been
    // read since v15), and a pulled event is placed in the per-key log.
    expect(await tablesOf(driver)).not.toContain("events")
    await store.applyPulledEvents(
      keyed([
        {
          id: "evt_2",
          seq: 7,
          entity: "block",
          entity_id: "blk_bbbbbbbbbb",
          action: "create",
          patch: { type: "paragraph", text: "pulled", props: null, notes_id: "a" },
          v: 1,
          batch: "b2",
          device: "d2",
          base_seq: null,
          at: 200,
          tz: null,
          origin: "replica",
          actor: 1,
          received_at: 201,
        },
      ]),
    )
    expect(
      await driver.exec("SELECT event_id, origin FROM events_log WHERE event_seq = 7 LIMIT 1"),
    ).toEqual([{ event_id: "evt_2", origin: "replica" }])
  })

  it("climbs a v10 store past the stamp column, and does not read its old queue", async () => {
    const driver = createNodeSqlDriver()
    await openSqlNoteStore(driver)
    await driver.execScript(
      UNDO_V14 +
        UNDO_V13 +
        "DROP INDEX events_position; ALTER TABLE events DROP COLUMN hlc;" +
        "INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '10');" +
        "INSERT INTO events (id, seq, entity, entity_id, action, patch, v, batch, device, " +
        "at, position) VALUES ('evt_1', NULL, 'block', 'blk_aaaaaaaaaa', 'update', " +
        "'{\"text\":\"queued\"}', 1, 'b1', 'd1', 100, 1);",
    )
    const store = await openSqlNoteStore(driver)
    expect(await driver.exec("SELECT value FROM meta WHERE key = 'schema_version'")).toEqual(
      CURRENT,
    )
    // An event made before stamps was never given one in place, and the old
    // queue is not read: the per-key log is the queue now, and v18 drops the
    // old table.
    expect(await tablesOf(driver)).not.toContain("events")
    expect(await store.unpushedEvents()).toEqual([])
  })

  it("climbs a v11 store to the cache", async () => {
    const driver = createNodeSqlDriver()
    await openSqlNoteStore(driver)
    await driver.execScript(
      UNDO_V14 +
        UNDO_V13 +
        "DROP INDEX events_position;" +
        "INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '11');" +
        "INSERT INTO events (id, seq, entity, entity_id, action, patch, v, batch, device, " +
        "at, position) VALUES ('evt_1', NULL, 'block', 'blk_aaaaaaaaaa', 'create', " +
        '\'{"type":"paragraph","text":"queued","props":null,"notes_id":null}\', ' +
        "1, 'b1', 'd1', 100, 1);",
    )
    await openSqlNoteStore(driver)
    expect(await driver.exec("SELECT value FROM meta WHERE key = 'schema_version'")).toEqual(
      CURRENT,
    )
    // v12 made snapshots and v13 took them away; v15 made the per-key log
    // and v18 the cache of its fold, and dropped the old log with its queue.
    expect(await tablesOf(driver)).toEqual(["events_log", "events_log_cache", "meta"])
  })

  it("climbs a v12 store past its snapshots to the cache", async () => {
    const driver = createNodeSqlDriver()
    await openSqlNoteStore(driver)
    // Back to v12: no stamps, a snapshot table with a snapshot in it.
    await driver.execScript(
      UNDO_V14 +
        UNDO_V13 +
        "CREATE TABLE snapshots (id INTEGER PRIMARY KEY, position INTEGER NOT NULL, " +
        "taken_at INTEGER NOT NULL, state TEXT NOT NULL);" +
        "INSERT INTO snapshots (position, taken_at, state) VALUES (1, 1, '{}');" +
        "INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '12');",
    )
    const reopened = await openSqlNoteStore(driver)
    expect(await driver.exec("SELECT value FROM meta WHERE key = 'schema_version'")).toEqual(
      CURRENT,
    )
    expect(await tablesOf(driver)).toEqual(["events_log", "events_log_cache", "meta"])
    expect((await reopened.getGraph()).nodes.size).toBe(0)
  })

  it("climbs a v16 store to v18, keeping its log and not its rows", async () => {
    const { driver, store } = await makeStoreWithDriver()
    await seed(store, "a", "- kept\n  id:: blk_aaaaaaaaaa\n")
    const logged = (await store.eventLog()).length
    await driver.execScript(
      UNDO_V17 + "INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '16');",
    )
    const reopened = await openSqlNoteStore(driver)
    expect(await driver.exec("SELECT value FROM meta WHERE key = 'schema_version'")).toEqual(
      CURRENT,
    )
    expect(await tablesOf(driver)).toEqual(["events_log", "events_log_cache", "meta"])
    // The log is the device's own and stays; the cache is empty until the
    // device takes a snapshot of the replica's (`CACHE_GENERATION`).
    expect(await reopened.eventLog()).toHaveLength(logged)
    expect(await noteOf(reopened, "a")).toBeNull()
  })

  it("climbs a v15 store to v18: the position index, then the cache, the log kept", async () => {
    const { driver, store } = await makeStoreWithDriver()
    await seed(store, "a", "- kept\n  id:: blk_aaaaaaaaaa\n")
    const logged = (await store.eventLog()).length
    await driver.execScript(
      UNDO_V16 + "INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '15');",
    )
    const reopened = await openSqlNoteStore(driver)
    expect(await driver.exec("SELECT value FROM meta WHERE key = 'schema_version'")).toEqual(
      CURRENT,
    )
    // The index v16 adds is a fix: without it, a pulled row's
    // `(SELECT MAX(position) + 1 FROM events_log)` scans the whole log.
    expect(
      await driver.exec(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'events_log_position'",
      ),
    ).toEqual([{ name: "events_log_position" }])
    expect(await reopened.eventLog()).toHaveLength(logged)
  })

  it("climbs a v17 store to v18: the cache table made, the old tables gone, the log kept", async () => {
    const { driver, store } = await makeStoreWithDriver()
    await seed(store, "a", "- kept\n  id:: blk_aaaaaaaaaa\n")
    const logged = (await store.eventLog()).length
    const queued = (await store.unpushedEvents()).length
    await driver.execScript(
      UNDO_V18 + "INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '17');",
    )
    expect(await tablesOf(driver)).toEqual([
      "delta_mat_values",
      "events",
      "events_log",
      "link",
      "meta",
      "nodes",
    ])
    const reopened = await openSqlNoteStore(driver)
    expect(await driver.exec("SELECT value FROM meta WHERE key = 'schema_version'")).toEqual(
      CURRENT,
    )
    expect(await tablesOf(driver)).toEqual(["events_log", "events_log_cache", "meta"])
    expect(
      (
        await driver.exec(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'events_log_cache' " +
            "ORDER BY name",
        )
      ).map((row) => row.name),
    ).toEqual([
      "events_log_cache_destination",
      "events_log_cache_notes",
      "events_log_cache_pinned",
      "events_log_cache_source",
      "events_log_cache_type",
      "sqlite_autoindex_events_log_cache_1",
    ])
    // The log and its queue are the device's own: both stay.
    expect(await reopened.eventLog()).toHaveLength(logged)
    expect(await reopened.unpushedEvents()).toHaveLength(queued)
    expect(await cacheRows(driver)).toBe(0)
  })

  it("resets and re-migrates a database with an unknown schema_version", async () => {
    const { driver, store } = await makeStoreWithDriver()
    await seed(store, "a", "stale\n  id:: blk_aaaaaaaaaa\n")
    await driver.exec("UPDATE meta SET value = '999' WHERE key = 'schema_version'")

    const reopened = await openSqlNoteStore(driver)
    expect((await reopened.getGraph()).nodes.size).toBe(0)
    expect(await driver.exec("SELECT value FROM meta WHERE key = 'schema_version'")).toEqual(
      CURRENT,
    )
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
    const allRows = () =>
      driver.exec(
        "SELECT entity, entity_id, key, value, hlc, updated_at FROM events_log_cache " +
          "ORDER BY entity, entity_id, key",
      )
    const before = await allRows()

    const reopened = await openSqlNoteStore(driver)

    // Opening the store is DDL only. Data migrations are one-shot operations
    // run server-side against D1; a local copy that predates one is discarded
    // and re-pulled wholesale (`CACHE_GENERATION`, database-mode.ts), never
    // transformed in place — which is what stops a device merging rows of two
    // different generations.
    expect(await noteOf(reopened, "Flow Engineering")).toBe("body\n  id:: blk_aaaaaaaaaa\n")
    expect(await allRows()).toEqual(before)
  })

  it("clear wipes every row and the log, and keeps meta", async () => {
    const { driver, store } = await makeStoreWithDriver()
    await seed(store, "old", "- gone\n  id:: blk_aaaaaaaaaa\n")
    await store.setMeta("events_pull_cursor", "123")
    await store.clear()
    expect(await cacheRows(driver)).toBe(0)
    expect(await driver.exec("SELECT COUNT(*) AS n FROM events_log")).toEqual([{ n: 0 }])
    expect(await store.getMeta("events_pull_cursor")).toBe("123")
  })

  it("clearCache wipes the cache and keeps the log, its queue included", async () => {
    const { driver, store } = await makeStoreWithDriver()
    const made = await seed(store, "old", "- kept in the log\n  id:: blk_aaaaaaaaaa\n")
    await store.clearCache()
    expect(await cacheRows(driver)).toBe(0)
    expect((await store.getGraph()).nodes.size).toBe(0)
    expect((await store.unpushedEvents()).map((event) => event.id)).toEqual(
      made.map((event) => event.id),
    )
  })

  it("climbs a v8 database to the top without a reset", async () => {
    const driver = createNodeSqlDriver()
    await openSqlNoteStore(driver)
    // Back to v8: no log, no seq. The ladder must add both, and then the
    // cache, without a reset — a reset would be a wipe of `meta` too.
    await driver.execScript(
      UNDO_V14 +
        UNDO_V13 +
        "DROP TABLE events;" +
        "ALTER TABLE nodes DROP COLUMN seq; ALTER TABLE link DROP COLUMN seq;" +
        "ALTER TABLE views DROP COLUMN seq;" +
        "INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '8');" +
        "INSERT OR REPLACE INTO meta (key, value) VALUES ('store_owner', 'me');",
    )
    const reopened = await openSqlNoteStore(driver)
    expect(await driver.exec("SELECT value FROM meta WHERE key = 'schema_version'")).toEqual(
      CURRENT,
    )
    expect(await reopened.getMeta("store_owner")).toBe("me")
    expect(await tablesOf(driver)).toEqual(["events_log", "events_log_cache", "meta"])
    expect(await reopened.unpushedEvents()).toEqual([])
  })

  /** A row of the replica's cache, as a snapshot page carries it. */
  const row = (
    entity: "block" | "link",
    id: string,
    key: string,
    value: string | null,
    hlc: string,
    seq: number | null = 1,
    at = 1,
  ): CacheRow => ({ entity, entity_id: id, key, value, hlc, seq, updated_at: at })
  const liveBlock = (id: string, text: string, hlc: string, seq = 1, notesId = "a") => [
    row("block", id, "deleted", "null", hlc, seq),
    row("block", id, "type", '"text"', hlc, seq),
    row("block", id, "text", JSON.stringify(text), hlc, seq),
    row("block", id, "notes_id", JSON.stringify(notesId), hlc, seq),
  ]

  it("importCacheRows lands a snapshot's rows by stamp, and the graph carries their seq", async () => {
    const { store } = await makeStoreWithDriver()
    await store.importCacheRows([
      row("block", "a", "deleted", "null", "000000000000001-0000-other", 7),
      row("block", "a", "type", '"note"', "000000000000001-0000-other", 7),
      row("block", "a", "text", '"a"', "000000000000001-0000-other", 7),
    ])
    expect((await store.getGraph()).nodes.get("a")?.seq).toBe(7)
    // An edit of that row says what it believed it was changing.
    const [edit] = await applyOps(store, [{ op: "setText", id: "a", text: "A" }])
    expect(edit.base_seq).toBe(7)
    // A second import under lower stamps changes nothing: the rows are the
    // fold by stamp, whatever arrives.
    await store.importCacheRows([
      row("block", "a", "text", '"older"', "000000000000000-0000-other", 3),
    ])
    expect((await store.getGraph()).nodes.get("a")?.text).toBe("A")
  })

  it("applyUnpushedToCache replays this device's queue over a snapshot, by stamp", async () => {
    const { store } = await makeStoreWithDriver()
    await seed(store, "a", "- local\n  id:: blk_aaaaaaaaaa\n")
    const [edit] = await applyOpsToStore(
      store,
      [{ op: "setText", id: "blk_aaaaaaaaaa", text: "mine" }],
      testEventContext({ at: 50_000 }),
    )
    // The cache is wiped (a new generation) and a snapshot lands: the
    // replica knows the block at an older stamp, and another block at a
    // newer one than anything this device wrote.
    await store.clearCache()
    const older = "000000000000010-0000-other"
    const newer = `${String(Date.now() + 60_000).padStart(15, "0")}-0000-other`
    await store.importCacheRows([
      ...liveBlock("blk_aaaaaaaaaa", "theirs, older", older, 4),
      ...liveBlock("a", "a", older, 4).map((r) =>
        r.key === "type" ? { ...r, value: '"note"' } : r,
      ),
      ...[
        row("link", "a|blk_aaaaaaaaaa|child", "deleted", "null", older, 4),
        row("link", "a|blk_aaaaaaaaaa|child", "source_id", '"a"', older, 4),
        row("link", "a|blk_aaaaaaaaaa|child", "destination_id", '"blk_aaaaaaaaaa"', older, 4),
        row("link", "a|blk_aaaaaaaaaa|child", "kind", '"child"', older, 4),
        row("link", "a|blk_aaaaaaaaaa|child", "sort_key", '"a0"', older, 4),
      ],
      ...liveBlock("blk_bbbbbbbbbb", "theirs, newer", newer, 9),
    ])
    expect((await store.getGraph()).nodes.get("blk_aaaaaaaaaa")?.text).toBe("theirs, older")
    await store.applyUnpushedToCache()
    // The queued edit wins where its stamp is higher…
    expect((await store.getGraph()).nodes.get("blk_aaaaaaaaaa")?.text).toBe("mine")
    expect((await store.unpushedEvents()).some((event) => event.id === edit.id)).toBe(true)
    // …and a queued create does not beat a newer row of the same block.
    await applyOpsToStore(
      store,
      [{ op: "setText", id: "blk_bbbbbbbbbb", text: "mine, older" }],
      testEventContext({ at: 50_000, stamp: () => "000000000050000-0000-test.tab" }),
    )
    await store.applyUnpushedToCache()
    expect((await store.getGraph()).nodes.get("blk_bbbbbbbbbb")?.text).toBe("theirs, newer")
  })

  it("rebuildCacheFromLog puts the cache back as the log says", async () => {
    const { driver, store } = await makeStoreWithDriver()
    await seed(store, "a", "- one\n  id:: blk_aaaaaaaaaa\n")
    const before = await rowsOf(driver, "block", "blk_aaaaaaaaaa")
    // A row written around the store: wrong text, a stamp from the future.
    await driver.exec(
      "UPDATE events_log_cache SET value = '\"corrupt\"', hlc = '999999999999999-0000-x' " +
        "WHERE entity = 'block' AND entity_id = 'blk_aaaaaaaaaa' AND key = 'text'",
    )
    expect((await store.getGraph()).nodes.get("blk_aaaaaaaaaa")?.text).toBe("corrupt")
    await store.rebuildCacheFromLog()
    expect(await rowsOf(driver, "block", "blk_aaaaaaaaaa")).toEqual(before)
    expect((await store.getGraph()).nodes.get("blk_aaaaaaaaaa")?.text).toBe("one")
  })

  it("liveEntitiesOf answers the patch: live touched blocks, and the live links at them", async () => {
    const { store } = await makeStoreWithDriver()
    await seed(
      store,
      "a",
      "- one\n  id:: blk_one0000000\n  - deep\n    id:: blk_deep000000\n- two\n  id:: blk_two0000000\n",
    )
    await applyOps(store, deleteBlockOps("blk_two0000000", await store.getGraph()))
    const { nodes, links } = await store.liveEntitiesOf({
      blocks: new Set(["blk_one0000000", "blk_two0000000", "blk_ghost00000"]),
      links: new Set(["a|blk_two0000000|child"]),
    })
    // The live block only; the deleted and the unknown are not answered for.
    expect(nodes.map((node) => node.id)).toEqual(["blk_one0000000"])
    // The links adjacent to `one`, live by their own row; the named link is
    // tombstoned (the delete unlinked it) and is left out.
    expect(links.map((link) => `${link.source_id}>${link.destination_id}`).sort()).toEqual([
      "a>blk_one0000000",
      "blk_one0000000>blk_deep000000",
    ])
  })

  it("cacheRowsOf reads every key of the named entities, and foldOfLog agrees with it", async () => {
    const { store } = await makeStoreWithDriver()
    await seed(store, "a", "- one\n  id:: blk_aaaaaaaaaa\n")
    await applyOps(store, [{ op: "setText", id: "blk_aaaaaaaaaa", text: "one!" }])
    await applyOps(store, deleteBlockOps("blk_aaaaaaaaaa", await store.getGraph()))
    const keys = {
      blocks: new Set(["a", "blk_aaaaaaaaaa"]),
      links: new Set(["a|blk_aaaaaaaaaa|child"]),
    }
    const rows = await store.cacheRowsOf(keys)
    const held = new Map(rows.map((r) => [cacheRowKey(r.entity, r.entity_id, r.key), r]))
    expect([...held.keys()].sort()).toEqual(
      [
        ["block", "a", "deleted"],
        ["block", "a", "notes_id"],
        ["block", "a", "text"],
        ["block", "a", "type"],
        ["block", "blk_aaaaaaaaaa", "deleted"],
        ["block", "blk_aaaaaaaaaa", "notes_id"],
        ["block", "blk_aaaaaaaaaa", "text"],
        ["block", "blk_aaaaaaaaaa", "type"],
        ["link", "a|blk_aaaaaaaaaa|child", "deleted"],
        ["link", "a|blk_aaaaaaaaaa|child", "destination_id"],
        ["link", "a|blk_aaaaaaaaaa|child", "kind"],
        ["link", "a|blk_aaaaaaaaaa|child", "sort_key"],
        ["link", "a|blk_aaaaaaaaaa|child", "source_id"],
      ]
        .map(([entity, id, key]) => cacheRowKey(entity, id, key))
        .sort(),
    )
    const fold = await store.foldOfLog(keys)
    expect(fold.size).toBe(held.size)
    for (const [key, want] of fold) {
      expect(held.get(key)).toMatchObject({ value: want.value, hlc: want.hlc })
    }
    // The whole log folds to the same rows.
    expect((await store.foldOfLog()).size).toBe(held.size)
  })

  it("getAllRows returns every entity, blocks and links", async () => {
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
    const { store } = await makeStoreWithDriver()
    await seed(store, "a", OUTLINE)
    await applyOps(store, deleteNoteOps("a", await store.getGraph()))

    const { nodes, links } = await store.getAllRows()
    expect(nodes.length + links.length).toBe(5) // note + 2 blocks + 2 retained links
    const tombstones = [...nodes, ...links]
      .map((row) => row.deleted_at)
      .filter((value) => value !== undefined)
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
    // …though its rows are still on disk.
    expect((await store.getAllRows()).nodes).toHaveLength(3)
    expect(await rowsOf(driver, "block", "blk_child00000")).toHaveLength(4)
  })

  it("keeps the link to a deleted node — the position a restore would use", async () => {
    const { store } = await makeStoreWithDriver()
    await seed(store, "a", OUTLINE)
    // Delete the note: the whole subtree is retired, but EVERY containment row
    // that describes its shape is retained, not cascaded — including the
    // note's own link to the block that was directly under it.
    await applyOps(store, deleteNoteOps("a", await store.getGraph()))

    const { links } = await store.getAllRows()
    expect(
      links
        .sort((a, b) => (a.source_id < b.source_id ? -1 : 1))
        .map(({ source_id, destination_id, deleted_at }) => ({
          source_id,
          destination_id,
          deleted_at,
        })),
    ).toEqual([
      { source_id: "a", destination_id: "blk_parent0000", deleted_at: undefined },
      { source_id: "blk_parent0000", destination_id: "blk_child00000", deleted_at: undefined },
    ])
  })

  it("re-creating a deleted id revives it cleanly (no stale tombstone)", async () => {
    const { driver, store } = await makeStoreWithDriver()
    await seed(store, "a", OUTLINE)
    await seed(store, "a", "- parent\n  id:: blk_parent0000\n")
    await seed(store, "a", OUTLINE)

    expect(await noteOf(store, "a")).toBe(OUTLINE)
    expect(
      (await rowsOf(driver, "block", "blk_child00000")).find((row) => row.key === "deleted"),
    ).toMatchObject({ value: "null" })
    // And the revived row goes out live, not as a tombstone.
    const { nodes } = await store.getAllRows()
    expect(nodes.find((node) => node.id === "blk_child00000")?.deleted_at).toBeUndefined()
  })

  it("a pulled tombstone lands and hides the row, without removing it", async () => {
    const { store } = await makeStoreWithDriver()
    await seed(store, "a", OUTLINE)
    const later = Date.now() + 1000
    await store.applyPulledEvents([
      {
        id: "evt_remote_delete",
        seq: 900,
        entity: "block",
        entity_id: "blk_child00000",
        action: "delete",
        key: "",
        value: later,
        batch: "bat_other",
        device: "other.tab",
        at: later,
        v: KEY_EVENT_VERSION,
        hlc: `${String(later).padStart(15, "0")}-0000-other.tab`,
      },
    ])
    expect(await noteOf(store, "a")).toBe("- parent\n  id:: blk_parent0000\n")
    const { nodes } = await store.getAllRows()
    expect(nodes).toHaveLength(3)
    expect(nodes.find((node) => node.id === "blk_child00000")?.deleted_at).toBe(later)
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

    // Each key row placed in the log, and the cache row it set stamped with
    // its seq: a row's `seq` is its event's (docs/events-log-cache.md).
    expect(
      (await store.cacheRowsOf({ blocks: new Set(["a"]), links: new Set() })).every(
        (row) => row.seq === null,
      ),
    ).toBe(true)
    await store.markEventsPushed(queued.map((event, i) => [event.id, 100 + i] as const))
    expect(await store.unpushedEvents()).toEqual([])
    expect(await driver.exec("SELECT id, seq FROM events_log ORDER BY position")).toEqual(
      queued.map((event, i) => ({ id: event.id, seq: 100 + i })),
    )
    for (const [i, event] of queued.entries()) {
      if (event.entity !== "block" && event.entity !== "link") continue
      const { key } = registerOf(event)
      expect(
        await driver.exec(
          "SELECT seq FROM events_log_cache WHERE entity = ? AND entity_id = ? AND key = ?",
          [event.entity, event.entity_id, key],
        ),
      ).toEqual([{ seq: 100 + i }])
    }
    // The graph reads an entity's seq as the highest of its rows'.
    const graph = await store.getGraph()
    expect(graph.nodes.get("blk_aaaaaaaaaa")?.seq).toBe(
      100 + queued.findLastIndex((event) => event.entity_id === "blk_aaaaaaaaaa"),
    )
  })

  it("keeps each event's stamp, its own and the ones it pulls, and none where none was sent", async () => {
    const { driver, store } = await makeStoreWithDriver()
    const minted: string[] = []
    const stamp = () => {
      minted.push(`000000000005000-${String(minted.length).padStart(4, "0")}-dev.tab`)
      return minted[minted.length - 1]
    }
    const markdown = parse("- one\n  id:: blk_aaaaaaaaaa\n")
    const ops = docToOps("a", { ...markdown, props: null }, await store.getGraph())
    await applyOpsToStore(store, ops, testEventContext({ stamp }))
    expect(minted.length).toBeGreaterThan(1)
    expect((await store.unpushedEvents()).map((event) => event.hlc)).toEqual(minted)
    const pulled = (seq: number, hlc?: string) => ({
      id: `evt_remote_${seq}`,
      seq,
      entity: "block" as const,
      entity_id: `blk_remote${seq}000`,
      action: "create" as const,
      patch: { type: "paragraph", text: "pulled", props: null, notes_id: "a" },
      v: 1,
      batch: "b2",
      device: "other.tab",
      at: 200,
      ...(hlc ? { hlc } : {}),
    })
    await store.applyPulledEvents(keyed([pulled(1, "000000000000200-0000-other.tab"), pulled(2)]))
    expect(
      await driver.exec(
        "SELECT event_id, hlc FROM events_log WHERE seq IS NOT NULL AND key = '' ORDER BY seq",
      ),
    ).toEqual([
      { event_id: "evt_remote_1", hlc: "000000000000200-0000-other.tab" },
      { event_id: "evt_remote_2", hlc: null },
    ])
    const log = await store.eventLog()
    expect(log[0].hlc).toBe("000000000000200-0000-other.tab")
    expect("hlc" in log.find((event) => event.event === "evt_remote_2")!).toBe(false)
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
      action: "set",
      key: "text",
      value: "xyzw",
      base_seq: first[0].base_seq,
    })
    expect(
      (await rowsOf(driver, "block", "blk_aaaaaaaaaa")).find((row) => row.key === "text"),
    ).toMatchObject({ value: '"xyzw"', hlc: last[0].hlc })
    // The log holds exactly the pushed events plus the one survivor.
    const pushed = await driver.exec("SELECT COUNT(*) AS n FROM events_log WHERE seq IS NOT NULL")
    expect(await driver.exec("SELECT COUNT(*) AS n FROM events_log")).toEqual([
      { n: Number(pushed[0].n) + 1 },
    ])
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
    const next = opsToKeyEvents(
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
    const seeded = new Set(
      (await seed(store, "a", "- x\n  id:: blk_aaaaaaaaaa\n")).map((e) => e.id),
    )
    await applyOpsToStore(store, [{ op: "setText", id: "blk_aaaaaaaaaa", text: "xy" }], ctx(10_000))
    await applyOpsToStore(store, [{ op: "setType", id: "blk_aaaaaaaaaa", type: "h1" }], ctx(10_100))
    await applyOpsToStore(
      store,
      [{ op: "setText", id: "blk_aaaaaaaaaa", text: "xyz" }],
      ctx(10_200),
    )
    const typed = (await store.unpushedEvents()).filter((event) => !seeded.has(event.id))
    expect(typed.map((event) => [event.key, event.value])).toEqual([
      ["text", "xy"],
      ["type", "h1"],
      ["text", "xyz"],
    ])
  })

  it("takes in the pulled log, places an own event the pull brings back, and reads the whole in order", async () => {
    const { driver, store } = await makeStoreWithDriver()
    const own = await seed(store, "a", "- one\n  id:: blk_aaaaaaaaaa\n")
    // The replica took the push but the answer was lost: the pull brings
    // this device's own events back, placed, among another device's.
    const other = keyed([
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
    ])
    const pulled = [
      ...other,
      ...own.map((event, i) => ({
        ...event,
        seq: 200 + i,
        event_seq: 2,
        origin: "replica",
        actor: 111,
      })),
    ] as Parameters<typeof store.applyPulledEvents>[0]
    await store.applyPulledEvents(pulled)
    // Nothing left to push: the pull placed them.
    expect(await store.unpushedEvents()).toEqual([])
    // The cache takes the pulled events in the same write: `b` is a row now.
    expect((await store.getGraph()).nodes.get("b")?.text).toBe("B")
    // Its create, read per key: liveness, type, text and a null notes_id.
    expect(await rowsOf(driver, "block", "b")).toHaveLength(4)

    // A new edit, not yet pushed, reads after everything placed.
    const typed = await applyOpsToStore(
      store,
      [{ op: "setText", id: "blk_aaaaaaaaaa", text: "one!" }],
      ctx(9_000),
    )
    const log = await store.eventLog()
    expect(log.map((event) => [event.id, event.seq, event.pending ?? false])).toEqual([
      ...other.map((event) => [event.id, event.seq, false]),
      ...own.map((event, i) => [event.id, 200 + i, false]),
      [typed[0].id, 200 + own.length, true],
    ])
    expect(log[0]).toMatchObject({ origin: "replica", actor: 222, received_at: 600, tz: -300 })
  })

  it("logs a pulled view event as history, and keeps no cache row for it", async () => {
    const { driver, store } = await makeStoreWithDriver()
    // A view event from before docs/removing-views.md, as a pull brings it.
    const event = {
      id: "evt_view",
      entity: "view" as const,
      entity_id: "v1",
      action: "create" as const,
      key: "",
      value: null,
      batch: "bat_view",
      device: "dev.other",
      at: 10,
      v: KEY_EVENT_VERSION,
      seq: 1,
    }
    await store.applyPulledEvents([event])
    expect((await store.eventLog()).map((logged) => logged.id)).toEqual(["evt_view"])
    expect(await driver.exec("SELECT name FROM sqlite_master WHERE name = 'views'")).toEqual([])
  })
})
