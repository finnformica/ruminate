import { createStore } from "jotai"
import { describe, expect, it } from "vitest"
import {
  applyViewRows,
  deletedIdsOf,
  orphanedViews,
  patchedView,
  pinnedRootIdsAtom,
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
