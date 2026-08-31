// tenant-guard: exempt — these tests read and seed raw storage on purpose
// (that is how they pin what the store wrote, tombstones included).
import { describe, expect, it } from "vitest"
import migration0001 from "../../migrations/0001_init.sql?raw"
import migration0002 from "../../migrations/0002_nodes.sql?raw"
import { describeNoteStoreConformance } from "./note-store-conformance"
import { derivePageId } from "./page-identity"
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

  it("removing a block from a note tombstones its node and link rows (diffed)", async () => {
    const { driver, store } = await makeStoreWithDriver()
    await store.writeNotes({
      a: "- keep\n  id:: blk_aaaaaaaaaa\n- drop\n  id:: blk_bbbbbbbbbb\n",
    })
    const diff = await store.writeNotes({ a: "- keep\n  id:: blk_aaaaaaaaaa\n" })
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
    expect(await store.getNote("a")).toBe("- keep\n  id:: blk_aaaaaaaaaa\n")
  })

  it("tombstones a note's rows on delete and reports the diff", async () => {
    const { driver, store } = await makeStoreWithDriver()
    await store.writeNotes({ a: "# A note\n  id:: blk_aaaaaaaaaa\n" })
    const diff = await store.deleteNote("a")

    expect(diff.deleteNodes).toEqual([])
    expect(diff.nodes.map((node) => node.id).sort()).toEqual(["a", "blk_aaaaaaaaaa"])
    // ONE stamp for the whole delete: a future restore is "revive the rows
    // stamped at T".
    expect(new Set(diff.nodes.map((node) => node.deleted_at)).size).toBe(1)
    expect(await store.getNote("a")).toBeNull()
    expect(await store.getAllNotes()).toEqual({})
    expect(await store.counts()).toEqual({ pages: 0, nodes: 0, links: 0 })
    // The rows — and the link that positions the block under the page — are
    // still there, which is what makes a restore possible at all.
    expect(await driver.exec("SELECT COUNT(*) AS n FROM nodes")).toEqual([{ n: 2 }])
    expect(await driver.exec("SELECT COUNT(*) AS n FROM link")).toEqual([{ n: 1 }])
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
    // The ladder composes: version 1 typed the block, version 2 re-keyed the
    // page to a minted id and turned its old id into the title (and an alias).
    expect(await store.getNote(derivePageId("a"))).toBe(
      "---\ntitle: a\npinned: true\naliases: [a]\n---\n[ ] buy milk\n  id:: blk_aaaaaaaaaa\n",
    )
    expect(await store.getNote("a")).toBe(null)
    const rows = await driver.exec("SELECT type, updated_at FROM nodes WHERE id = 'blk_aaaaaaaaaa'")
    expect(rows[0].type).toBe("todo")
    // Fresh updated_at → the rewritten row wins LWW and replicates.
    expect(Number(rows[0].updated_at)).toBeGreaterThan(100)
    expect(await store.getMeta("data_version")).toBe("2")
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
      { value: "3" },
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
    // The row survives the DDL step; page identity then re-keys it, so the
    // note is reachable under its minted id (with its old id as the title).
    expect(await store.getNote(derivePageId("a"))).toBe("---\ntitle: a\naliases: [a]\n---\n")
    expect(await driver.exec("SELECT value FROM meta WHERE key = 'schema_version'")).toEqual([
      { value: "3" },
    ])
    // The minted row is live: a nullable column means NULL = never deleted.
    expect(
      await driver.exec("SELECT deleted_at FROM nodes WHERE id = ?", [derivePageId("a")]),
    ).toEqual([{ deleted_at: null }])
  })

  it("resets and re-migrates a database with an unknown schema_version", async () => {
    const { driver, store } = await makeStoreWithDriver()
    await store.writeNotes({ a: "stale\n  id:: blk_aaaaaaaaaa\n" })
    await driver.exec("UPDATE meta SET value = '999' WHERE key = 'schema_version'")

    const reopened = await openSqlNoteStore(driver)
    expect(await reopened.getAllNotes()).toEqual({})
    expect(await driver.exec("SELECT value FROM meta WHERE key = 'schema_version'")).toEqual([
      { value: "3" },
    ])
  })

  it("keeps existing data when reopening a database with the current schema", async () => {
    const { driver, store } = await makeStoreWithDriver()
    await store.writeNotes({ blk_page0000: "keep me\n  id:: blk_aaaaaaaaaa\n" })
    const reopened = await openSqlNoteStore(driver)
    expect(await reopened.getNote("blk_page0000")).toBe("keep me\n  id:: blk_aaaaaaaaaa\n")
  })

  it("re-keys a title-shaped page id on open, preserving content and the old URL", async () => {
    const { driver, store } = await makeStoreWithDriver()
    await store.writeNotes({ "Flow Engineering": "body\n  id:: blk_aaaaaaaaaa\n" })

    const reopened = await openSqlNoteStore(driver)
    const minted = derivePageId("Flow Engineering")
    // Content survives under the minted id, carrying its former name as both
    // the title and an alias (which is what keeps the old URL resolving).
    expect(await reopened.getNote(minted)).toBe(
      "---\ntitle: Flow Engineering\naliases: [Flow Engineering]\n---\nbody\n  id:: blk_aaaaaaaaaa\n",
    )
    expect(await reopened.getNote("Flow Engineering")).toBe(null)
    // The block kept its own id and is still parented by the page.
    expect(await reopened.downstream(minted)).toEqual(["blk_aaaaaaaaaa"])
    // Nothing is hard-deleted: the old page row is a tombstone, so the re-key
    // replicates to other devices instead of silently diverging.
    expect(
      await driver.exec(
        "SELECT deleted_at FROM nodes WHERE id = 'Flow Engineering' " +
          "/* includes-deleted: asserting the tombstone the re-key leaves */",
      ),
    ).toEqual([{ deleted_at: expect.any(Number) }])
  })

  it("retitling a note rewrites exactly one row — the page's", async () => {
    const { driver, store } = await makeStoreWithDriver()
    const id = "blk_page00000"
    await store.writeNotes({
      [id]: "---\ntitle: Old Name\n---\nkeep me\n  id:: blk_aaaaaaaaaa\n",
    })
    const before = await driver.exec("SELECT id, text, updated_at FROM nodes ORDER BY id")

    const diff = await store.writeNotes({
      [id]: "---\ntitle: New Name\n---\nkeep me\n  id:: blk_aaaaaaaaaa\n",
    })

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
    expect(await store.getNote(id)).toContain("title: New Name")
  })

  it("leaves daily and weekly pages on their date ids (the natural-key carve-out)", async () => {
    const { driver, store } = await makeStoreWithDriver()
    await store.writeNotes({
      "2026-08-31": "today\n  id:: blk_aaaaaaaaaa\n",
      "2026-W35": "this week\n  id:: blk_bbbbbbbbbb\n",
    })

    const reopened = await openSqlNoteStore(driver)
    // Byte-identical: a date page's text IS its id, so no title is emitted.
    expect(await reopened.getNote("2026-08-31")).toBe("today\n  id:: blk_aaaaaaaaaa\n")
    expect(await reopened.getNote("2026-W35")).toBe("this week\n  id:: blk_bbbbbbbbbb\n")
    expect(await driver.exec("SELECT id FROM nodes WHERE type = 'page' ORDER BY id")).toEqual([
      { id: "2026-08-31" },
      { id: "2026-W35" },
    ])
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

  it("getAllRows carries tombstones — a delete only replicates if it travels", async () => {
    const { store } = await makeStoreWithDriver()
    await store.writeNotes({ a: "- x\n  id:: blk_aaaaaaaaaa\n" })
    await store.writeNotes({ a: "\n" })
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
 * User-visible delete behavior — unlink plus rescue — is unchanged and stays
 * pinned by the conformance suite; what changes is only that the rows survive.
 */
describe("soft deletes", () => {
  const OUTLINE = "- parent\n  id:: blk_parent0000\n  - child\n    id:: blk_child00000\n"

  it("stamps every row one delete retires with ONE timestamp", async () => {
    const { driver, store } = await makeStoreWithDriver()
    await store.writeNotes({ a: OUTLINE })
    await store.deleteNote("a")

    const stamps = await driver.exec(
      "SELECT deleted_at FROM nodes UNION ALL SELECT deleted_at FROM link",
    )
    expect(stamps).toHaveLength(5) // page + 2 blocks + 2 retained links
    const tombstones = stamps.map((row) => row.deleted_at).filter((value) => value !== null)
    expect(tombstones).toHaveLength(3) // the three nodes; links are retained
    expect(new Set(tombstones).size).toBe(1)
  })

  it("a tombstoned node never renders, and neither does a link into it", async () => {
    const { store } = await makeStoreWithDriver()
    await store.writeNotes({ a: OUTLINE })
    await store.writeNotes({ a: "- parent\n  id:: blk_parent0000\n" })

    // The child was unlinked and had no other parent: gone from every read…
    expect(await store.getNote("a")).toBe("- parent\n  id:: blk_parent0000\n")
    expect(await store.downstream("blk_parent0000")).toEqual([])
    expect(await store.upstream("blk_child00000")).toEqual([])
    // …and out of the counts, though its row is still on disk.
    expect(await store.counts()).toEqual({ pages: 1, nodes: 2, links: 1 })
  })

  it("keeps the link to a deleted node — the position a restore would use", async () => {
    const { driver, store } = await makeStoreWithDriver()
    await store.writeNotes({ a: OUTLINE })
    // Delete the page: the whole subtree is retired, but EVERY containment row
    // that describes its shape is retained, not cascaded — including the
    // page's own link to the block that was directly under it.
    await store.deleteNote("a")

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
    await store.writeNotes({ a: OUTLINE })
    await store.writeNotes({ a: "- parent\n  id:: blk_parent0000\n" })
    await store.writeNotes({ a: OUTLINE })

    expect(await store.getNote("a")).toBe(OUTLINE)
    expect(await driver.exec("SELECT deleted_at FROM nodes WHERE id = 'blk_child00000'")).toEqual([
      { deleted_at: null },
    ])
    // And the revived row goes out live, not as a tombstone.
    const { nodes } = await store.getAllRows()
    expect(nodes.find((node) => node.id === "blk_child00000")?.deleted_at).toBeUndefined()
  })

  it("a pulled tombstone lands and hides the row, without removing it", async () => {
    const { driver, store } = await makeStoreWithDriver()
    await store.writeNotes({ a: OUTLINE })
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
    expect(await store.getNote("a")).toBe("- parent\n  id:: blk_parent0000\n")
    expect(await driver.exec("SELECT COUNT(*) AS n FROM nodes")).toEqual([{ n: 3 }])
  })

  it("delete-rescue is unchanged: tombstoning a container promotes its child", async () => {
    const { store } = await makeStoreWithDriver()
    await store.writeNotes({ a: OUTLINE })
    await store.removeLink("a", "blk_parent0000")

    expect(await store.getNote("a")).toBe("- child\n  id:: blk_child00000\n")
    expect(await store.upstream("blk_child00000")).toEqual(["a"])
  })
})
