import { describe, expect, it } from "vitest"
import type { SqlDriver } from "../../src/data/sql-driver"
import { applyControlPlane, createTestSqlDriver } from "./sqlite-test-driver"
import { resolveTenancy, type VerifiedIdentity } from "./tenancy"

/**
 * The tenancy resolver against a REAL engine and the REAL control-plane
 * migration: `node:sqlite` runs the exact `users`/`allowlist` DDL D1 runs
 * (0003_control_plane.sql, which also seeds the owner allowlist row), so
 * what's pinned here is the deployed behavior, not a fake's.
 */

const OWNER_ID = 42536816 // the id 0003 seeds into the allowlist
const OWNER = "42536816"

/** What the sign-in callback resolves: id, login and the address. */
const identity = (id: number, login = `user-${id}`): VerifiedIdentity => ({
  id,
  login,
  name: null,
  email: `${login}@example.com`,
})

/** What the API path resolves: no address. */
const apiIdentity = (id: number): VerifiedIdentity => ({ id, login: `user-${id}`, name: null })

async function controlPlane(): Promise<SqlDriver> {
  const driver = createTestSqlDriver()
  await applyControlPlane(driver)
  return driver
}

const userRow = async (driver: SqlDriver, id: number) =>
  (await driver.exec("SELECT * FROM users WHERE github_id = ?1", [id]))[0]

describe("resolveTenancy — the address", () => {
  it("records the sign-in's address on the row it provisions, lowercased", async () => {
    const driver = await controlPlane()
    const decision = await resolveTenancy(
      driver,
      { ...identity(7), email: "Ada@Example.com" },
      { signupMode: "open", bootstrapGithubId: undefined },
    )
    expect(decision.allowed).toBe(true)
    expect((await userRow(driver, 7))?.email).toBe("ada@example.com")
  })

  it("refreshes a changed address on an existing row, and leaves it alone without one", async () => {
    const driver = await controlPlane()
    await driver.exec(
      "INSERT INTO users (github_id, login, created_at, email) VALUES (7, 'a', 1, 'old@example.com')",
    )
    // The API path carries no address: the stored one survives.
    await resolveTenancy(driver, apiIdentity(7), {
      signupMode: "open",
      bootstrapGithubId: undefined,
    })
    expect((await userRow(driver, 7))?.email).toBe("old@example.com")
    await resolveTenancy(
      driver,
      { ...identity(7), email: "new@example.com" },
      { signupMode: "open", bootstrapGithubId: undefined },
    )
    expect((await userRow(driver, 7))?.email).toBe("new@example.com")
  })

  it("records nothing for a refused identity", async () => {
    const driver = await controlPlane()
    const decision = await resolveTenancy(driver, identity(7), {
      signupMode: "allowlist",
      bootstrapGithubId: undefined,
    })
    expect(decision.allowed).toBe(false)
    expect(await userRow(driver, 7)).toBeUndefined()
  })

  it("refuses to provision without an address: the API path cannot sign a new id up", async () => {
    // `users.email` is mandatory (migrations/0011), and only the callback
    // carries one — so a row can come from nowhere else.
    const driver = await controlPlane()
    for (const signupMode of ["open", "allowlist"]) {
      await driver.exec("INSERT OR IGNORE INTO allowlist (github_id) VALUES (9)")
      const decision = await resolveTenancy(driver, apiIdentity(9), {
        signupMode,
        bootstrapGithubId: "9",
      })
      expect(decision).toEqual({ allowed: false, status: 403, error: "sign_in_required" })
      expect(await userRow(driver, 9)).toBeUndefined()
    }
  })
})

describe("users.email", () => {
  it("is checked by the database: lowercased, one @, a dot after it, no spaces", async () => {
    const driver = await controlPlane()
    const insert = async (email: string) =>
      driver.exec(
        "INSERT INTO users (github_id, login, created_at, email) VALUES (9, 'x', 1, ?1)",
        [email],
      )
    for (const bad of ["Ada@Example.com", "ada", "ada@x", "ada @example.com"]) {
      await expect(insert(bad)).rejects.toThrow(/CHECK/)
    }
    await expect(insert("ada@example.com")).resolves.toBeDefined()
  })
})

describe("resolveTenancy — existing users", () => {
  it("allows an active user in every mode", async () => {
    const driver = await controlPlane()
    await driver.exec(
      "INSERT INTO users (github_id, login, created_at, email) VALUES (7, 'a', 1, 'a@example.com')",
    )
    for (const signupMode of ["allowlist", "open", undefined]) {
      const decision = await resolveTenancy(driver, identity(7), {
        signupMode,
        bootstrapGithubId: undefined,
      })
      expect(decision).toEqual({ allowed: true })
    }
  })

  it("always rejects a blocked user, even in open mode and for the owner", async () => {
    const driver = await controlPlane()
    await driver.exec(
      "INSERT INTO users (github_id, login, status, created_at, email) " +
        "VALUES (?1, 'x', 'blocked', 1, 'x@example.com')",
      [OWNER_ID],
    )
    const decision = await resolveTenancy(driver, identity(OWNER_ID), {
      signupMode: "open",
      bootstrapGithubId: OWNER,
    })
    expect(decision).toEqual({ allowed: false, status: 403, error: "blocked" })
  })

  it("refreshes last_seen_at only when stale", async () => {
    const driver = await controlPlane()
    await driver.exec(
      "INSERT INTO users (github_id, login, created_at, last_seen_at, email) VALUES (7, 'a', 1, 1000, 'a@example.com')",
    )
    // Fresh enough: untouched.
    await resolveTenancy(driver, identity(7), {
      signupMode: "open",
      bootstrapGithubId: undefined,
      now: () => 2000,
    })
    expect((await userRow(driver, 7))?.last_seen_at).toBe(1000)
    // Stale (> 6h): refreshed.
    const later = 1000 + 7 * 60 * 60 * 1000
    await resolveTenancy(driver, identity(7), {
      signupMode: "open",
      bootstrapGithubId: undefined,
      now: () => later,
    })
    expect((await userRow(driver, 7))?.last_seen_at).toBe(later)
  })
})

describe("resolveTenancy — signup (no users row)", () => {
  it("allowlist mode admits a listed id and provisions its users row", async () => {
    const driver = await controlPlane()
    await driver.exec("INSERT INTO allowlist (github_id, note) VALUES (777, 'friend')")
    const decision = await resolveTenancy(driver, identity(777, "friend"), {
      signupMode: "allowlist",
      bootstrapGithubId: OWNER,
      now: () => 123,
    })
    expect(decision).toEqual({ allowed: true })
    expect(await userRow(driver, 777)).toMatchObject({
      login: "friend",
      status: "active",
      created_at: 123,
      created_by: "allowlist",
    })
  })

  it("allowlist mode admits the seeded owner row from the real migration", async () => {
    const driver = await controlPlane()
    const decision = await resolveTenancy(driver, identity(OWNER_ID), {
      signupMode: "allowlist",
      bootstrapGithubId: undefined, // even without the bootstrap var
    })
    expect(decision).toEqual({ allowed: true })
  })

  it("allowlist mode admits the bootstrap owner even without an allowlist row", async () => {
    const driver = await controlPlane()
    await driver.exec("DELETE FROM allowlist")
    const decision = await resolveTenancy(driver, identity(OWNER_ID), {
      signupMode: "allowlist",
      bootstrapGithubId: OWNER,
    })
    expect(decision).toEqual({ allowed: true })
  })

  it("allowlist mode rejects an unlisted id (403 signup_closed), provisioning nothing", async () => {
    const driver = await controlPlane()
    const decision = await resolveTenancy(driver, identity(999), {
      signupMode: "allowlist",
      bootstrapGithubId: OWNER,
    })
    expect(decision).toEqual({ allowed: false, status: 403, error: "signup_closed" })
    expect(await userRow(driver, 999)).toBeUndefined()
  })

  it("open mode auto-provisions any verified id", async () => {
    const driver = await controlPlane()
    const decision = await resolveTenancy(driver, identity(999, "stranger"), {
      signupMode: "open",
      bootstrapGithubId: OWNER,
      now: () => 456,
    })
    expect(decision).toEqual({ allowed: true })
    expect(await userRow(driver, 999)).toMatchObject({
      login: "stranger",
      created_by: "signup",
      created_at: 456,
    })
  })

  it("provisioning is idempotent — a second resolve leaves one row", async () => {
    const driver = await controlPlane()
    await resolveTenancy(driver, identity(999), { signupMode: "open", bootstrapGithubId: OWNER })
    await resolveTenancy(driver, identity(999), { signupMode: "open", bootstrapGithubId: OWNER })
    const rows = await driver.exec("SELECT COUNT(*) AS n FROM users WHERE github_id = 999")
    expect(rows[0]?.n).toBe(1)
  })

  it("absent/unknown mode fails closed: bootstrap owner only", async () => {
    const driver = await controlPlane()
    expect(
      await resolveTenancy(driver, identity(OWNER_ID), {
        signupMode: undefined,
        bootstrapGithubId: OWNER,
      }),
    ).toEqual({ allowed: true })
    expect(
      await resolveTenancy(driver, identity(999), {
        signupMode: undefined,
        bootstrapGithubId: OWNER,
      }),
    ).toEqual({ allowed: false, status: 403, error: "forbidden" })
    expect(
      await resolveTenancy(driver, identity(999), {
        signupMode: "everyone!!", // unknown mode must not open the gate
        bootstrapGithubId: OWNER,
      }),
    ).toEqual({ allowed: false, status: 403, error: "forbidden" })
    expect(
      await resolveTenancy(driver, identity(999), {
        signupMode: undefined,
        bootstrapGithubId: undefined,
      }),
    ).toEqual({ allowed: false, status: 403, error: "owner_not_configured" })
  })
})

describe("resolveTenancy — control-plane migration not applied", () => {
  it("degrades to exactly the legacy ALLOWED_GITHUB_ID behavior", async () => {
    const bare = createTestSqlDriver() // no tables at all
    expect(
      await resolveTenancy(bare, identity(OWNER_ID), {
        signupMode: "open", // even open mode cannot admit without the tables
        bootstrapGithubId: OWNER,
      }),
    ).toEqual({ allowed: true })
    expect(
      await resolveTenancy(bare, identity(999), {
        signupMode: "open",
        bootstrapGithubId: OWNER,
      }),
    ).toEqual({ allowed: false, status: 403, error: "forbidden" })
    expect(
      await resolveTenancy(bare, identity(OWNER_ID), {
        signupMode: "allowlist",
        bootstrapGithubId: undefined,
      }),
    ).toEqual({ allowed: false, status: 403, error: "owner_not_configured" })
  })
})
