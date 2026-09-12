import { describe, expect, it } from "vitest"
import { isTombstoned, type LinkRow, type NodeRow } from "../../worker/handlers/replica-payload"
import { buildGraphSnapshot, CHILD_KIND } from "./graph"
import { opsToRows } from "./ops-rows"
import type { Op } from "./ops"

/**
 * `opsToRows` is the server-side half of a translation the browser store has
 * always done inline (`planOp`/`emitWrite`, sql-note-store.ts). What is
 * pinned here is the behavior the two must share — whole-row upserts, one
 * `deleted_at` per batch, no cascade, no resurrection — because a divergence
 * would show up as an agent's edit replicating differently from a person's.
 */

const node = (id: string, text = id, extra: Partial<NodeRow> = {}): NodeRow => ({
  id,
  type: "text",
  text,
  props: null,
  updated_at: 1000,
  ...extra,
})

const link = (source: string, destination: string, sortKey = "a0"): LinkRow => ({
  source_id: source,
  destination_id: destination,
  kind: CHILD_KIND,
  sort_key: sortKey,
  updated_at: 1000,
})

const snapshotOf = (nodes: NodeRow[], links: LinkRow[]) => buildGraphSnapshot(nodes, links)

const NOW = 5000

describe("opsToRows — node writes", () => {
  it("emits a created node as a live row stamped now", () => {
    const diff = opsToRows(
      snapshotOf([], []),
      [{ op: "create", id: "blk_a", type: "todo", text: "buy milk", props: null, notesId: "page" }],
      NOW,
    )

    expect(diff.nodes).toEqual([
      {
        id: "blk_a",
        type: "todo",
        text: "buy milk",
        props: null,
        updated_at: NOW,
        notes_id: "page",
      },
    ])
    expect(diff.links).toEqual([])
  })

  it("collapses a create and a later set into ONE row holding the final value", () => {
    const diff = opsToRows(
      snapshotOf([], []),
      [
        { op: "create", id: "blk_a", type: "text", text: "first", props: null },
        { op: "setText", id: "blk_a", text: "second" },
        { op: "setType", id: "blk_a", type: "h1" },
      ],
      NOW,
    )

    expect(diff.nodes).toHaveLength(1)
    expect(diff.nodes[0]).toMatchObject({ id: "blk_a", type: "h1", text: "second" })
  })

  it("drops a set on a node the graph no longer holds, rather than resurrecting it", () => {
    const diff = opsToRows(
      snapshotOf([node("blk_a")], []),
      [
        { op: "delete", id: "blk_a" },
        { op: "setText", id: "blk_a", text: "back from the dead" },
      ],
      NOW,
    )

    expect(diff.nodes).toHaveLength(1)
    expect(isTombstoned(diff.nodes[0])).toBe(true)
    expect(diff.nodes[0].text).toBe("blk_a")
  })

  it("never carries `seq` outward — only the replica may assign one", () => {
    const snapshot = snapshotOf([node("blk_a", "a", { seq: 42 })], [])
    const diff = opsToRows(snapshot, [{ op: "setText", id: "blk_a", text: "edited" }], NOW)

    expect(diff.nodes[0]).not.toHaveProperty("seq")
  })
})

describe("opsToRows — deletes", () => {
  it("tombstones rather than removing, and stamps `updated_at` alongside", () => {
    const diff = opsToRows(snapshotOf([node("blk_a")], []), [{ op: "delete", id: "blk_a" }], NOW)

    expect(diff.nodes[0].deleted_at).toBe(NOW)
    expect(diff.nodes[0].updated_at).toBe(NOW)
  })

  it("gives every row one delete retires the SAME stamp", () => {
    const snapshot = snapshotOf([node("blk_a"), node("blk_b")], [link("blk_a", "blk_b")])
    const diff = opsToRows(
      snapshot,
      [
        { op: "unlink", source: "blk_a", destination: "blk_b" },
        { op: "delete", id: "blk_a" },
        { op: "delete", id: "blk_b" },
      ],
      NOW,
    )

    const stamps = new Set([
      ...diff.nodes.map((row) => row.deleted_at),
      ...diff.links.map((row) => row.deleted_at),
    ])
    expect(stamps).toEqual(new Set([NOW]))
  })

  it("does NOT cascade to the deleted node's links — a restore needs them", () => {
    const snapshot = snapshotOf([node("blk_a"), node("blk_b")], [link("blk_a", "blk_b")])
    const diff = opsToRows(snapshot, [{ op: "delete", id: "blk_b" }], NOW)

    expect(diff.nodes).toHaveLength(1)
    expect(diff.links).toEqual([])
  })

  it("ignores a delete of a node that is not there", () => {
    expect(opsToRows(snapshotOf([], []), [{ op: "delete", id: "ghost" }], NOW).nodes).toEqual([])
  })
})

describe("opsToRows — links", () => {
  it("emits a link as a live row with its sort key", () => {
    const diff = opsToRows(
      snapshotOf([], []),
      [{ op: "link", source: "page", destination: "blk_a", sortKey: "a1" }],
      NOW,
    )

    expect(diff.links).toEqual([
      {
        source_id: "page",
        destination_id: "blk_a",
        kind: CHILD_KIND,
        sort_key: "a1",
        updated_at: NOW,
      },
    ])
  })

  it("tombstones an unlinked row, keeping the sort key it had", () => {
    const snapshot = snapshotOf([node("page"), node("blk_a")], [link("page", "blk_a", "a5")])
    const diff = opsToRows(snapshot, [{ op: "unlink", source: "page", destination: "blk_a" }], NOW)

    expect(diff.links).toEqual([
      {
        source_id: "page",
        destination_id: "blk_a",
        kind: CHILD_KIND,
        sort_key: "a5",
        updated_at: NOW,
        deleted_at: NOW,
      },
    ])
  })

  it("ignores an unlink of a link that is not there", () => {
    expect(
      opsToRows(snapshotOf([], []), [{ op: "unlink", source: "page", destination: "blk_a" }], NOW)
        .links,
    ).toEqual([])
  })

  it("emits a link touched twice once, holding its final key", () => {
    const diff = opsToRows(
      snapshotOf([], []),
      [
        { op: "link", source: "page", destination: "blk_a", sortKey: "a1" },
        { op: "link", source: "page", destination: "blk_a", sortKey: "a9" },
      ],
      NOW,
    )

    expect(diff.links).toHaveLength(1)
    expect(diff.links[0].sort_key).toBe("a9")
  })
})

describe("opsToRows — purity", () => {
  it("leaves the input snapshot untouched", () => {
    const snapshot = snapshotOf([node("blk_a")], [])
    const before = snapshot.nodes.get("blk_a")

    opsToRows(
      snapshot,
      [
        { op: "setText", id: "blk_a", text: "changed" },
        { op: "delete", id: "blk_a" },
      ],
      NOW,
    )

    expect(snapshot.nodes.get("blk_a")).toBe(before)
    expect(snapshot.nodes.get("blk_a")?.text).toBe("blk_a")
  })

  it("emits nothing for an empty batch", () => {
    const diff = opsToRows(snapshotOf([node("blk_a")], []), [] as Op[], NOW)
    expect(diff.nodes).toEqual([])
    expect(diff.links).toEqual([])
  })
})
