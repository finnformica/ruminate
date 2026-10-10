// tenant-guard: exempt — the raw reads below prove what a pushed view wrote.
import { describe, expect, it } from "vitest"
import { ensureTenantMeta, forTenant } from "../tenancy-db"
import { corpusPut } from "./replica-corpus"
import { parseReplicaPayload, toViewRow, type ViewRow } from "./replica-payload"
import { createTenantTestDriver } from "./sqlite-test-driver"

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

describe("a pushed view, through the log", () => {
  async function open() {
    const driver = await createTenantTestDriver()
    const tenant = forTenant(driver, { id: 111, login: "u111", name: null })
    await ensureTenantMeta(tenant)
    const stored = () =>
      driver.exec("SELECT id, filter, pinned, updated_at, seq FROM views WHERE user_id = 111")
    return { driver, tenant, stored }
  }

  it("lands under last-writer-wins: a stale push cannot clobber", async () => {
    const { tenant, stored } = await open()
    await corpusPut(tenant, { nodes: [], links: [], views: [view({ updated_at: 200 })] })
    await corpusPut(tenant, {
      nodes: [],
      links: [],
      views: [view({ filter: "type:stale", updated_at: 100 })],
    })
    expect(await stored()).toEqual([
      { id: "view_1", filter: "type:todo", pinned: 1, updated_at: 200, seq: 1 },
    ])
  })

  it("stores pinned as the integer the column holds, on and off", async () => {
    const { tenant, stored } = await open()
    await corpusPut(tenant, { nodes: [], links: [], views: [view()] })
    expect((await stored())[0].pinned).toBe(1)
    await corpusPut(tenant, {
      nodes: [],
      links: [],
      views: [view({ pinned: false, updated_at: 300 })],
    })
    expect((await stored())[0].pinned).toBe(0)
  })

  it("takes its sequence from the one the whole corpus shares", async () => {
    // One cursor covers the corpus, so a view write must not reuse a number a
    // node already holds — nor the other way round.
    const { driver, tenant, stored } = await open()
    const node = { id: "blk_a", type: "note", text: "A", props: null, updated_at: 1 }
    await corpusPut(tenant, { nodes: [node], links: [] })
    await corpusPut(tenant, { nodes: [], links: [], views: [view()] })
    await corpusPut(tenant, { nodes: [{ ...node, text: "A2", updated_at: 2 }], links: [] })
    expect((await stored())[0].seq).toBe(2)
    const [row] = await driver.exec("SELECT seq FROM nodes WHERE user_id = 111 AND id = 'blk_a'")
    expect(row.seq).toBe(3)
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
