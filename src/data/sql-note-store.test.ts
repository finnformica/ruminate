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
  it("decomposes a written note into blocks and links rows", async () => {
    const { driver, store } = await makeStoreWithDriver()
    await store.writeNotes({
      a: "# Hello\n  id:: blk_aaaaaaaaaa\n- links to [[b]] and #tag\n  id:: blk_bbbbbbbbbb\n",
    })

    const blocks = await driver.exec(
      "SELECT id, note_id, parent_id, position FROM blocks ORDER BY position",
    )
    expect(blocks).toEqual([
      { id: "blk_aaaaaaaaaa", note_id: "a", parent_id: null, position: 0 },
      { id: "blk_bbbbbbbbbb", note_id: "a", parent_id: null, position: 1 },
    ])

    const links = await driver.exec(
      "SELECT from_block, to_note, to_block, kind FROM links ORDER BY kind",
    )
    expect(links).toEqual([
      { from_block: "blk_bbbbbbbbbb", to_note: "tag", to_block: null, kind: "tag" },
      { from_block: "blk_bbbbbbbbbb", to_note: "b", to_block: null, kind: "wikilink" },
    ])
  })

  it("replaces a note's graph rows on overwrite (no stale blocks or links)", async () => {
    const { driver, store } = await makeStoreWithDriver()
    await store.writeNotes({ a: "[[old]]\n  id:: blk_aaaaaaaaaa\n" })
    await store.writeNotes({ a: "[[new]]\n  id:: blk_cccccccccc\n" })

    expect(await driver.exec("SELECT id FROM blocks")).toEqual([{ id: "blk_cccccccccc" }])
    expect(await driver.exec("SELECT to_note FROM links")).toEqual([{ to_note: "new" }])
  })

  it("removes a note's graph rows on delete", async () => {
    const { driver, store } = await makeStoreWithDriver()
    await store.writeNotes({ a: "# A note with a [[link]]\n  id:: blk_aaaaaaaaaa\n" })
    await store.setViewState("a", ["blk_aaaaaaaaaa"])
    await store.deleteNote("a")

    expect(await driver.exec("SELECT * FROM notes")).toEqual([])
    expect(await driver.exec("SELECT * FROM blocks")).toEqual([])
    expect(await driver.exec("SELECT * FROM links")).toEqual([])
    expect(await driver.exec("SELECT * FROM view_state")).toEqual([])
  })

  it("stores the frontmatter updated_at as ms epoch", async () => {
    const { driver, store } = await makeStoreWithDriver()
    await store.writeNotes({
      a: "---\nupdated_at: 2026-01-02T03:04:05.000Z\n---\nHello\n",
      b: "No frontmatter\n",
    })
    const rows = await driver.exec("SELECT id, updated_at FROM notes ORDER BY id")
    expect(rows).toEqual([
      { id: "a", updated_at: Date.parse("2026-01-02T03:04:05.000Z") },
      { id: "b", updated_at: null },
    ])
  })

  it("resets and re-migrates a database with an unknown schema_version", async () => {
    const { driver, store } = await makeStoreWithDriver()
    await store.writeNotes({ a: "stale\n" })
    await driver.exec("UPDATE meta SET value = '999' WHERE key = 'schema_version'")

    const reopened = await openSqlNoteStore(driver)
    expect(await reopened.getAllNotes()).toEqual({})
    expect(await driver.exec("SELECT value FROM meta WHERE key = 'schema_version'")).toEqual([
      { value: "1" },
    ])
  })

  it("keeps existing data when reopening a database with the current schema", async () => {
    const { driver, store } = await makeStoreWithDriver()
    await store.writeNotes({ a: "keep me\n" })
    const reopened = await openSqlNoteStore(driver)
    expect(await reopened.getNote("a")).toBe("keep me\n")
  })

  it("reports row counts", async () => {
    const { store } = await makeStoreWithDriver()
    await store.writeNotes({ a: "one\n  id:: blk_aaaaaaaaaa\n[[b]]\n  id:: blk_bbbbbbbbbb\n" })
    expect(await store.counts()).toEqual({ notes: 1, blocks: 2, links: 1 })
  })
})
