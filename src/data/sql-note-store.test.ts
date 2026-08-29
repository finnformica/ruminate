import { describe, expect, it } from "vitest"
import { describeNoteStoreConformance } from "./note-store-conformance"
import { createNodeSqlDriver } from "./sql-node-test-driver"
import { ingestWorktree, openSqlNoteStore } from "./sql-note-store"

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

describe("ingestWorktree", () => {
  it("wipes and repopulates everything in one pass", async () => {
    const { store } = await makeStoreWithDriver()
    await store.writeNotes({ stale: "to be wiped\n" })
    await store.setViewState("stale", ["blk_aaaaaaaaaa"])

    const result = await ingestWorktree(
      store,
      { a: "# A\n  id:: blk_aaaaaaaaaa\n", b: "# B\n  id:: blk_bbbbbbbbbb\n" },
      { a: ["blk_aaaaaaaaaa"] },
    )

    expect(result.ingestedNotes).toBe(2)
    expect(result.rekeys).toEqual([])
    expect(result.rewrittenNotes).toEqual({})
    expect(await store.getAllNotes()).toEqual({
      a: "# A\n  id:: blk_aaaaaaaaaa\n",
      b: "# B\n  id:: blk_bbbbbbbbbb\n",
    })
    expect(await store.getViewState("a")).toEqual(["blk_aaaaaaaaaa"])
    expect(await store.getViewState("stale")).toEqual([])
  })

  it("re-keys cross-note block-id collisions (first note in sorted order keeps the id)", async () => {
    const { driver, store } = await makeStoreWithDriver()
    const original = "# Duplicated\n  id:: blk_dupe000000\n"

    const result = await ingestWorktree(store, {
      // Deliberately passed out of sorted order: "a" must still be the keeper.
      b: original,
      a: original,
    })

    expect(result.rekeys).toHaveLength(1)
    const rekey = result.rekeys[0]
    expect(rekey.noteId).toBe("b")
    expect(rekey.keeperNoteId).toBe("a")
    expect(rekey.oldId).toBe("blk_dupe000000")
    expect(rekey.newId).toMatch(/^blk_[0-9a-z]{10}$/)
    expect(rekey.newId).not.toBe("blk_dupe000000")

    // The keeper is untouched; the loser's rewritten content carries the new id
    // and must be persisted to git by the caller.
    expect(await store.getNote("a")).toBe(original)
    const rewritten = result.rewrittenNotes["b"]
    expect(rewritten).toBe(`# Duplicated\n  id:: ${rekey.newId}\n`)
    expect(await store.getNote("b")).toBe(rewritten)

    // The blocks table holds both blocks under distinct ids, homed correctly.
    const blocks = await driver.exec("SELECT id, note_id FROM blocks ORDER BY note_id")
    expect(blocks).toEqual([
      { id: "blk_dupe000000", note_id: "a" },
      { id: rekey.newId, note_id: "b" },
    ])
  })

  it("re-keys collisions in nested outlines without breaking the tree", async () => {
    const { driver, store } = await makeStoreWithDriver()
    const result = await ingestWorktree(store, {
      a: "parent\n  id:: blk_parent0000\n  child\n    id:: blk_child00000\n",
      b: "other parent\n  id:: blk_other00000\n  child copy\n    id:: blk_child00000\n",
    })

    expect(result.rekeys).toHaveLength(1)
    const { newId } = result.rekeys[0]
    const rows = await driver.exec(
      "SELECT id, parent_id FROM blocks WHERE note_id = 'b' ORDER BY position",
    )
    expect(rows).toEqual([
      { id: "blk_other00000", parent_id: null },
      { id: newId, parent_id: "blk_other00000" },
    ])
  })

  it("re-keys a conflicted-copy note, not the original", async () => {
    const { store } = await makeStoreWithDriver()
    const content = "# Note\n  id:: blk_aaaaaaaaaa\n"
    const result = await ingestWorktree(store, {
      "1234-conflict-20260829-0900": content,
      "1234": content,
    })
    expect(result.rekeys).toHaveLength(1)
    expect(result.rekeys[0].noteId).toBe("1234-conflict-20260829-0900")
    expect(result.rekeys[0].keeperNoteId).toBe("1234")
    expect(await store.getNote("1234")).toBe(content)
  })
})
