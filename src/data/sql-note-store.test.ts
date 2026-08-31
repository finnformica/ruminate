import { describe, expect, it } from "vitest"
import { describeNoteStoreConformance } from "./note-store-conformance"
import { createNodeSqlDriver } from "./sql-node-test-driver"
import { openSqlNoteStore } from "./sql-note-store"

describeNoteStoreConformance("sql-backed store", () => openSqlNoteStore(createNodeSqlDriver()))

async function makeStoreWithDriver() {
  const driver = createNodeSqlDriver()
  const store = await openSqlNoteStore(driver)
  return { driver, store }
}

describe("openSqlNoteStore (sql-specific behavior)", () => {
  it("decomposes a written note into typed node and link rows", async () => {
    const { driver, store } = await makeStoreWithDriver()
    await store.writeNotes({
      a: "# Hello\n  id:: blk_aaaaaaaaaa\n[ ] task\n  id:: blk_bbbbbbbbbb\n",
    })

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
  })

  it("a save lands as a row diff: unchanged rows keep their updated_at and sort keys", async () => {
    const { driver, store } = await makeStoreWithDriver()
    await store.writeNotes({
      a: "- one\n  id:: blk_aaaaaaaaaa\n- two\n  id:: blk_bbbbbbbbbb\n",
    })
    const beforeLinks = await driver.exec(
      "SELECT destination_id, sort_key, updated_at FROM link ORDER BY destination_id",
    )
    const beforeOne = await driver.exec("SELECT * FROM nodes WHERE id = 'blk_aaaaaaaaaa'")

    // Touch only the second block.
    const diff = await store.writeNotes({
      a: "- one\n  id:: blk_aaaaaaaaaa\n- two edited\n  id:: blk_bbbbbbbbbb\n",
    })
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

  it("an identical save is a no-op (empty diff, no row churn)", async () => {
    const { store } = await makeStoreWithDriver()
    const content = "- one\n  id:: blk_aaaaaaaaaa\n  - two\n    id:: blk_bbbbbbbbbb\n"
    await store.writeNotes({ a: content })
    const diff = await store.writeNotes({ a: content })
    expect(diff).toEqual({ nodes: [], links: [], deleteNodes: [], deleteLinks: [] })
  })

  it("removing a block from a note deletes its node and link rows (diffed)", async () => {
    const { driver, store } = await makeStoreWithDriver()
    await store.writeNotes({
      a: "- keep\n  id:: blk_aaaaaaaaaa\n- drop\n  id:: blk_bbbbbbbbbb\n",
    })
    const diff = await store.writeNotes({ a: "- keep\n  id:: blk_aaaaaaaaaa\n" })
    expect(diff.deleteNodes).toEqual(["blk_bbbbbbbbbb"])
    expect(diff.deleteLinks).toEqual([["a", "blk_bbbbbbbbbb", "child"]])
    expect(await driver.exec("SELECT id FROM nodes WHERE id = 'blk_bbbbbbbbbb'")).toEqual([])
  })

  it("removes a note's rows on delete and reports the diff", async () => {
    const { driver, store } = await makeStoreWithDriver()
    await store.writeNotes({ a: "# A note\n  id:: blk_aaaaaaaaaa\n" })
    const diff = await store.deleteNote("a")

    expect(diff.deleteNodes.sort()).toEqual(["a", "blk_aaaaaaaaaa"])
    expect(await driver.exec("SELECT * FROM nodes")).toEqual([])
    expect(await driver.exec("SELECT * FROM link")).toEqual([])
  })

  it("stores frontmatter as parsed entries in the page props", async () => {
    const { driver, store } = await makeStoreWithDriver()
    await store.writeNotes({
      a: "---\nupdated_at: 2026-01-02T03:04:05.000Z\n---\nHello\n  id:: blk_aaaaaaaaaa\n",
    })
    const rows = await driver.exec("SELECT props FROM nodes WHERE id = 'a'")
    expect(rows).toEqual([{ props: JSON.stringify({ updated_at: "2026-01-02T03:04:05.000Z" }) }])
    // And the rollup reproduces the exact saved bytes (canonical fixpoint).
    expect(await store.getNote("a")).toBe(
      "---\nupdated_at: 2026-01-02T03:04:05.000Z\n---\nHello\n  id:: blk_aaaaaaaaaa\n",
    )
  })

  it("normalizes near-miss marker spellings at ingest (typed rows, canonical rollup)", async () => {
    const { driver, store } = await makeStoreWithDriver()
    await store.writeNotes({
      a: "[] buy milk\n  id:: blk_aaaaaaaaaa\n* item\n  id:: blk_bbbbbbbbbb\n",
    })
    const rows = await driver.exec(
      "SELECT id, type, text FROM nodes WHERE id LIKE 'blk_%' ORDER BY id",
    )
    expect(rows).toEqual([
      { id: "blk_aaaaaaaaaa", type: "todo", text: "buy milk" },
      { id: "blk_bbbbbbbbbb", type: "ul", text: "item" },
    ])
    expect(await store.getNote("a")).toBe(
      "[ ] buy milk\n  id:: blk_aaaaaaaaaa\n- item\n  id:: blk_bbbbbbbbbb\n",
    )
  })

  it("transforms legacy rows on open (data_version 1) so old data gains types", async () => {
    const driver = createNodeSqlDriver()
    await openSqlNoteStore(driver)
    // Simulate a pre-transform corpus: raw near-miss text rows and legacy
    // frontmatter props, landed after the (empty) open — like a first pull.
    await driver.batch([
      {
        sql: "INSERT INTO nodes (id, type, text, props, updated_at) VALUES (?, ?, ?, ?, ?)",
        params: ["a", "page", "a", JSON.stringify({ frontmatter: "pinned: true" }), 100],
      },
      {
        sql: "INSERT INTO nodes (id, type, text, props, updated_at) VALUES (?, ?, ?, ?, ?)",
        params: ["blk_aaaaaaaaaa", "text", "[] buy milk", null, 100],
      },
      {
        sql:
          "INSERT INTO link (source_id, destination_id, kind, sort_key, updated_at) " +
          "VALUES (?, ?, 'child', 'a0', ?)",
        params: ["a", "blk_aaaaaaaaaa", 100],
      },
    ])

    const store = await openSqlNoteStore(driver)
    expect(await store.getNote("a")).toBe(
      "---\npinned: true\n---\n[ ] buy milk\n  id:: blk_aaaaaaaaaa\n",
    )
    const rows = await driver.exec("SELECT type, updated_at FROM nodes WHERE id = 'blk_aaaaaaaaaa'")
    expect(rows[0].type).toBe("todo")
    // Fresh updated_at → the rewritten row wins LWW and replicates.
    expect(Number(rows[0].updated_at)).toBeGreaterThan(100)
    expect(await store.getMeta("data_version")).toBe("1")
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
    expect(await store.getAllNotes()).toEqual({})
    expect(await driver.exec("SELECT value FROM meta WHERE key = 'schema_version'")).toEqual([
      { value: "2" },
    ])
    expect(
      await driver.exec("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"),
    ).toEqual([{ name: "link" }, { name: "meta" }, { name: "nodes" }])
  })

  it("resets and re-migrates a database with an unknown schema_version", async () => {
    const { driver, store } = await makeStoreWithDriver()
    await store.writeNotes({ a: "stale\n  id:: blk_aaaaaaaaaa\n" })
    await driver.exec("UPDATE meta SET value = '999' WHERE key = 'schema_version'")

    const reopened = await openSqlNoteStore(driver)
    expect(await reopened.getAllNotes()).toEqual({})
    expect(await driver.exec("SELECT value FROM meta WHERE key = 'schema_version'")).toEqual([
      { value: "2" },
    ])
  })

  it("keeps existing data when reopening a database with the current schema", async () => {
    const { driver, store } = await makeStoreWithDriver()
    await store.writeNotes({ a: "keep me\n  id:: blk_aaaaaaaaaa\n" })
    const reopened = await openSqlNoteStore(driver)
    expect(await reopened.getNote("a")).toBe("keep me\n  id:: blk_aaaaaaaaaa\n")
  })

  it("reports row counts", async () => {
    const { store } = await makeStoreWithDriver()
    await store.writeNotes({
      a: "one\n  id:: blk_aaaaaaaaaa\n[[b]]\n  id:: blk_bbbbbbbbbb\n",
    })
    expect(await store.counts()).toEqual({ pages: 1, nodes: 3, links: 2 })
  })

  it("replaceAll wipes and repopulates the graph", async () => {
    const { store } = await makeStoreWithDriver()
    await store.writeNotes({ old: "- gone\n  id:: blk_aaaaaaaaaa\n" })
    await store.replaceAll({ fresh: "- hi\n  id:: blk_bbbbbbbbbb\n" })
    expect(await store.getAllNotes()).toEqual({ fresh: "- hi\n  id:: blk_bbbbbbbbbb\n" })
  })

  it("applyPull upserts and deletes rows verbatim (remote updated_at kept)", async () => {
    const { driver, store } = await makeStoreWithDriver()
    await store.writeNotes({ a: "- local\n  id:: blk_aaaaaaaaaa\n" })
    await store.applyPull({
      nodes: [{ id: "blk_aaaaaaaaaa", type: "ul", text: "remote", props: null, updated_at: 42 }],
      links: [],
      deleteNodes: [],
      deleteLinks: [],
    })
    expect(
      await driver.exec("SELECT text, updated_at FROM nodes WHERE id = 'blk_aaaaaaaaaa'"),
    ).toEqual([{ text: "remote", updated_at: 42 }])
    expect(await store.getNote("a")).toBe("- remote\n  id:: blk_aaaaaaaaaa\n")

    await store.applyPull({ nodes: [], links: [], deleteNodes: ["a"], deleteLinks: [] })
    expect(await store.getNote("a")).toBeNull()
  })

  it("getAllRows returns every row of both tables", async () => {
    const { store } = await makeStoreWithDriver()
    await store.writeNotes({ a: "- x\n  id:: blk_aaaaaaaaaa\n" })
    const { nodes, links } = await store.getAllRows()
    expect(nodes.map((node) => node.id).sort()).toEqual(["a", "blk_aaaaaaaaaa"])
    expect(links).toHaveLength(1)
    expect(links[0]).toMatchObject({
      source_id: "a",
      destination_id: "blk_aaaaaaaaaa",
      kind: "child",
    })
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
