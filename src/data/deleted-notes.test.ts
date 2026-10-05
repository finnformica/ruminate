// tenant-guard: exempt — these tests read raw storage on purpose (that is how
// they pin what a delete left behind and what a restore brought back).
import { describe, expect, it } from "vitest"
import { parse } from "../blocks/parse"
import { deletedNotesOf, restoreNoteOps } from "./deleted-notes"
import { CORPUS_ROOT_ID, ROOT_TYPE, rollup } from "./graph"
import type { NoteStore } from "./note-store"
import { deleteBlockOps, deleteNoteOps, docToOps, type Op } from "./ops"
import { createNodeSqlDriver } from "./sql-node-test-driver"
import { openSqlNoteStore } from "./sql-note-store"

async function makeStore() {
  return openSqlNoteStore(createNodeSqlDriver())
}

/** Save a note as the app does: diff the doc against the live graph into ops. */
async function seed(store: NoteStore, id: string, markdown: string) {
  return store.applyOps(docToOps(id, parse(markdown), await store.getGraph()))
}

const noteOf = async (store: NoteStore, id: string) => rollup(id, await store.getGraph())

/** Delete the note as the app does, over the store's live graph. */
async function deleteNote(store: NoteStore, id: string) {
  return store.applyOps(deleteNoteOps(id, await store.getGraph()))
}

/** Put the note back as Settings does: plan over every row, apply the batch. */
async function restore(store: NoteStore, id: string): Promise<Op[]> {
  const ops = restoreNoteOps(id, await store.getAllRows())
  await store.applyOps(ops)
  return ops
}

const A =
  "- one\n  id:: blk_one0000000\n- two\n  id:: blk_two0000000\n  - deep\n    id:: blk_deep000000\n"

describe("deletedNotesOf", () => {
  it("lists the tombstoned notes, newest first, with what comes back with each", async () => {
    const store = await makeStore()
    await seed(store, "a", A)
    await seed(store, "b", "- b\n  id:: blk_b000000000\n")
    expect(deletedNotesOf(await store.getAllRows())).toEqual([])

    await deleteNote(store, "a")
    await new Promise((resolve) => setTimeout(resolve, 2))
    await deleteNote(store, "b")
    const listed = deletedNotesOf(await store.getAllRows())
    expect(listed.map((note) => [note.id, note.blocks])).toEqual([
      ["b", 1],
      ["a", 3],
    ])
    expect(listed[0].deletedAt).toBeGreaterThan(listed[1].deletedAt)
  })

  it("names a note by its title, or by its id when it has none", async () => {
    const store = await makeStore()
    await store.applyOps([
      { op: "create", id: "titled", type: "note", text: "A title", props: null },
      { op: "create", id: "untitled", type: "note", text: "untitled", props: null },
    ])
    await deleteNote(store, "titled")
    await deleteNote(store, "untitled")
    const titles = deletedNotesOf(await store.getAllRows()).map((note) => note.title)
    expect(titles.sort()).toEqual(["A title", "untitled"])
  })
})

describe("restoreNoteOps", () => {
  it("restores a deleted note exactly as it was", async () => {
    const store = await makeStore()
    await seed(store, "a", A)
    await deleteNote(store, "a")
    expect(await noteOf(store, "a")).toBeNull()

    await restore(store, "a")
    expect(await noteOf(store, "a")).toBe(A)
    expect(deletedNotesOf(await store.getAllRows())).toEqual([])
  })

  it("is nothing for a note the rows hold live, or not at all", async () => {
    const store = await makeStore()
    await seed(store, "a", A)
    const rows = await store.getAllRows()
    expect(restoreNoteOps("a", rows)).toEqual([])
    expect(restoreNoteOps("nope", rows)).toEqual([])
  })

  it("re-links a block another note also holds, and leaves that note alone", async () => {
    const store = await makeStore()
    await seed(store, "a", "- mine\n  id:: blk_mine000000\n- shared\n  id:: blk_shared0000\n")
    await seed(store, "b", "- b\n  id:: blk_b000000000\n")
    await store.applyOps([
      { op: "link", source: "b", destination: "blk_shared0000", sortKey: "a1" },
    ])
    const before = await noteOf(store, "b")

    await deleteNote(store, "a")
    // `shared` survived the delete (b holds it) and is still b's.
    expect(await noteOf(store, "b")).toBe(before)

    const ops = await restore(store, "a")
    // Only the note and the block that went with it are re-created; the
    // shared block is simply linked back beneath the note.
    expect(ops.filter((op) => op.op === "create").map((op) => (op as { id: string }).id)).toEqual(
      expect.arrayContaining(["a", "blk_mine000000"]),
    )
    expect(ops.filter((op) => op.op === "create")).toHaveLength(2)
    expect(await noteOf(store, "a")).toBe(
      "- mine\n  id:: blk_mine000000\n- shared\n  id:: blk_shared0000\n",
    )
    expect(await noteOf(store, "b")).toBe(before)
  })

  it("brings the basket back, and not a block deleted on its own earlier", async () => {
    const store = await makeStore()
    await seed(store, "a", A)
    // `stray` was written in a but nothing reaches it: the Unassigned basket.
    await store.applyOps([
      {
        op: "create",
        id: "blk_stray00000",
        type: "text",
        text: "stray",
        props: null,
        notesId: "a",
      },
    ])
    // `deep` is deleted deliberately, in its own right, before the note is.
    await store.applyOps(deleteBlockOps("blk_deep000000", await store.getGraph()))
    await new Promise((resolve) => setTimeout(resolve, 2))
    await deleteNote(store, "a")

    const listed = deletedNotesOf(await store.getAllRows())
    expect(listed.map((note) => [note.id, note.blocks])).toEqual([["a", 3]])

    await restore(store, "a")
    expect(await noteOf(store, "a")).toBe(
      "- one\n  id:: blk_one0000000\n- two\n  id:: blk_two0000000\n",
    )
    const graph = await store.getGraph()
    expect(graph.nodes.has("blk_stray00000")).toBe(true)
    expect(graph.nodes.get("blk_stray00000")?.notes_id).toBe("a")
    expect(graph.nodes.has("blk_deep000000")).toBe(false)
  })

  it("keeps a link that was unlinked before the delete out of the restore", async () => {
    const store = await makeStore()
    await seed(store, "a", A)
    // Removing `one` from the outline is an unlink; the block goes to the basket.
    await store.applyOps([{ op: "unlink", source: "a", destination: "blk_one0000000" }])
    await deleteNote(store, "a")
    await restore(store, "a")
    expect(await noteOf(store, "a")).toBe(
      "- two\n  id:: blk_two0000000\n  - deep\n    id:: blk_deep000000\n",
    )
    // `one` is back too, in the basket where it was.
    expect((await store.getGraph()).nodes.has("blk_one0000000")).toBe(true)
  })

  it("restores one of two notes deleted under one stamp, and not the other", async () => {
    const store = await makeStore()
    await seed(store, "a", A)
    await seed(store, "b", "- b\n  id:: blk_b000000000\n")
    const graph = await store.getGraph()
    // One flush lands both deletes: one writer, one `deleted_at`.
    await store.applyOps([...deleteNoteOps("a", graph), ...deleteNoteOps("b", graph)])
    const rows = await store.getAllRows()
    const stamps = new Set(rows.nodes.map((node) => node.deleted_at))
    expect(stamps.size).toBe(1)

    await restore(store, "a")
    expect(await noteOf(store, "a")).toBe(A)
    expect(await noteOf(store, "b")).toBeNull()
    expect(deletedNotesOf(await store.getAllRows()).map((note) => note.id)).toEqual(["b"])
  })

  it("keeps the note's place in the manual order", async () => {
    const store = await makeStore()
    await seed(store, "a", A)
    await seed(store, "b", "- b\n  id:: blk_b000000000\n")
    await store.applyOps([
      { op: "create", id: CORPUS_ROOT_ID, type: ROOT_TYPE, text: "", props: null },
      { op: "link", source: CORPUS_ROOT_ID, destination: "a", sortKey: "a0" },
      { op: "link", source: CORPUS_ROOT_ID, destination: "b", sortKey: "a1" },
    ])
    await deleteNote(store, "a")
    const ops = await restore(store, "a")
    expect(ops).toContainEqual({
      op: "link",
      source: CORPUS_ROOT_ID,
      destination: "a",
      sortKey: "a0",
    })
    const order = (await store.getGraph()).childLinks
      .get(CORPUS_ROOT_ID)
      ?.map((l) => l.destination_id)
    expect(order).toEqual(["a", "b"])
  })
})
