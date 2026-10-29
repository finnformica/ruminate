// tenant-guard: exempt — the raw reads below prove what a pushed view wrote.
import { describe, expect, it } from "vitest"
import { ensureTenantMeta, forTenant } from "../tenancy-db"
import { corpusPullFull, corpusPullSince, corpusPut } from "./replica-corpus"
import type { ViewRow } from "./replica-payload"
import { createTenantTestDriver } from "./sqlite-test-driver"

/**
 * Views are gone (docs/removing-views.md, migrations/0031). A build from
 * before still pushes view rows and still reads `views` off a pull, so the
 * wire keeps the field: a pushed view writes nothing, and a pull answers
 * with an empty list.
 */

const view: ViewRow = {
  id: "blk_a",
  root_id: "blk_a",
  filter: "type:todo",
  sort: null,
  pinned: true,
  sort_key: "a0",
  updated_at: 100,
}

async function open() {
  const driver = await createTenantTestDriver()
  const tenant = forTenant(driver, { id: 111, login: "u111", name: null })
  await ensureTenantMeta(tenant)
  return { driver, tenant }
}

describe("views, removed", () => {
  it("has no views table", async () => {
    const { driver } = await open()
    const tables = await driver.exec(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'views'",
    )
    expect(tables).toEqual([])
  })

  it("writes nothing for a pushed view row, and still takes the push", async () => {
    const { driver, tenant } = await open()
    const node = { id: "blk_a", type: "note", text: "A", props: null, updated_at: 1 }
    await corpusPut(tenant, { nodes: [node], links: [], views: [view] })
    const log = await driver.exec(
      "SELECT entity FROM events_log WHERE user_id = 111 AND entity = 'view'",
    )
    expect(log).toEqual([])
    const [row] = await driver.exec("SELECT text FROM nodes WHERE user_id = 111 AND id = 'blk_a'")
    expect(row.text).toBe("A")
  })

  it("answers every pull with an empty views list", async () => {
    const { tenant } = await open()
    const node = { id: "blk_a", type: "note", text: "A", props: null, updated_at: 1 }
    await corpusPut(tenant, { nodes: [node], links: [], views: [view] })
    expect((await corpusPullFull(tenant)).views).toEqual([])
    expect((await corpusPullSince(tenant, 0)).views).toEqual([])
  })
})
