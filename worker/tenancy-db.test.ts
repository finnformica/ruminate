// tenant-guard: exempt — every statement below is a specimen handed TO the
// guard, or a raw read used to prove one tenant's write stayed put.
import { describe, expect, it } from "vitest"
import { CURRENT_DATA_VERSION, DATA_VERSION_KEY, ensureDataVersion } from "../src/data/data-version"
import type { SqlDriver } from "../src/data/sql-driver"
import { createTenantTestDriver } from "./handlers/sqlite-test-driver"
import type { VerifiedIdentity } from "./handlers/tenancy"
import {
  TenantScopeError,
  ensureTenantMeta,
  forAdminImport,
  forTenant,
  tenantCorpus,
  type TenantDb,
} from "./tenancy-db"

const identity = (id: number): VerifiedIdentity => ({ id, login: `u${id}`, name: null })

async function openTenants(): Promise<{ driver: SqlDriver; alice: TenantDb; bob: TenantDb }> {
  const driver = await createTenantTestDriver()
  const alice = forTenant(driver, identity(111))
  const bob = forTenant(driver, identity(222))
  await ensureTenantMeta(alice)
  await ensureTenantMeta(bob)
  return { driver, alice, bob }
}

const seed = (
  tenant: TenantDb,
  id: string,
  text: string,
  updatedAt = 100,
  deletedAt: number | null = null,
) =>
  tenant.batch([
    {
      sql:
        "INSERT INTO nodes (user_id, id, type, text, props, updated_at, deleted_at) " +
        "VALUES (:tenant, ?1, 'text', ?2, NULL, ?3, ?4)",
      params: [id, text, updatedAt, deletedAt],
    },
  ])

describe("forTenant — what the handle binds", () => {
  it("binds the verified id itself; a caller has nowhere to put one", async () => {
    const { alice, bob } = await openTenants()
    await seed(alice, "shared-id", "alice")
    await seed(bob, "shared-id", "bob")

    const read = (tenant: TenantDb) =>
      tenant.exec(
        "SELECT text FROM nodes WHERE user_id = :tenant AND id = ?1 " + "AND deleted_at IS NULL",
        ["shared-id"],
      )
    expect(await read(alice)).toEqual([{ text: "alice" }])
    expect(await read(bob)).toEqual([{ text: "bob" }])
  })

  it("appends the tenant id after the caller's parameters, whatever their number", async () => {
    const { alice } = await openTenants()
    await seed(alice, "a", "one")
    await seed(alice, "b", "two")
    // Two caller params (?1, ?2) — :tenant must land on ?3, not overwrite one.
    expect(
      await alice.exec(
        "SELECT id FROM nodes WHERE user_id = :tenant AND deleted_at IS NULL " +
          "AND id IN (?1, ?2) ORDER BY id",
        ["a", "b"],
      ),
    ).toEqual([{ id: "a" }, { id: "b" }])
  })

  it("refuses a non-integer verified id", () => {
    const driver = {
      exec: async () => [],
      batch: async () => {},
      execScript: async () => {},
      close: async () => {},
    }
    expect(() => forTenant(driver, { id: 1.5, login: "x", name: null })).toThrow(TenantScopeError)
  })

  it("exposes the tenant it is bound to, and nothing that widens it", async () => {
    const { alice } = await openTenants()
    expect(alice.userId).toBe(111)
    expect(Object.keys(alice).sort()).toEqual(["batch", "exec", "includingDeleted", "userId"])
  })
})

describe("the runtime guard", () => {
  it("refuses a corpus read with no tenant predicate", async () => {
    const { alice } = await openTenants()
    await expect(alice.exec("SELECT id FROM nodes WHERE deleted_at IS NULL")).rejects.toThrow(
      /user_id/,
    )
  })

  it("refuses a `user_id` the caller supplied rather than the token", async () => {
    const { alice } = await openTenants()
    await expect(
      alice.exec("SELECT id FROM nodes WHERE user_id = ?1 AND deleted_at IS NULL", [222]),
    ).rejects.toThrow(TenantScopeError)
  })

  it("refuses a read that says nothing about tombstones", async () => {
    const { alice } = await openTenants()
    await expect(alice.exec("SELECT id FROM nodes WHERE user_id = :tenant")).rejects.toThrow(
      /deleted_at/,
    )
  })

  it("refuses a hard DELETE from a corpus table", async () => {
    const { alice } = await openTenants()
    await expect(
      alice.exec("DELETE FROM nodes WHERE user_id = :tenant AND id = ?1", ["a"]),
    ).rejects.toThrow(/hard-delete|nothing is hard-deleted/)
  })

  it("guards every statement in a batch, and runs none of them on a refusal", async () => {
    const { alice } = await openTenants()
    await expect(
      alice.batch([
        {
          sql:
            "INSERT INTO nodes (user_id, id, type, text, props, updated_at, deleted_at) " +
            "VALUES (:tenant, 'ok', 'text', 'ok', NULL, 1, NULL)",
          params: [],
        },
        { sql: "DELETE FROM nodes WHERE user_id = :tenant", params: [] },
      ]),
    ).rejects.toThrow(TenantScopeError)
    expect(
      await alice.exec(
        "SELECT COUNT(*) AS n FROM nodes WHERE user_id = :tenant " + "AND deleted_at IS NULL",
      ),
    ).toEqual([{ n: 0 }])
  })

  it("lets statements that touch no corpus table through untouched", async () => {
    const { alice, driver } = await openTenants()
    await driver.execScript("CREATE TABLE probe (a INTEGER)")
    await alice.exec("INSERT INTO probe (a) VALUES (1)")
    expect(await alice.exec("SELECT a FROM probe")).toEqual([{ a: 1 }])
  })
})

describe("includingDeleted — the narrow opt-out", () => {
  it("reads tombstones, and only relaxes the tombstone rule", async () => {
    const { alice, bob } = await openTenants()
    await seed(alice, "gone", "alice's deleted", 200, 200)
    await seed(bob, "gone", "bob's deleted", 200, 200)

    const all = alice.includingDeleted()
    expect(await all.exec("SELECT text FROM nodes WHERE user_id = :tenant")).toEqual([
      { text: "alice's deleted" },
    ])
    // Still scoped: it is a view of ONE tenant's rows, tombstones included.
    await expect(all.exec("SELECT text FROM nodes")).rejects.toThrow(TenantScopeError)
  })

  it("does not leak back into the handle it came from", async () => {
    const { alice } = await openTenants()
    alice.includingDeleted()
    await expect(alice.exec("SELECT id FROM nodes WHERE user_id = :tenant")).rejects.toThrow(
      TenantScopeError,
    )
  })
})

describe("forAdminImport — the one non-session mint", () => {
  it("scopes exactly like a session handle", async () => {
    const { driver, alice } = await openTenants()
    await seed(alice, "a", "alice")
    const asBob = forAdminImport(driver, 222)
    expect(asBob.userId).toBe(222)
    expect(
      await asBob.exec("SELECT id FROM nodes WHERE user_id = :tenant AND deleted_at IS NULL"),
    ).toEqual([])
    await expect(asBob.exec("SELECT id FROM nodes")).rejects.toThrow(TenantScopeError)
  })

  it("refuses a non-integer user id", () => {
    const driver = {
      exec: async () => [],
      batch: async () => {},
      execScript: async () => {},
      close: async () => {},
    }
    expect(() => forAdminImport(driver, Number.NaN)).toThrow(TenantScopeError)
  })
})

describe("tenantCorpus — the data-version transform, per tenant", () => {
  it("rewrites one tenant's rows and leaves the other's alone", async () => {
    const { alice, bob } = await openTenants()
    // The same legacy near-miss spelling in both partitions.
    for (const tenant of [alice, bob]) {
      await tenant.batch([
        {
          sql:
            "INSERT INTO nodes (user_id, id, type, text, props, updated_at, deleted_at) " +
            "VALUES (:tenant, 'p', 'page', 'p', NULL, 100, NULL)",
          params: [],
        },
        {
          sql:
            "INSERT INTO nodes (user_id, id, type, text, props, updated_at, deleted_at) " +
            "VALUES (:tenant, 'blk_a', 'text', '[] buy milk', NULL, 100, NULL)",
          params: [],
        },
        {
          sql:
            "INSERT INTO link (user_id, source_id, destination_id, kind, sort_key, " +
            "updated_at, deleted_at) VALUES (:tenant, 'p', 'blk_a', 'child', 'a0', 100, NULL)",
          params: [],
        },
      ])
    }

    await ensureDataVersion(tenantCorpus(alice))

    const typeFor = async (tenant: TenantDb) =>
      (
        await tenant.exec(
          "SELECT type FROM nodes WHERE user_id = :tenant AND id = 'blk_a' AND deleted_at IS NULL",
        )
      )[0]?.type
    expect(await typeFor(alice)).toBe("todo")
    expect(await typeFor(bob)).toBe("text")

    const versionFor = async (tenant: TenantDb) =>
      await tenant.exec("SELECT value FROM meta WHERE user_id = :tenant AND key = ?1", [
        DATA_VERSION_KEY,
      ])
    expect(await versionFor(alice)).toEqual([{ value: String(CURRENT_DATA_VERSION) }])
    expect(await versionFor(bob)).toEqual([])
  })

  it("does not stamp an empty partition, so rows arriving later still transform", async () => {
    const { alice } = await openTenants()
    await ensureDataVersion(tenantCorpus(alice))
    expect(
      await alice.exec("SELECT value FROM meta WHERE user_id = :tenant AND key = ?1", [
        DATA_VERSION_KEY,
      ]),
    ).toEqual([])
  })
})

describe("ensureTenantMeta", () => {
  it("seeds a new tenant's keys once, and never overwrites them", async () => {
    const { alice } = await openTenants()
    await alice.batch([
      {
        sql:
          "INSERT INTO meta (user_id, key, value) VALUES (:tenant, 'replica_cursor', 'mine') " +
          "ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value",
        params: [],
      },
    ])
    await ensureTenantMeta(alice)
    expect(
      await alice.exec("SELECT value FROM meta WHERE user_id = :tenant AND key = 'replica_cursor'"),
    ).toEqual([{ value: "mine" }])
  })
})
