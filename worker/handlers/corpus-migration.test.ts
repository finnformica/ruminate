// tenant-guard: exempt — inspects both tenants' raw rows on purpose.
import { describe, expect, it } from "vitest"
import type { SqlDriver } from "../../src/data/sql-driver"
import { ensureTenantMeta, forAdminImport, forTenant, type TenantDb } from "../tenancy-db"
import { DO_IMPORT_KEY, importDoCorpus, type DoCorpusSource } from "./corpus-migration"
import { corpusPullFull, corpusPut, corpusStatus } from "./replica-corpus"
import { createTenantTestDriver } from "./sqlite-test-driver"

/**
 * The DO→D1 import, run for real: a plain object plays the retiring
 * `UserCorpus` (its RPC surface is one method), and the target is a genuine
 * tenant partition of a database in the exact shape production D1 is in.
 */

const NOW = 1_700_000_000_000

const rows = {
  nodes: [
    { id: "note-a", type: "page", text: "note-a", props: null, updated_at: 100 },
    { id: "blk_a000000000", type: "text", text: "A", props: null, updated_at: 100 },
  ],
  links: [
    {
      source_id: "note-a",
      destination_id: "blk_a000000000",
      kind: "child",
      sort_key: "a0",
      updated_at: 100,
    },
  ],
}

const doWith = (cursor: string | null = "cursor-42"): DoCorpusSource => ({
  exportRows: async () => ({ ...rows, cursor }),
})
const emptyDo: DoCorpusSource = { exportRows: async () => null }

async function tenantOn(driver: SqlDriver, id: number): Promise<TenantDb> {
  const tenant = forTenant(driver, { id, login: `u${id}`, name: null })
  await ensureTenantMeta(tenant)
  return tenant
}

describe("importDoCorpus", () => {
  it("imports rows + cursor into an empty partition and marks the tenant", async () => {
    const driver = await createTenantTestDriver()
    const tenant = await tenantOn(driver, 111)

    expect(await importDoCorpus(doWith(), tenant, { now: () => NOW })).toEqual({
      userId: 111,
      imported: true,
      reason: "imported",
      nodes: 2,
      links: 1,
    })
    const imported = await corpusPullFull(tenant)
    expect(imported.nodes).toEqual(rows.nodes)
    expect(imported.links).toEqual(rows.links)
    expect(imported.cursor).toBe("cursor-42")
    expect(
      await tenant.exec("SELECT value FROM meta WHERE user_id = :tenant AND key = ?1", [
        DO_IMPORT_KEY,
      ]),
    ).toEqual([{ value: String(NOW) }])
  })

  it("is a no-op once marked — the DO is not even read again", async () => {
    const driver = await createTenantTestDriver()
    const tenant = await tenantOn(driver, 111)
    await importDoCorpus(doWith(), tenant, { now: () => NOW })

    let reads = 0
    const counted: DoCorpusSource = {
      exportRows: async () => {
        reads += 1
        return { ...rows, cursor: null }
      },
    }
    expect((await importDoCorpus(counted, tenant)).reason).toBe("already_imported")
    expect(reads).toBe(0)
  })

  it("refuses a non-empty partition by default (re-runs cannot clobber)", async () => {
    const driver = await createTenantTestDriver()
    const tenant = await tenantOn(driver, 111)
    const existing = {
      nodes: [{ id: "note-b", type: "page", text: "note-b", props: null, updated_at: 999 }],
      links: [],
    }
    await corpusPut(tenant, existing, NOW)

    expect(await importDoCorpus(doWith(), tenant, { now: () => NOW })).toMatchObject({
      imported: false,
      reason: "corpus_not_empty",
    })
    expect((await corpusPullFull(tenant)).nodes).toEqual(existing.nodes)
    // Not marked: the operator can retry with `merge` once they have decided.
    expect(
      await tenant.exec("SELECT value FROM meta WHERE user_id = :tenant AND key = ?1", [
        DO_IMPORT_KEY,
      ]),
    ).toEqual([])
  })

  it("merges into a non-empty partition by LWW — the owner's case", async () => {
    // The owner's partition holds the PRE-DO rows migration 0004 preserved;
    // the DO holds what they wrote since. Merging must let the newer side win
    // both ways, and delete nothing.
    const driver = await createTenantTestDriver()
    const tenant = await tenantOn(driver, 111)
    await corpusPut(
      tenant,
      {
        nodes: [
          { id: "note-a", type: "page", text: "stale pre-DO", props: null, updated_at: 50 },
          { id: "blk_only_d1", type: "text", text: "only in D1", props: null, updated_at: 900 },
        ],
        links: [],
      },
      NOW,
    )

    expect(await importDoCorpus(doWith(), tenant, { merge: true, now: () => NOW })).toMatchObject({
      imported: true,
      reason: "imported",
    })
    const merged = await corpusPullFull(tenant)
    expect(merged.nodes.find((row) => row.id === "note-a")?.text).toBe("note-a") // DO wins (newer)
    expect(merged.nodes.find((row) => row.id === "blk_only_d1")?.text).toBe("only in D1") // kept
    expect(merged.nodes).toHaveLength(3)
  })

  it("marks an empty DO done, so it is never read again", async () => {
    const driver = await createTenantTestDriver()
    const tenant = await tenantOn(driver, 111)
    expect(await importDoCorpus(emptyDo, tenant, { now: () => NOW })).toMatchObject({
      imported: false,
      reason: "do_empty",
    })
    expect((await importDoCorpus(doWith(), tenant)).reason).toBe("already_imported")
  })

  it("tolerates the binding being gone (the follow-up release)", async () => {
    const driver = await createTenantTestDriver()
    const tenant = await tenantOn(driver, 111)
    expect(await importDoCorpus(null, tenant)).toMatchObject({
      imported: false,
      reason: "do_unavailable",
    })
  })

  it("`force` re-runs a marked tenant", async () => {
    const driver = await createTenantTestDriver()
    const tenant = await tenantOn(driver, 111)
    await importDoCorpus(doWith(), tenant, { now: () => NOW })
    expect(
      await importDoCorpus(doWith(), tenant, { force: true, merge: true, now: () => NOW }),
    ).toMatchObject({ imported: true })
  })

  it("imports into the named tenant and nobody else", async () => {
    const driver = await createTenantTestDriver()
    const alice = await tenantOn(driver, 111)
    const bob = await tenantOn(driver, 222)
    // The admin mint is the one non-session path; it must still be scoped.
    const target = forAdminImport(driver, 222)
    await importDoCorpus(doWith(), target, { now: () => NOW })

    expect((await corpusStatus(alice)).counts.nodes).toBe(0)
    expect((await corpusStatus(bob)).counts.nodes).toBe(2)
  })
})
