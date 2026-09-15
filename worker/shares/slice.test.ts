import { describe, expect, it } from "vitest"
import type { LinkRow, NodeRow } from "../handlers/replica-payload"
import { shareFromRow, type ShareGrant } from "./grant"
import { planSliceWrite } from "./slice"

/**
 * The write boundary, pinned without a database: every row a grantee pushes
 * stays inside the slice, and the verbs are checked per row.
 */

const grantWith = (permissions: string): ShareGrant =>
  shareFromRow({
    id: "shr_1",
    owner_id: 7,
    grantee_email: "bob@example.com",
    root_ids: '["blk_note"]',
    permissions,
    created_at: 1,
    revoked_at: null,
  })

const slice = {
  nodes: new Set(["blk_note", "blk_a", "blk_b"]),
  roots: new Set(["blk_note"]),
  taken: new Set(["blk_private", "blk_gone"]),
}

const node = (id: string, extra: Partial<NodeRow> = {}): NodeRow => ({
  id,
  type: "ul",
  text: "x",
  props: null,
  updated_at: 5,
  ...extra,
})
const link = (source: string, destination: string, extra: Partial<LinkRow> = {}): LinkRow => ({
  source_id: source,
  destination_id: destination,
  kind: "child",
  sort_key: "a0",
  updated_at: 5,
  ...extra,
})

const plan = (permissions: string, nodes: NodeRow[], links: LinkRow[] = [], extra = {}) =>
  planSliceWrite(grantWith(permissions), slice, { nodes, links, ...extra })

describe("planSliceWrite", () => {
  it("lands rows inside the slice with write", () => {
    const result = plan("read,write", [node("blk_a")], [link("blk_note", "blk_b")])
    expect(result.ok).toBe(true)
  })

  it("refuses everything on a read-only share", () => {
    const result = plan("read", [node("blk_a")])
    expect(result).toMatchObject({ ok: false, refusal: { error: "permission_denied" } })
    const links = plan("read", [], [link("blk_note", "blk_a")])
    expect(links).toMatchObject({ ok: false, refusal: { error: "permission_denied" } })
  })

  it("refuses a row outside the slice, taken or not, before checking verbs", () => {
    expect(plan("read", [node("blk_private")])).toMatchObject({
      ok: false,
      refusal: { error: "outside_share" },
    })
    expect(plan("read,write,delete", [node("blk_gone")])).toMatchObject({
      ok: false,
      refusal: { error: "outside_share" },
    })
  })

  it("refuses a link with either end outside", () => {
    expect(plan("read,write", [], [link("blk_a", "blk_private")])).toMatchObject({
      ok: false,
      refusal: { error: "outside_share" },
    })
    expect(plan("read,write", [], [link("blk_private", "blk_a")])).toMatchObject({
      ok: false,
      refusal: { error: "outside_share" },
    })
  })

  it("accepts a new block anchored by a link or by its note, and refuses an orphan", () => {
    expect(plan("read,write", [node("blk_new")], [link("blk_a", "blk_new")]).ok).toBe(true)
    expect(plan("read,write", [node("blk_new", { notes_id: "blk_note" })]).ok).toBe(true)
    // Anchored to another new block that is itself anchored.
    expect(
      plan(
        "read,write",
        [node("blk_n1"), node("blk_n2")],
        [link("blk_a", "blk_n1"), link("blk_n1", "blk_n2")],
      ).ok,
    ).toBe(true)
    expect(plan("read,write", [node("blk_new")])).toMatchObject({
      ok: false,
      refusal: { error: "outside_share" },
    })
    expect(plan("read,write", [node("blk_new", { notes_id: "blk_private" })])).toMatchObject({
      ok: false,
      refusal: { error: "outside_share" },
    })
    // A tombstoned link does not anchor.
    expect(
      plan("read,write", [node("blk_new")], [link("blk_a", "blk_new", { deleted_at: 5 })]),
    ).toMatchObject({ ok: false, refusal: { error: "outside_share" } })
  })

  it("needs delete for a node tombstone and only write for a link tombstone", () => {
    expect(plan("read,write", [node("blk_a", { deleted_at: 5 })])).toMatchObject({
      ok: false,
      refusal: { error: "permission_denied" },
    })
    expect(plan("read,write,delete", [node("blk_a", { deleted_at: 5 })]).ok).toBe(true)
    expect(plan("read,write", [], [link("blk_note", "blk_a", { deleted_at: 5 })]).ok).toBe(true)
    // Delete without write: the tombstone lands, an edit does not.
    expect(plan("read,delete", [node("blk_a", { deleted_at: 5 })]).ok).toBe(true)
    expect(plan("read,delete", [node("blk_a")])).toMatchObject({
      ok: false,
      refusal: { error: "permission_denied" },
    })
  })

  it("refuses the purge channel", () => {
    expect(plan("read,write,delete", [], [], { deleteNodes: ["blk_a"] })).toMatchObject({
      ok: false,
      refusal: { status: 400 },
    })
  })
})
