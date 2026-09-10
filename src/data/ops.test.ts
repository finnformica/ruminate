import { describe, expect, it } from "vitest"
import { emptyBlock, insertAfter, updateText } from "../blocks/ops"
import { parse } from "../blocks/parse"
import { serialize } from "../blocks/serialize"
import type { BlockDoc } from "../blocks/types"
import { buildGraphSnapshot, docToGraph, pageDoc, type GraphSnapshot } from "./graph"
import { applyOps, docToOps, pagesTouchedBy, type Op } from "./ops"

const NOW = 1000

/** A graph holding these pages, from canonical markdown. */
function graphOf(pages: Record<string, string>): GraphSnapshot {
  const nodes = []
  const links = []
  for (const [id, markdown] of Object.entries(pages)) {
    const g = docToGraph(id, serialize(parse(markdown)), 1)
    nodes.push(...g.nodes)
    links.push(...g.links)
  }
  return buildGraphSnapshot(nodes, links)
}

/** The page's doc as bytes — what the editor holds. */
const walk = (snapshot: GraphSnapshot, id: string) => {
  const doc = pageDoc(id, snapshot)
  return doc ? serialize(doc) : null
}

const kinds = (ops: Op[]) => ops.map((op) => op.op)

const A =
  "- one\n  id:: blk_one0000000\n- two\n  id:: blk_two0000000\n  - deep\n    id:: blk_deep000000\n"

describe("docToOps", () => {
  it("a page the graph lacks: create the page and every block, link them in order", () => {
    const empty = buildGraphSnapshot([], [])
    const ops = docToOps("a", parse(A), empty)
    expect(kinds(ops)).toEqual(["create", "create", "create", "create", "link", "link", "link"])
    expect(ops[0]).toMatchObject({ op: "create", id: "a", type: "page", text: "a" })
    const next = applyOps(empty, ops, NOW)
    expect(walk(next, "a")).toBe(A)
  })

  it("an unchanged doc is no ops at all", () => {
    const snapshot = graphOf({ a: A })
    expect(docToOps("a", pageDoc("a", snapshot)!, snapshot)).toEqual([])
  })

  it("typing is one setText; nothing else moves", () => {
    const snapshot = graphOf({ a: A })
    const doc = updateText(pageDoc("a", snapshot)!, "blk_one0000000", "one edited")
    const ops = docToOps("a", doc, snapshot)
    expect(ops).toEqual([{ op: "setText", id: "blk_one0000000", text: "one edited" }])
    expect(walk(applyOps(snapshot, ops, NOW), "a")).toBe(serialize(doc))
  })

  it("creating a block is one create and one link, between its neighbours", () => {
    const snapshot = graphOf({ a: A })
    const fresh = emptyBlock("ul", "between")
    const doc = insertAfter(pageDoc("a", snapshot)!, "blk_one0000000", fresh)
    const ops = docToOps("a", doc, snapshot)
    expect(kinds(ops)).toEqual(["create", "link"])
    expect(ops[1]).toMatchObject({ op: "link", source: "a", destination: fresh.id })
    const next = applyOps(snapshot, ops, NOW)
    expect(walk(next, "a")).toBe(serialize(doc))
    // The neighbours kept their keys: only the new link row exists for them.
    const keys = next.childLinks.get("a")!.map((link) => link.destination_id)
    expect(keys).toEqual(["blk_one0000000", fresh.id, "blk_two0000000"])
  })

  it("removing a block unlinks it and deletes it with its exclusive subtree", () => {
    const snapshot = graphOf({ a: A })
    const doc = parse("- one\n  id:: blk_one0000000\n")
    const ops = docToOps("a", doc, snapshot)
    expect(ops).toEqual([
      { op: "unlink", source: "a", destination: "blk_two0000000" },
      { op: "delete", id: "blk_two0000000" },
      { op: "delete", id: "blk_deep000000" },
    ])
    const next = applyOps(snapshot, ops, NOW)
    expect(walk(next, "a")).toBe(serialize(doc))
    expect(next.nodes.has("blk_deep000000")).toBe(false)
    expect(next.childLinks.has("blk_two0000000")).toBe(false)
  })

  it("a block another page holds is unlinked here but never deleted", () => {
    const snapshot0 = graphOf({ a: A, b: "- b's own\n  id:: blk_bown000000\n" })
    // Link `two` (and so `deep`) under b as well.
    const linked = applyOps(
      snapshot0,
      [{ op: "link", source: "b", destination: "blk_two0000000", sortKey: "a1" }],
      NOW,
    )
    expect(walk(linked, "b")).toContain("- deep")

    const doc = parse("- one\n  id:: blk_one0000000\n")
    const ops = docToOps("a", doc, linked)
    expect(ops).toEqual([{ op: "unlink", source: "a", destination: "blk_two0000000" }])
    const next = applyOps(linked, ops, NOW)
    expect(walk(next, "a")).toBe(serialize(doc))
    expect(walk(next, "b")).toBe(walk(linked, "b"))
  })

  it("a doc naming a block the graph already has links it — one node, two links", () => {
    const snapshot = graphOf({ a: A, b: "- b's own\n  id:: blk_bown000000\n" })
    // b's doc now names a's `two`, as paste-as-link produces.
    const doc = parse(
      "- b's own\n  id:: blk_bown000000\n- two\n  id:: blk_two0000000\n  - deep\n    id:: blk_deep000000\n",
    )
    const ops = docToOps("b", doc, snapshot)
    expect(ops).toEqual([
      { op: "link", source: "b", destination: "blk_two0000000", sortKey: expect.any(String) },
    ])
    const next = applyOps(snapshot, ops, NOW)
    expect(walk(next, "b")).toBe(serialize(doc))
    expect(next.nodes.size).toBe(snapshot.nodes.size)
    // Editing it through b edits it in a.
    const edited = updateText(doc, "blk_deep000000", "deep, edited in b")
    const after = applyOps(next, docToOps("b", edited, next), NOW)
    expect(walk(after, "a")).toContain("- deep, edited in b")
  })

  it("a reorder touches only the links whose keys had to move", () => {
    const snapshot = graphOf({ a: A })
    const doc = pageDoc("a", snapshot)!
    const reordered: BlockDoc = { ...doc, rootBlockIds: ["blk_two0000000", "blk_one0000000"] }
    const ops = docToOps("a", reordered, snapshot)
    expect(kinds(ops)).toEqual(["link"])
    expect(walk(applyOps(snapshot, ops, NOW), "a")).toBe(serialize(reordered))
  })

  it("retitling and re-propping the page are sets on the page node", () => {
    const snapshot = graphOf({ a: A })
    const doc: BlockDoc = { ...pageDoc("a", snapshot)!, frontmatter: "title: Alpha\npinned: true" }
    const ops = docToOps("a", doc, snapshot)
    expect(ops).toEqual([
      { op: "setText", id: "a", text: "Alpha" },
      { op: "setProps", id: "a", props: expect.stringContaining("pinned") },
    ])
    expect(walk(applyOps(snapshot, ops, NOW), "a")).toBe(serialize(doc))
  })

  it("re-mints a block id that collides with another page's id", () => {
    const snapshot = graphOf({ a: A, b: "- b\n  id:: blk_b000000000\n" })
    const doc = parse("- stray\n  id:: b\n")
    const ops = docToOps("a", doc, snapshot)
    const created = ops.find((op) => op.op === "create")
    expect(created).toBeDefined()
    expect((created as { id: string }).id).not.toBe("b")
    const next = applyOps(snapshot, ops, NOW)
    expect(next.nodes.get("b")?.type).toBe("page")
    expect(walk(next, "a")).toContain("- stray")
  })

  it("drops a desired edge that would close a loop", () => {
    const snapshot = graphOf({ a: A })
    // `deep` claiming `two` (its own ancestor) as a child.
    const doc = pageDoc("a", snapshot)!
    const cyclic: BlockDoc = {
      ...doc,
      blocks: {
        ...doc.blocks,
        blk_deep000000: { ...doc.blocks.blk_deep000000, children: ["blk_two0000000"] },
      },
    }
    const ops = docToOps("a", cyclic, snapshot)
    expect(ops).toEqual([])
  })

  it("applying the ops of a walk again is the identity (property)", () => {
    const docs = [
      A,
      "# H\n  id:: blk_h000000000\n  [ ] t\n    id:: blk_t000000000\n",
      "",
      "> q\n  id:: blk_q000000000\n",
    ]
    for (const markdown of docs) {
      const empty = buildGraphSnapshot([], [])
      const doc = parse(markdown)
      const next = applyOps(empty, docToOps("p", doc, empty), NOW)
      expect(walk(next, "p")).toBe(serialize(doc))
      expect(docToOps("p", pageDoc("p", next)!, next)).toEqual([])
    }
  })
})

describe("applyOps", () => {
  it("is pure and leaves the input snapshot untouched", () => {
    const snapshot = graphOf({ a: A })
    const before = walk(snapshot, "a")
    applyOps(snapshot, [{ op: "setText", id: "blk_one0000000", text: "changed" }], NOW)
    expect(walk(snapshot, "a")).toBe(before)
  })

  it("ignores sets on nodes it does not hold, and unlinks that do not exist", () => {
    const snapshot = graphOf({ a: A })
    const next = applyOps(
      snapshot,
      [
        { op: "setText", id: "ghost", text: "x" },
        { op: "unlink", source: "a", destination: "ghost" },
        { op: "delete", id: "ghost" },
      ],
      NOW,
    )
    expect(walk(next, "a")).toBe(walk(snapshot, "a"))
  })

  it("a link replaces an existing link's key and keeps siblings sorted", () => {
    const snapshot = graphOf({ a: A })
    const next = applyOps(
      snapshot,
      [{ op: "link", source: "a", destination: "blk_two0000000", sortKey: "Zz" }],
      NOW,
    )
    expect(next.childLinks.get("a")!.map((l) => l.destination_id)).toEqual([
      "blk_two0000000",
      "blk_one0000000",
    ])
    expect(next.childLinks.get("a")).toHaveLength(2)
  })

  it("a delete removes the node's links in both directions", () => {
    const snapshot = graphOf({ a: A })
    const next = applyOps(snapshot, [{ op: "delete", id: "blk_two0000000" }], NOW)
    expect(next.childLinks.get("a")!.map((l) => l.destination_id)).toEqual(["blk_one0000000"])
    expect(next.childLinks.has("blk_two0000000")).toBe(false)
    // The orphan is still a node until something deletes it (the cascade is
    // `docToOps`'s job); the walk simply no longer reaches it.
    expect(next.nodes.has("blk_deep000000")).toBe(true)
  })

  it("stamps every row it writes with `now`", () => {
    const snapshot = graphOf({ a: A })
    const next = applyOps(
      snapshot,
      [
        { op: "setText", id: "blk_one0000000", text: "x" },
        { op: "link", source: "a", destination: "blk_one0000000", sortKey: "a0" },
      ],
      777,
    )
    expect(next.nodes.get("blk_one0000000")?.updated_at).toBe(777)
    expect(next.childLinks.get("a")![0].updated_at).toBe(777)
  })
})

describe("pagesTouchedBy", () => {
  it("names every page that reaches a node the batch names", () => {
    const snapshot = applyOps(
      graphOf({ a: A, b: "- b\n  id:: blk_b000000000\n", c: "- c\n  id:: blk_c000000000\n" }),
      [{ op: "link", source: "blk_b000000000", destination: "blk_two0000000", sortKey: "a0" }],
      NOW,
    )
    expect(
      [...pagesTouchedBy(snapshot, [{ op: "setText", id: "blk_deep000000", text: "x" }])].sort(),
    ).toEqual(["a", "b"])
    expect([
      ...pagesTouchedBy(snapshot, [{ op: "setText", id: "blk_c000000000", text: "x" }]),
    ]).toEqual(["c"])
    expect([
      ...pagesTouchedBy(snapshot, [{ op: "create", id: "new", type: "ul", text: "", props: null }]),
    ]).toEqual([])
  })
})
