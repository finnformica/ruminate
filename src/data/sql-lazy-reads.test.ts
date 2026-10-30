// tenant-guard: exempt — the raw inserts below plant cache rows on purpose.
import { describe, expect, it } from "vitest"
import type { CacheRow } from "./cache-rows"
import { CORPUS_ROOT_ID } from "./graph"
import { emptyLazyGraph, mergeFragment } from "./graph-patch"
import { childIdsOf, parentIdsOf } from "./graph"
import { createNodeSqlDriver } from "./sql-node-test-driver"
import { openSqlNoteStore } from "./sql-note-store"

/** A corpus as the cache holds it: two notes, one with a deep outline and a
 * basket, one block held by both notes, a tombstoned block, a pinned block
 * and the root's order. */
async function corpus() {
  const driver = createNodeSqlDriver()
  const store = await openSqlNoteStore(driver)
  const rows: CacheRow[] = []
  let n = 0
  const row = (entity: "block" | "link", id: string, key: string, value: string | null) =>
    rows.push({ entity, entity_id: id, key, value, hlc: `s${(n += 1)}`, seq: n, updated_at: n })
  const block = (
    id: string,
    type: string,
    text: string,
    notesId: string | null,
    extra: Record<string, string | null> = {},
  ) => {
    row("block", id, "type", JSON.stringify(type))
    row("block", id, "text", JSON.stringify(text))
    if (notesId) row("block", id, "notes_id", JSON.stringify(notesId))
    row("block", id, "deleted", "null")
    for (const [key, value] of Object.entries(extra)) row("block", id, key, value)
  }
  const link = (source: string, destination: string, sortKey: string, deleted = "null") => {
    const id = `${source}|${destination}|child`
    row("link", id, "source_id", JSON.stringify(source))
    row("link", id, "destination_id", JSON.stringify(destination))
    row("link", id, "kind", '"child"')
    row("link", id, "sort_key", JSON.stringify(sortKey))
    row("link", id, "deleted", deleted)
  }
  block(CORPUS_ROOT_ID, "corpus_root", "", null)
  block("n1", "note", "First", null)
  block("n2", "note", "", null)
  block("a", "text", "a (first of n1)", "n1")
  block("b", "h1", "b", "n1")
  block("c", "text", "c under b", "n1")
  block("d", "text", "d deep", "n1")
  block("shared", "text", "held by both", "n1", { "props.pinned_at": '"2026-01-01"' })
  block("basket", "text", "in n1's basket", "n1")
  block("under_basket", "text", "beneath the basket root", "n1")
  block("x", "text", "x first of n2", "n2")
  block("gone", "text", "tombstoned", "n1")
  rows.push({
    entity: "block",
    entity_id: "gone",
    key: "deleted",
    value: "9",
    hlc: "s999",
    seq: 999,
    updated_at: 9,
  })
  link(CORPUS_ROOT_ID, "n2", "a0")
  link(CORPUS_ROOT_ID, "n1", "a1")
  link("n1", "a", "a0")
  link("n1", "b", "a1")
  link("b", "c", "a0")
  link("c", "d", "a0")
  link("b", "shared", "a1")
  link("n2", "x", "a0")
  link("n2", "shared", "a1")
  link("basket", "under_basket", "a0")
  link("n1", "gone", "a2")
  await store.importCacheRows(rows)
  return store
}

describe("the lazy reads", () => {
  it("rootView: the notes, the root's order, one preview child per note, the pinned nodes", async () => {
    const store = await corpus()
    const fragment = await store.lazy.rootView()
    const graph = mergeFragment(emptyLazyGraph(), fragment)
    expect([...graph.nodes.keys()].sort()).toEqual(
      [CORPUS_ROOT_ID, "n1", "n2", "a", "x", "shared"].sort(),
    )
    expect(childIdsOf(graph, CORPUS_ROOT_ID)).toEqual(["n2", "n1"])
    // The preview child: the first in sibling order, and only it.
    expect(childIdsOf(graph, "n1")).toEqual(["a"])
    expect(childIdsOf(graph, "n2")).toEqual(["x"])
    // The root's list is whole; a note's is not.
    expect(graph.loaded?.has(CORPUS_ROOT_ID)).toBe(true)
    expect(graph.loaded?.has("n1")).toBe(false)
  })

  it("noteView: the subtree, the basket's blocks beneath, and what else reaches any of them", async () => {
    const store = await corpus()
    let graph = mergeFragment(emptyLazyGraph(), await store.lazy.rootView())
    graph = mergeFragment(graph, await store.lazy.noteView("n1"))
    expect(childIdsOf(graph, "n1")).toEqual(["a", "b"])
    expect(childIdsOf(graph, "b")).toEqual(["c", "shared"])
    expect(childIdsOf(graph, "c")).toEqual(["d"])
    // The basket candidate and what it holds.
    expect(graph.nodes.has("basket")).toBe(true)
    expect(childIdsOf(graph, "basket")).toEqual(["under_basket"])
    // The upward closure: n2 holds `shared` too, and the root holds n1.
    expect(parentIdsOf(graph, "shared")).toEqual(["b", "n2"])
    expect(parentIdsOf(graph, "n1")).toEqual([CORPUS_ROOT_ID])
    // Everything beneath the note is whole; n2, reached upward, is not.
    for (const id of ["n1", "a", "b", "c", "d", "shared", "basket", "under_basket"]) {
      expect(graph.loaded?.has(id), id).toBe(true)
    }
    expect(graph.loaded?.has("n2")).toBe(false)
    expect(childIdsOf(graph, "n2")).toEqual(["x", "shared"])
    // The tombstone is not read.
    expect(graph.nodes.has("gone")).toBe(false)
  })

  it("subtreeView and nodesView: beneath these ids, and just these nodes", async () => {
    const store = await corpus()
    let graph = mergeFragment(emptyLazyGraph(), await store.lazy.rootView())
    graph = mergeFragment(graph, await store.lazy.subtreeView(["b"]))
    expect(childIdsOf(graph, "b")).toEqual(["c", "shared"])
    expect(childIdsOf(graph, "c")).toEqual(["d"])
    expect(graph.loaded?.has("b")).toBe(true)
    expect(graph.loaded?.has("n1")).toBe(false)
    const nodes = await store.lazy.nodesView(["d", "gone", "nowhere"])
    expect(nodes.nodes.map((row) => row.id)).toEqual(["d"])
    expect(nodes.loaded).toEqual([])
  })
})
