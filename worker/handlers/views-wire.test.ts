import { describe, expect, it } from "vitest"
import { parseReplicaPayload, planReplicaPut, toViewRow, type ViewRow } from "./replica-payload"

/**
 * Views on the wire: what a client may push, and what the replica does with
 * it. The shape is `nodes`/`link`'s — per-row last-writer-wins, a tombstone as
 * an ordinary column, a server-assigned `seq` — so the interesting cases are
 * the ones where views differ: `pinned` crosses as a boolean over an INTEGER
 * column, and the whole array is OPTIONAL, because a client older than
 * migrations/0015 pushes none and that must not read as "delete them all".
 */

const view = (over: Partial<ViewRow> = {}): ViewRow => ({
  id: "view_1",
  root_id: "blk_a",
  filter: "type:todo",
  sort: null,
  pinned: true,
  sort_key: "a0",
  updated_at: 100,
  ...over,
})

describe("parseReplicaPayload, views", () => {
  it("accepts a push with views", () => {
    const parsed = parseReplicaPayload({ nodes: [], links: [], views: [view()] })
    expect(parsed?.views).toEqual([view()])
  })

  it("treats an absent array as nothing said, not as an empty corpus", () => {
    const parsed = parseReplicaPayload({ nodes: [], links: [] })
    expect(parsed).not.toBeNull()
    expect(parsed?.views).toBeUndefined()
  })

  it("refuses a row whose required fields are wrong", () => {
    const bad = (over: Record<string, unknown>) =>
      parseReplicaPayload({ nodes: [], links: [], views: [{ ...view(), ...over }] })
    expect(bad({ id: "" })).toBeNull()
    expect(bad({ root_id: 5 })).toBeNull()
    // `pinned` is a boolean on the wire; the INTEGER column is the database's
    // business, not the client's.
    expect(bad({ pinned: 1 })).toBeNull()
    expect(bad({ updated_at: "100" })).toBeNull()
    expect(bad({ filter: 7 })).toBeNull()
  })

  it("carries a tombstone, and refuses a malformed one", () => {
    const parsed = parseReplicaPayload({
      nodes: [],
      links: [],
      views: [view({ deleted_at: 200 })],
    })
    expect(parsed?.views?.[0].deleted_at).toBe(200)
    expect(
      parseReplicaPayload({ nodes: [], links: [], views: [{ ...view(), deleted_at: "x" }] }),
    ).toBeNull()
  })
})

describe("planReplicaPut, views", () => {
  const sqlFor = (payload: Parameters<typeof planReplicaPut>[0]) =>
    planReplicaPut(payload, 1).map((statement) => statement.sql)

  it("upserts under last-writer-wins, scoped to the tenant", () => {
    const [sql] = sqlFor({ nodes: [], links: [], views: [view()] })
    expect(sql).toContain("INSERT INTO views")
    expect(sql).toContain(":tenant")
    // The same guard every other row write has: a stale push cannot clobber.
    expect(sql).toContain("WHERE excluded.updated_at >= views.updated_at")
  })

  it("binds pinned as the integer the column holds", () => {
    const [statement] = planReplicaPut({ nodes: [], links: [], views: [view()] }, 1)
    expect(statement.params).toEqual(["view_1", "blk_a", "type:todo", null, 1, "a0", 100, null])
    const [off] = planReplicaPut({ nodes: [], links: [], views: [view({ pinned: false })] }, 1)
    expect(off.params[4]).toBe(0)
  })

  it("plans nothing when a client pushes no views", () => {
    expect(sqlFor({ nodes: [], links: [] }).filter((sql) => sql.includes("views"))).toEqual([])
  })

  it("takes its sequence from all three tables", () => {
    // One cursor covers the corpus, so a view write must not reuse a number a
    // node already holds — nor the other way round.
    for (const sql of sqlFor({ nodes: [], links: [], views: [view()] })) {
      expect(sql).toContain("MAX(seq) AS s FROM nodes")
      expect(sql).toContain("MAX(seq) FROM link")
      expect(sql).toContain("MAX(seq) FROM views")
    }
  })
})

describe("toViewRow", () => {
  it("reads a driver row, integer pinned and all", () => {
    expect(
      toViewRow({
        id: "view_1",
        root_id: "blk_a",
        filter: null,
        sort: "text:desc",
        pinned: 1,
        sort_key: null,
        updated_at: 100,
        deleted_at: null,
        seq: 7,
      }),
    ).toEqual({
      id: "view_1",
      root_id: "blk_a",
      filter: null,
      sort: "text:desc",
      pinned: true,
      sort_key: null,
      updated_at: 100,
      seq: 7,
    })
  })

  it("keeps deleted_at present only on a tombstone", () => {
    expect(
      toViewRow({ id: "v", root_id: "r", pinned: 0, updated_at: 1, deleted_at: 9 }).deleted_at,
    ).toBe(9)
    expect("deleted_at" in toViewRow({ id: "v", root_id: "r", pinned: 0, updated_at: 1 })).toBe(
      false,
    )
  })
})
