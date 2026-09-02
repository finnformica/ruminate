import { describe, expect, it } from "vitest"
import type { LinkRow, NodeRow } from "../../worker/handlers/replica-payload"
import { describeDataVersionConformance } from "./data-version-conformance"
import { planDataVersion1, planDataVersion2 } from "./data-version"
import { derivePageId } from "./page-identity"
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

describe("planDataVersion2 (pure)", () => {
  const ids = (rows: { id: string; deleted_at?: number }[]) =>
    rows.map((row) => `${row.id}${row.deleted_at === undefined ? "" : ":dead"}`)

  it("re-keys a title-keyed page, moving the title into text and carrying props over", () => {
    const { nodes } = planDataVersion2(
      [
        node("Flow Engineering", "page", "Flow Engineering", JSON.stringify({ pinned: true })),
        node("blk_a", "text", "body"),
      ],
      [link("Flow Engineering", "blk_a")],
      999,
    )
    const minted = derivePageId("Flow Engineering")
    expect(ids(nodes)).toEqual([minted, "Flow Engineering:dead"])
    expect(nodes[0]).toEqual({
      id: minted,
      type: "page",
      text: "Flow Engineering",
      // Props travel verbatim: the re-key adds nothing of its own, so the old
      // id survives only as the title. Its URL is gone — an id nothing
      // resolves opens the new-note editor.
      props: JSON.stringify({ pinned: true }),
      updated_at: 999,
    })
    // The old row is retired, never hard-deleted, so the re-key replicates.
    expect(nodes[1].deleted_at).toBe(999)
  })

  it("keeps a deleted page deleted instead of resurrecting it", () => {
    // A tombstoned page must not come back as a live minted row. Re-keying
    // gives it a NEW id, so no later tombstone would ever match it again —
    // the note would return permanently.
    const dead = { ...node("Old Note", "page", "Old Note"), deleted_at: 500 }
    const { nodes } = planDataVersion2([dead, node("blk_a", "text", "body")], [], 999)
    const minted = nodes.find((row) => row.id === derivePageId("Old Note"))
    expect(minted).toBeDefined()
    expect(minted?.deleted_at).toBe(500)
  })

  it("re-points every link naming the old page id", () => {
    const { links } = planDataVersion2(
      [node("p", "page", "p"), node("blk_a", "text", "a"), node("blk_b", "text", "b")],
      [link("p", "blk_a", "a0"), link("blk_a", "blk_b", "a0")],
      999,
    )
    const minted = derivePageId("p")
    // The page's own edge moves; an edge between two blocks is untouched.
    expect(links.map((row) => `${row.source_id}→${row.destination_id}`)).toEqual([
      `${minted}→blk_a`,
      "p→blk_a",
    ])
    expect(links[0].deleted_at).toBeUndefined()
    expect(links[1].deleted_at).toBe(999)
    expect(links[0].sort_key).toBe("a0")
  })

  it("re-points a link on BOTH ends when a block is shared between two pages", () => {
    const { links } = planDataVersion2(
      [node("p", "page", "p"), node("q", "page", "q")],
      [link("p", "q", "a0")],
      999,
    )
    expect(links[0].source_id).toBe(derivePageId("p"))
    expect(links[0].destination_id).toBe(derivePageId("q"))
  })

  it("leaves date and week pages entirely alone", () => {
    expect(
      planDataVersion2(
        [node("2026-08-31", "page", "2026-08-31"), node("2026-W35", "page", "2026-W35")],
        [],
        999,
      ),
    ).toEqual({ nodes: [], links: [] })
  })

  it("returns nothing once every page is minted (idempotent by construction)", () => {
    expect(
      planDataVersion2(
        [node("blk_page00000", "page", "Flow Engineering"), node("blk_a", "text", "body")],
        [link("blk_page00000", "blk_a")],
        999,
      ),
    ).toEqual({ nodes: [], links: [] })
  })

  it("resolves a derived-id collision with an existing row, deterministically", () => {
    // Seed the corpus with the id "p" would otherwise mint.
    const occupied = derivePageId("p")
    const { nodes } = planDataVersion2(
      [node("p", "page", "p"), node(occupied, "text", "an unrelated block")],
      [],
      999,
    )
    expect(nodes[0].id).toBe(derivePageId("p", 1))
    expect(nodes[0].id).not.toBe(occupied)
  })

  it("mints independently of row order, so two engines cannot disagree", () => {
    const rows = [node("a", "page", "a"), node("b", "page", "b"), node("c", "page", "c")]
    const forward = planDataVersion2(rows, [], 999).nodes.map((row) => row.id)
    const reversed = planDataVersion2([...rows].reverse(), [], 999).nodes.map((row) => row.id)
    expect(new Set(forward)).toEqual(new Set(reversed))
  })
})

describeDataVersionConformance("the app store's node:sqlite driver", createNodeSqlDriver)
