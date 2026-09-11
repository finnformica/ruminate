// tenant-guard: exempt — these tests read and seed raw storage on purpose
// (that is how they pin what the store wrote, tombstones included).
import { describe, expect, it } from "vitest"
import migration0001 from "../../migrations/0001_init.sql?raw"
import migration0002 from "../../migrations/0002_nodes.sql?raw"
import { parse } from "../blocks/parse"
import type { BlockProps } from "../blocks/types"
import { rollup } from "./graph"
import type { NoteStore } from "./note-store"
import { deleteBlockOps, deletePageOps, docToOps } from "./ops"
import { createNodeSqlDriver } from "./sql-node-test-driver"
import { openSqlNoteStore } from "./sql-note-store"

async function makeStoreWithDriver() {
  const driver = createNodeSqlDriver()
  const store = await openSqlNoteStore(driver)
  return { driver, store }
}

/** Save a page as the app does: diff the doc against the live graph into ops,
 * apply them. Markdown is only the fixture's spelling. */
async function seed(
  store: NoteStore,
  id: string,
  markdown: string,
  props: BlockProps | null = null,
) {
  return store.applyOps(docToOps(id, { ...parse(markdown), props }, await store.getGraph()))
}

/** A page's markdown projection off the live graph, or null when absent. */
const noteOf = async (store: NoteStore, id: string) => rollup(id, await store.getGraph())

describe("openSqlNoteStore", () => {
  it("lands a saved page as typed node and link rows", async () => {
    const { driver, store } = await makeStoreWithDriver()
    await seed(store, "a", "# Hello\n  id:: blk_aaaaaaaaaa\n[ ] task\n  id:: blk_bbbbbbbbbb\n")

    const nodes = await driver.exec("SELECT id, type, text FROM nodes ORDER BY id")
    expect(nodes).toEqual([
      { id: "a", type: "page", text: "a" },
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
    const diff = await seed(
      store,
      "a",
      "- one\n  id:: blk_aaaaaaaaaa\n- two edited\n  id:: blk_bbbbbbbbbb\n",
    )
    expect(diff.nodes.map((node) => node.id)).toEqual(["blk_bbbbbbbbbb"])
    expect(diff.links).toEqual([])
    expect(diff.deleteNodes).toEqual([])
    expect(diff.deleteLinks).toEqual([])

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

  it("an empty batch is a no-op (empty diff, no row churn)", async () => {
    const { store } = await makeStoreWithDriver()
    const content = "- one\n  id:: blk_aaaaaaaaaa\n  - two\n    id:: blk_bbbbbbbbbb\n"
    await seed(store, "a", content)
    // An identical doc diffs to no ops at all, so nothing reaches the rows.
    const diff = await seed(store, "a", content)
    expect(diff).toEqual({ nodes: [], links: [], deleteNodes: [], deleteLinks: [] })
  })

  it("drops a set on a node it does not hold (deleted underneath)", async () => {
    const { store } = await makeStoreWithDriver()
    const diff = await store.applyOps([{ op: "setText", id: "blk_ghost00000", text: "boo" }])
    expect(diff).toEqual({ nodes: [], links: [], deleteNodes: [], deleteLinks: [] })
  })

  it("removing a block from a note tombstones its link row and keeps its node (diffed)", async () => {
    const { driver, store } = await makeStoreWithDriver()
    await seed(store, "a", "- keep\n  id:: blk_aaaaaaaaaa\n- drop\n  id:: blk_bbbbbbbbbb\n")
    const diff = await seed(store, "a", "- keep\n  id:: blk_aaaaaaaaaa\n")
    // An unlink, not a delete: the block is out of reach (the basket's), its
    // row live, and only the tombstoned link travels.
    expect(diff.deleteNodes).toEqual([])
    expect(diff.deleteLinks).toEqual([])
    expect(diff.nodes).toEqual([])
    expect(diff.links).toEqual([
      expect.objectContaining({ destination_id: "blk_bbbbbbbbbb", deleted_at: expect.any(Number) }),
    ])
    expect(await driver.exec("SELECT deleted_at FROM nodes WHERE id = 'blk_bbbbbbbbbb'")).toEqual([
      { deleted_at: null },
    ])
    expect(await noteOf(store, "a")).toBe("- keep\n  id:: blk_aaaaaaaaaa\n")
  })

  it("deleting a block tombstones its node and link rows (diffed)", async () => {
    const { driver, store } = await makeStoreWithDriver()
    await seed(store, "a", "- keep\n  id:: blk_aaaaaaaaaa\n- drop\n  id:: blk_bbbbbbbbbb\n")
    const diff = await store.applyOps(deleteBlockOps("blk_bbbbbbbbbb", await store.getGraph()))
    // Nothing is removed: the diff carries the tombstoned rows, so the delete
    // replicates like any other change.
    expect(diff.deleteNodes).toEqual([])
    expect(diff.deleteLinks).toEqual([])
    expect(diff.nodes.map((node) => node.id)).toEqual(["blk_bbbbbbbbbb"])
    expect(diff.nodes[0].deleted_at).toEqual(expect.any(Number))
    expect(diff.links).toEqual([
      expect.objectContaining({ destination_id: "blk_bbbbbbbbbb", deleted_at: expect.any(Number) }),
    ])
    expect(await driver.exec("SELECT deleted_at FROM nodes WHERE id = 'blk_bbbbbbbbbb'")).toEqual([
      { deleted_at: expect.any(Number) },
    ])
    expect(await noteOf(store, "a")).toBe("- keep\n  id:: blk_aaaaaaaaaa\n")
  })

  it("tombstones a page's rows on delete and reports the diff", async () => {
    const { driver, store } = await makeStoreWithDriver()
    await seed(store, "a", "# A note\n  id:: blk_aaaaaaaaaa\n")
    const diff = await store.applyOps(deletePageOps("a", await store.getGraph()))

    expect(diff.deleteNodes).toEqual([])
    expect(diff.nodes.map((node) => node.id).sort()).toEqual(["a", "blk_aaaaaaaaaa"])
    // ONE stamp for the whole delete: a future restore is "revive the rows
    // stamped at T".
    expect(new Set(diff.nodes.map((node) => node.deleted_at)).size).toBe(1)
    expect(await noteOf(store, "a")).toBeNull()
    expect((await store.getGraph()).nodes.size).toBe(0)
    // The rows — and the link that positions the block under the page — are
    // still there, which is what makes a restore possible at all.
    expect(await driver.exec("SELECT COUNT(*) AS n FROM nodes")).toEqual([{ n: 2 }])
    expect(await driver.exec("SELECT COUNT(*) AS n FROM link")).toEqual([{ n: 1 }])
  })

  it("retitling a note rewrites exactly one row — the page's", async () => {
    const { driver, store } = await makeStoreWithDriver()
    const id = "blk_page00000"
    await seed(store, id, "keep me\n  id:: blk_aaaaaaaaaa\n", { title: "Old Name" })
    const before = await driver.exec("SELECT id, text, updated_at FROM nodes ORDER BY id")

    const diff = await seed(store, id, "keep me\n  id:: blk_aaaaaaaaaa\n", { title: "New Name" })

    // ONE node row, no link rows: a rename can no longer bump `updated_at` on
    // blocks the user never touched, so it cannot clobber a concurrent edit
    // to one of them under per-row LWW.
    expect(diff.nodes.map((node) => node.id)).toEqual([id])
    expect(diff.links).toEqual([])
    expect(diff.nodes[0].text).toBe("New Name")

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
      { value: "4" },
    ])
    expect(
      await driver.exec("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"),
    ).toEqual([{ name: "link" }, { name: "meta" }, { name: "nodes" }])
  })

  it("adds the soft-delete columns to a v2 database in place, keeping its rows", async () => {
    const driver = createNodeSqlDriver()
    // A v2 store: the real ladder, stopped one step short.
    await driver.execScript(migration0001 + "\n" + migration0002)
    await driver.batch([
      {
        sql: "INSERT INTO nodes (id, type, text, props, updated_at) VALUES (?, ?, ?, ?, ?)",
        params: ["a", "page", "a", null, 100],
      },
    ])

    const store = await openSqlNoteStore(driver)
    // The row survives the DDL step, under its own id: the ladder adds
    // columns, it never rewrites rows.
    expect(await noteOf(store, "a")).toBe("\n")
    expect(await driver.exec("SELECT value FROM meta WHERE key = 'schema_version'")).toEqual([
      { value: "4" },
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
        params: ["a", "page", "a", null, 100],
      },
    ])
    const store = await openSqlNoteStore(driver)
    expect(await noteOf(store, "a")).toBe("\n")
    expect(await driver.exec("SELECT value FROM meta WHERE key = 'schema_version'")).toEqual([
      { value: "4" },
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
      { value: "4" },
    ])
  })

  it("keeps existing data when reopening a database with the current schema", async () => {
    const { driver, store } = await makeStoreWithDriver()
    await seed(store, "blk_page0000", "keep me\n  id:: blk_aaaaaaaaaa\n")
    const reopened = await openSqlNoteStore(driver)
    expect(await noteOf(reopened, "blk_page0000")).toBe("keep me\n  id:: blk_aaaaaaaaaa\n")
  })

  it("never rewrites rows on open — a title-shaped page id is left alone", async () => {
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

  it("leaves daily and weekly pages on their date ids (the natural-key carve-out)", async () => {
    const { driver, store } = await makeStoreWithDriver()
    await seed(store, "2026-08-31", "today\n  id:: blk_aaaaaaaaaa\n")
    await seed(store, "2026-W35", "this week\n  id:: blk_bbbbbbbbbb\n")

    const reopened = await openSqlNoteStore(driver)
    // Byte-identical: a date page's text IS its id, so no title is emitted.
    expect(await noteOf(reopened, "2026-08-31")).toBe("today\n  id:: blk_aaaaaaaaaa\n")
    expect(await noteOf(reopened, "2026-W35")).toBe("this week\n  id:: blk_bbbbbbbbbb\n")
    expect(await driver.exec("SELECT id FROM nodes WHERE type = 'page' ORDER BY id")).toEqual([
      { id: "2026-08-31" },
      { id: "2026-W35" },
    ])
  })

  it("clear wipes every row and keeps meta", async () => {
    const { driver, store } = await makeStoreWithDriver()
    await seed(store, "old", "- gone\n  id:: blk_aaaaaaaaaa\n")
    await store.setMeta("d1_pull_cursor", "123")
    await store.clear()
    expect(await driver.exec("SELECT COUNT(*) AS n FROM nodes")).toEqual([{ n: 0 }])
    expect(await driver.exec("SELECT COUNT(*) AS n FROM link")).toEqual([{ n: 0 }])
    expect(await store.getMeta("d1_pull_cursor")).toBe("123")
  })

  it("applyPull upserts and deletes rows verbatim (remote updated_at kept)", async () => {
    const { driver, store } = await makeStoreWithDriver()
    await seed(store, "a", "- local\n  id:: blk_aaaaaaaaaa\n")
    await store.applyPull({
      nodes: [{ id: "blk_aaaaaaaaaa", type: "ul", text: "remote", props: null, updated_at: 42 }],
      links: [],
      deleteNodes: [],
      deleteLinks: [],
    })
    expect(
      await driver.exec("SELECT text, updated_at FROM nodes WHERE id = 'blk_aaaaaaaaaa'"),
    ).toEqual([{ text: "remote", updated_at: 42 }])
    expect(await noteOf(store, "a")).toBe("- remote\n  id:: blk_aaaaaaaaaa\n")

    await store.applyPull({ nodes: [], links: [], deleteNodes: ["a"], deleteLinks: [] })
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
    await store.applyOps(deleteBlockOps("blk_aaaaaaaaaa", await store.getGraph()))
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
    await store.applyOps(deletePageOps("a", await store.getGraph()))

    const stamps = await driver.exec(
      "SELECT deleted_at FROM nodes UNION ALL SELECT deleted_at FROM link",
    )
    expect(stamps).toHaveLength(5) // page + 2 blocks + 2 retained links
    const tombstones = stamps.map((row) => row.deleted_at).filter((value) => value !== null)
    expect(tombstones).toHaveLength(3) // the three nodes; links are retained
    expect(new Set(tombstones).size).toBe(1)
  })

  it("a tombstoned node never renders, and neither does a link into it", async () => {
    const { driver, store } = await makeStoreWithDriver()
    await seed(store, "a", OUTLINE)
    await store.applyOps(deleteBlockOps("blk_child00000", await store.getGraph()))

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
    // Delete the page: the whole subtree is retired, but EVERY containment row
    // that describes its shape is retained, not cascaded — including the
    // page's own link to the block that was directly under it.
    await store.applyOps(deletePageOps("a", await store.getGraph()))

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
      deleteNodes: [],
      deleteLinks: [],
    })
    expect(await noteOf(store, "a")).toBe("- parent\n  id:: blk_parent0000\n")
    expect(await driver.exec("SELECT COUNT(*) AS n FROM nodes")).toEqual([{ n: 3 }])
  })
})
