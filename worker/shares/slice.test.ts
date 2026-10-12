import { describe, expect, it } from "vitest"
import type { LinkRow, NodeRow } from "../handlers/replica-payload"
import { shareFromRow, type ShareGrant } from "./grant"
import { planSliceWrite, type SliceNode } from "./slice"

/**
 * The write boundary, pinned without a database: every row a grantee pushes
 * stays inside the slice, and the verbs are checked per row.
 */

const grantWith = (permissions: string): ShareGrant =>
  shareFromRow({
    id: "shr_1",
    owner_id: 7,
    grantee_email: "bob@example.com",
    view_id: "blk_note",
    permissions,
    created_at: 1,
    revoked_at: null,
  })

/** The slice as stored: a note root pinned by its owner, two bullets in it. */
const stored = (type: string, props: string | null = null): SliceNode => ({
  notes_id: type === "note" ? null : "blk_note",
  props,
})
const slice = {
  nodes: new Map<string, SliceNode>([
    ["blk_note", stored("note", '{"pinned":true,"width":"wide"}')],
    ["blk_a", stored("ul")],
    ["blk_b", stored("ul")],
  ]),
  roots: new Set(["blk_note"]),
  // Ids the owner's partition holds outside the closure: a block of a
  // private note, one the owner tombstoned there, and a PARKED one — born in
  // the shared note, out of reach now (unlinked into the owner's basket, or
  // tombstoned), the shared note's own still.
  taken: new Map<string, SliceNode>([
    ["blk_private", { notes_id: "blk_other", props: null }],
    ["blk_gone", { notes_id: "blk_other", props: null }],
    ["blk_parked", stored("ul")],
  ]),
}
const NOW = 1_000

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
  planSliceWrite(grantWith(permissions), slice, { nodes, links, ...extra }, NOW)

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

  it("tombstones and unlinks a block with write; a read-only share does neither", () => {
    // `write` carries `delete` (grant.ts): the one switch is read or edit.
    expect(plan("read,write", [node("blk_a", { deleted_at: 5 })]).ok).toBe(true)
    expect(plan("read,write", [], [link("blk_note", "blk_a", { deleted_at: 5 })]).ok).toBe(true)
    expect(plan("read", [node("blk_a", { deleted_at: 5 })])).toMatchObject({
      ok: false,
      refusal: { error: "permission_denied" },
    })
    // A row that somehow holds delete without write: the tombstone lands, an
    // edit does not. Nothing writes such a row; the grant still reads it.
    expect(plan("read,delete", [node("blk_a", { deleted_at: 5 })]).ok).toBe(true)
    expect(plan("read,delete", [node("blk_a")])).toMatchObject({
      ok: false,
      refusal: { error: "permission_denied" },
    })
  })

  it("never tombstones the root: what was shared is the owner's to delete", () => {
    const root = node("blk_note", {
      type: "note",
      props: '{"pinned":true,"width":"wide"}',
      deleted_at: 5,
    })
    expect(plan("read,write,delete", [root])).toMatchObject({
      ok: false,
      refusal: { error: "permission_denied", detail: expect.stringContaining("owner") },
    })
  })

  it("writes a parked block — born in a root, out of reach — as it writes a slice row", () => {
    // An undo re-links a removed row before the slice has caught up: the
    // link alone names it.
    expect(plan("read,write", [], [link("blk_a", "blk_parked")]).ok).toBe(true)
    // …or after: the client no longer holds it and creates it anew.
    expect(plan("read,write", [node("blk_parked")], [link("blk_a", "blk_parked")]).ok).toBe(true)
    // The basket the grantee keeps on their side edits it where it sits.
    expect(plan("read,write", [node("blk_parked")]).ok).toBe(true)
    // And deletes it there; a redo of a deleted block revives the tombstone.
    expect(plan("read,write", [node("blk_parked", { deleted_at: 5 })]).ok).toBe(true)
    // It keeps its home note, like any row the owner already holds.
    const result = plan("read,write", [node("blk_parked", { notes_id: "blk_note" })])
    expect(result.ok && "notes_id" in result.nodes[0]).toBe(false)
    // Its props are the owner's as any slice node's are.
    expect(plan("read,write", [node("blk_parked", { props: '{"width":"wide"}' })])).toMatchObject({
      ok: false,
      refusal: { error: "permission_denied", detail: expect.stringContaining("width") },
    })
    // Still a write.
    expect(plan("read", [node("blk_parked")])).toMatchObject({
      ok: false,
      refusal: { error: "permission_denied" },
    })
    // A block born anywhere else is the owner's, by id, live or dead.
    expect(plan("read,write", [node("blk_gone")], [link("blk_a", "blk_gone")])).toMatchObject({
      ok: false,
      refusal: { error: "outside_share" },
    })
  })

  it("lets write change a row's type: any block, a note or a board included", () => {
    expect(plan("read,write", [node("blk_a", { type: "todo" })]).ok).toBe(true)
    expect(plan("read,write", [node("blk_a", { type: "board" })]).ok).toBe(true)
    const root = (type: string) => node("blk_note", { type, props: '{"width":"wide"}' })
    expect(plan("read,write", [root("board")]).ok).toBe(true)
    expect(plan("read,write", [root("ul")]).ok).toBe(true)
    for (const type of ["note", "board"]) {
      expect(plan("read,write", [node("blk_new", { type })], [link("blk_a", "blk_new")]).ok).toBe(
        true,
      )
    }
    // Still a write: a read-only share changes no type.
    expect(plan("read", [node("blk_a", { type: "todo" })]).ok).toBe(false)
  })

  it("keeps the owner's props: carried unchanged, never changed or introduced", () => {
    const root = (props: string | null) => node("blk_note", { type: "note", props })
    // The row as the grantee holds it — the owner's width intact, their own
    // edit stamped beside it. (A `pinned` key is nobody's since 0016: a pin
    // is a view, and the grantee's own to set; the key passes as any prop.)
    expect(plan("read,write", [root('{"width":"wide","pinned":true,"updated_at":"x"}')]).ok).toBe(
      true,
    )
    expect(plan("read,write", [root('{"width":"wide","pinned":false}')]).ok).toBe(true)
    for (const props of ['{"pinned":true,"width":"narrow"}', '{"pinned":true}', null]) {
      expect(plan("read,write", [root(props)])).toMatchObject({
        ok: false,
        refusal: { error: "permission_denied", detail: expect.stringContaining("width") },
      })
    }
    expect(
      plan("read,write", [root('{"pinned":true,"width":"wide","font":"serif"}')]),
    ).toMatchObject({
      ok: false,
      refusal: { detail: expect.stringContaining("font") },
    })
    expect(
      plan(
        "read,write",
        [node("blk_new", { props: '{"width":"wide"}' })],
        [link("blk_a", "blk_new")],
      ),
    ).toMatchObject({ ok: false, refusal: { detail: expect.stringContaining("width") } })
  })

  it("lands notes_id only on a new row, and clamps every clock to the server's", () => {
    const result = plan(
      "read,write,delete",
      [
        node("blk_a", { notes_id: "blk_private", updated_at: NOW + 500 }),
        node("blk_b", { updated_at: 5, deleted_at: NOW + 500 }),
        node("blk_new", { notes_id: "blk_note", updated_at: NOW + 500 }),
      ],
      [link("blk_note", "blk_a", { updated_at: NOW + 500 })],
    )
    expect(result).toMatchObject({
      ok: true,
      nodes: [
        { id: "blk_a", updated_at: NOW },
        { id: "blk_b", updated_at: 5, deleted_at: NOW },
        { id: "blk_new", notes_id: "blk_note", updated_at: NOW },
      ],
      links: [{ updated_at: NOW }],
    })
    expect(result.ok && "notes_id" in result.nodes[0]).toBe(false)
  })

  it("refuses the purge channel", () => {
    expect(plan("read,write,delete", [], [], { deleteNodes: ["blk_a"] })).toMatchObject({
      ok: false,
      refusal: { status: 400 },
    })
  })
})
