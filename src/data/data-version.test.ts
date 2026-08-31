import { describe, expect, it } from "vitest"
import type { LinkRow, NodeRow } from "../../worker/handlers/replica-payload"
import { describeDataVersionConformance } from "./data-version-conformance"
import { planDataVersion1 } from "./data-version"
import { createNodeSqlDriver } from "./sql-node-test-driver"

const node = (
  id: string,
  type: string,
  text: string,
  props: string | null = null,
  updated_at = 100,
): NodeRow => ({ id, type, text, props, updated_at })

const link = (source: string, destination: string, sortKey = "a0"): LinkRow => ({
  source_id: source,
  destination_id: destination,
  kind: "child",
  sort_key: sortKey,
  updated_at: 100,
})

describe("planDataVersion1 (pure)", () => {
  it("normalizes near-miss text nodes reachable outside fences, stamping now", () => {
    const changed = planDataVersion1(
      [
        node("p", "page", "p"),
        node("blk_a", "text", "[] buy milk"),
        node("blk_b", "text", "[X] done thing"),
        node("blk_c", "text", "* item"),
        node("blk_d", "text", "2) item"),
        node("blk_e", "text", "plain stays"),
        node("blk_f", "ul", "[] already typed text is not touched"),
      ],
      [
        link("p", "blk_a", "a0"),
        link("p", "blk_b", "a1"),
        link("p", "blk_c", "a2"),
        link("p", "blk_d", "a3"),
        link("p", "blk_e", "a4"),
        link("p", "blk_f", "a5"),
      ],
      999,
    )
    expect(changed.map((row) => `${row.id}:${row.type}:${row.text}`)).toEqual([
      "blk_a:todo:buy milk",
      "blk_b:done:done thing",
      "blk_c:ul:item",
      "blk_d:ol:item",
    ])
    expect(changed.every((row) => row.updated_at === 999)).toBe(true)
  })

  it("leaves text nodes inside code fences verbatim", () => {
    const changed = planDataVersion1(
      [
        node("p", "page", "p"),
        node("blk_open", "text", "```js"),
        node("blk_in", "text", "[] not a todo"),
        node("blk_close", "text", "```"),
        node("blk_after", "text", "[] real todo"),
      ],
      [
        link("p", "blk_open", "a0"),
        link("p", "blk_in", "a1"),
        link("p", "blk_close", "a2"),
        link("p", "blk_after", "a3"),
      ],
      999,
    )
    expect(changed.map((row) => row.id)).toEqual(["blk_after"])
  })

  it("skips nodes with conflicting fence states and unreachable nodes", () => {
    const changed = planDataVersion1(
      [
        node("p1", "page", "p1"),
        node("p2", "page", "p2"),
        node("blk_fence", "text", "```"),
        // Shared by both pages: inside a fence on p1, outside on p2.
        node("blk_shared", "text", "[] conflicted"),
        node("blk_orphan", "text", "[] unreachable"),
      ],
      [
        link("p1", "blk_fence", "a0"),
        link("p1", "blk_shared", "a1"),
        link("p2", "blk_shared", "a0"),
      ],
      999,
    )
    expect(changed).toEqual([])
  })

  it("upgrades legacy raw frontmatter props to parsed entries", () => {
    const changed = planDataVersion1(
      [
        node("p", "page", "p", JSON.stringify({ frontmatter: "pinned: true" })),
        node("q", "page", "q", JSON.stringify({ pinned: true })), // already entries
        node("r", "page", "r", null),
        node("s", "page", "s", JSON.stringify({ frontmatter: "# comment stays raw" })),
      ],
      [],
      999,
    )
    expect(changed).toEqual([
      { ...node("p", "page", "p", JSON.stringify({ pinned: true })), updated_at: 999 },
    ])
  })

  it("returns nothing for an already-normalized graph (idempotent by construction)", () => {
    const nodes = [
      node("p", "page", "p", JSON.stringify({ pinned: true })),
      node("blk_a", "todo", "buy milk"),
      node("blk_b", "text", "plain"),
    ]
    const links = [link("p", "blk_a", "a0"), link("p", "blk_b", "a1")]
    const changed = planDataVersion1(nodes, links, 999)
    expect(changed).toEqual([])
  })

  it("terminates on a corrupted cyclic graph", () => {
    const changed = planDataVersion1(
      [node("p", "page", "p"), node("blk_x", "text", "[] loop"), node("blk_y", "text", "y")],
      [link("p", "blk_x", "a0"), link("blk_x", "blk_y", "a0"), link("blk_y", "blk_x", "a0")],
      999,
    )
    expect(changed.map((row) => row.id)).toEqual(["blk_x"])
  })
})

describeDataVersionConformance("the app store's node:sqlite driver", createNodeSqlDriver)
