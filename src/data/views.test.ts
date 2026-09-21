import { createStore } from "jotai"
import { describe, expect, it } from "vitest"
import {
  applyViewRows,
  deletedIdsOf,
  orderPinned,
  orphanedViews,
  patchedView,
  pinnedRootIdsAtom,
  reorderedViews,
  viewByRootAtom,
  viewMapOf,
  viewsAtom,
  type ViewRow,
} from "./views"

/**
 * The view model (`src/data/views.ts`): what a pin, a saved filter and a
 * delete write, as rows. Pure, so the runtime and the signed-out seam can
 * share it and be about plumbing rather than about what a view is.
 */

const view = (over: Partial<ViewRow> = {}): ViewRow => ({
  id: "blk_a",
  root_id: "blk_a",
  filter: null,
  sort: null,
  pinned: true,
  sort_key: null,
  updated_at: 100,
  ...over,
})

describe("patchedView", () => {
  it("mints the first view of a node under the node's own id", () => {
    expect(patchedView(undefined, "blk_a", { pinned: true }, 500)).toEqual(
      view({ updated_at: 500 }),
    )
  })

  it("lays the patch over the current row and leaves the rest as it was", () => {
    const current = view({ filter: "type:todo", sort_key: "a0" })
    expect(patchedView(current, "blk_a", { sort: "text:desc" }, 500)).toEqual(
      view({ filter: "type:todo", sort: "text:desc", sort_key: "a0", updated_at: 500 }),
    )
  })

  it("reads an empty string as clearing, as the header hands it over", () => {
    const current = view({ filter: "type:todo", sort: "text" })
    expect(patchedView(current, "blk_a", { filter: "", sort: "  " }, 500)).toMatchObject({
      filter: null,
      sort: null,
      pinned: true,
    })
  })

  it("tombstones a view with nothing left in it, so unpinning leaves no empty row", () => {
    const gone = patchedView(view(), "blk_a", { pinned: false }, 500)
    expect(gone.deleted_at).toBe(500)
    expect(gone.updated_at).toBe(500)
    // ...but keeps one that still saves something.
    const kept = patchedView(view({ filter: "type:todo" }), "blk_a", { pinned: false }, 500)
    expect(kept.deleted_at).toBeUndefined()
    expect(kept.pinned).toBe(false)
  })

  it("always moves updated_at past the current row's — LWW reads >=, and a stuck clock must not draw", () => {
    expect(patchedView(view({ updated_at: 900 }), "blk_a", { sort: "text" }, 500).updated_at).toBe(
      901,
    )
  })
})

describe("applyViewRows / viewMapOf", () => {
  it("upserts live rows and takes a tombstone's id out", () => {
    const start = viewMapOf([view(), view({ id: "blk_b", root_id: "blk_b" })])
    const next = applyViewRows(start, [
      view({ id: "blk_b", root_id: "blk_b", deleted_at: 200, updated_at: 200 }),
      view({ filter: "type:todo", updated_at: 200 }),
    ])
    expect([...next.keys()]).toEqual(["blk_a"])
    expect(next.get("blk_a")?.filter).toBe("type:todo")
    // Nothing to land returns the same map, so nothing downstream re-renders.
    expect(applyViewRows(start, [])).toBe(start)
  })

  it("builds no live row from a tombstone", () => {
    expect(viewMapOf([view({ deleted_at: 1 })]).size).toBe(0)
  })
})

describe("orphanedViews / deletedIdsOf", () => {
  it("tombstones the views rooted at what a batch deleted, and only those", () => {
    const views = viewMapOf([view(), view({ id: "blk_b", root_id: "blk_b" })])
    const ops = [
      { op: "delete" as const, id: "blk_a" },
      { op: "unlink" as const, source: "n", destination: "blk_b" },
    ]
    expect(deletedIdsOf(ops)).toEqual(["blk_a"])
    const tombstones = orphanedViews(views, deletedIdsOf(ops), 500)
    expect(tombstones).toEqual([view({ updated_at: 500, deleted_at: 500 })])
  })

  it("is nothing when nothing was deleted, without touching the map", () => {
    expect(orphanedViews(viewMapOf([view()]), [], 500)).toEqual([])
    expect(orphanedViews(new Map(), ["blk_a"], 500)).toEqual([])
  })
})

describe("the atoms", () => {
  it("serve the sample view signed out: the welcome note is pinned", () => {
    const store = createStore()
    expect([...store.get(pinnedRootIdsAtom)]).toEqual(["readme"])
    expect(store.get(viewByRootAtom).get("readme")?.pinned).toBe(true)
  })

  it("index the views by root, and the pinned roots as a set", () => {
    const store = createStore()
    store.set(
      viewsAtom,
      viewMapOf([view({ pinned: false, filter: "type:todo" }), view({ id: "n", root_id: "n" })]),
    )
    expect(store.get(viewByRootAtom).get("blk_a")?.filter).toBe("type:todo")
    expect([...store.get(pinnedRootIdsAtom)]).toEqual(["n"])
  })
})

describe("orderPinned", () => {
  const entry = (id: string) => ({ id })
  const byRoot = (rows: ViewRow[]) => new Map(rows.map((row) => [row.root_id, row]))

  it("keeps the drawn order while nothing is keyed", () => {
    const entries = [entry("n1"), entry("n2"), entry("b1")]
    expect(orderPinned(entries, byRoot([view({ id: "n1", root_id: "n1" })]))).toEqual(entries)
  })

  it("puts keyed views first by key, and the unkeyed after in their drawn order", () => {
    const views = byRoot([
      view({ id: "n1", root_id: "n1", sort_key: "a2" }),
      view({ id: "b1", root_id: "b1", sort_key: "a1" }),
      view({ id: "n2", root_id: "n2" }),
    ])
    expect(
      orderPinned([entry("n1"), entry("n2"), entry("b1"), entry("n3")], views).map((e) => e.id),
    ).toEqual(["b1", "n1", "n2", "n3"])
  })
})

describe("reorderedViews", () => {
  const byRoot = (rows: ViewRow[]) => new Map(rows.map((row) => [row.root_id, row]))
  const pinnedAt = (id: string, sort_key: string | null = null) =>
    view({ id, root_id: id, sort_key })

  it("keys the whole list on the first drag, in the dropped order", () => {
    const rows = reorderedViews(
      byRoot([pinnedAt("a"), pinnedAt("b"), pinnedAt("c")]),
      ["c", "a", "b"],
      500,
    )
    expect(rows.map((row) => row.id)).toEqual(["c", "a", "b"])
    const keys = rows.map((row) => row.sort_key as string)
    expect([...keys].sort()).toEqual(keys)
    expect(rows.every((row) => row.updated_at === 500)).toBe(true)
  })

  it("rewrites one row once the list is keyed, and the list then reads in the dropped order", () => {
    const views = byRoot([pinnedAt("a", "a0"), pinnedAt("b", "a1"), pinnedAt("c", "a2")])
    const rows = reorderedViews(views, ["a", "c", "b"], 500)
    // The reconciler keeps every key that still fits and rewrites the rest:
    // one row, whichever of the two swapped it picks.
    expect(rows).toHaveLength(1)
    const next = new Map(views)
    for (const row of rows) next.set(row.root_id, row)
    expect(orderPinned([{ id: "a" }, { id: "b" }, { id: "c" }], next).map((e) => e.id)).toEqual([
      "a",
      "c",
      "b",
    ])
  })

  it("writes nothing for a drop that changes nothing, and skips roots with no pinned view", () => {
    const views = byRoot([
      pinnedAt("a", "a0"),
      pinnedAt("b", "a1"),
      view({ id: "x", root_id: "x", pinned: false }),
    ])
    expect(reorderedViews(views, ["a", "b"], 500)).toEqual([])
    expect(reorderedViews(views, ["b", "x", "a"], 500).map((row) => row.id)).toEqual(["a"])
  })
})
