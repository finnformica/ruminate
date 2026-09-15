import { describe, expect, it } from "vitest"
import { applyControlPlane, createTestSqlDriver } from "./handlers/sqlite-test-driver"
import {
  inviteState,
  inviteTokenFromUrl,
  listInvites,
  mintInvite,
  redeemInvite,
  revokeInvite,
} from "./invites"

/**
 * Invite storage against the real engine and the real 0014 DDL. What is
 * pinned: the secret is never stored, an invite is claimed exactly once,
 * and a dead invite (expired, revoked, used) redeems nothing.
 */

const ADMIN = 42536816
const T0 = 1_700_000_000_000
const DAY = 24 * 60 * 60 * 1000

async function controlPlane() {
  const driver = createTestSqlDriver()
  await applyControlPlane(driver)
  return driver
}

describe("mintInvite", () => {
  it("stores a hash, never the token, and answers with the summary", async () => {
    const driver = await controlPlane()
    const minted = await mintInvite(driver, {
      createdBy: ADMIN,
      note: "for Ada",
      expiresInDays: 7,
      now: T0,
    })
    expect(minted.token).toMatch(/^rmn_inv_[A-Za-z0-9_-]{43}$/)
    expect(minted.summary).toEqual({
      id: expect.stringMatching(/^inv_/),
      note: "for Ada",
      createdAt: T0,
      expiresAt: T0 + 7 * DAY,
      redeemedAt: null,
      redeemedBy: null,
      revokedAt: null,
    })
    const rows = await driver.exec("SELECT token_hash, created_by FROM invites")
    expect(rows).toEqual([
      { token_hash: expect.stringMatching(/^[0-9a-f]{64}$/), created_by: ADMIN },
    ])
    expect(rows[0]?.token_hash).not.toContain(minted.token)
  })
})

describe("redeemInvite", () => {
  it("claims a live invite once, for the id that presented it", async () => {
    const driver = await controlPlane()
    const { token, summary } = await mintInvite(driver, {
      createdBy: ADMIN,
      note: null,
      expiresInDays: 7,
      now: T0,
    })
    expect(await redeemInvite(driver, token, 7, T0 + DAY)).toBe(true)
    expect(await redeemInvite(driver, token, 8, T0 + DAY)).toBe(false)
    const [listed] = await listInvites(driver)
    expect(listed).toMatchObject({ id: summary.id, redeemedAt: T0 + DAY, redeemedBy: { id: 7 } })
  })

  it("redeems nothing for an expired, revoked or unknown token", async () => {
    const driver = await controlPlane()
    const expired = await mintInvite(driver, {
      createdBy: ADMIN,
      note: null,
      expiresInDays: 1,
      now: T0,
    })
    const revoked = await mintInvite(driver, {
      createdBy: ADMIN,
      note: null,
      expiresInDays: 7,
      now: T0,
    })
    expect(await revokeInvite(driver, revoked.summary.id, T0 + 1)).toBe(true)
    expect(await redeemInvite(driver, expired.token, 7, T0 + DAY)).toBe(false)
    expect(await redeemInvite(driver, revoked.token, 7, T0 + 1)).toBe(false)
    expect(await redeemInvite(driver, "rmn_inv_" + "x".repeat(43), 7, T0)).toBe(false)
    expect(await redeemInvite(driver, "", 7, T0)).toBe(false)
    expect(await driver.exec("SELECT id FROM invites WHERE redeemed_at IS NOT NULL")).toEqual([])
  })

  it("expiry is exclusive at the boundary", async () => {
    const driver = await controlPlane()
    const { token } = await mintInvite(driver, {
      createdBy: ADMIN,
      note: null,
      expiresInDays: 1,
      now: T0,
    })
    expect(await redeemInvite(driver, token, 7, T0 + DAY)).toBe(false)
  })
})

describe("revokeInvite", () => {
  it("revokes a live invite and nothing else", async () => {
    const driver = await controlPlane()
    const { token, summary } = await mintInvite(driver, {
      createdBy: ADMIN,
      note: null,
      expiresInDays: 7,
      now: T0,
    })
    expect(await revokeInvite(driver, "inv_missing", T0)).toBe(false)
    expect(await revokeInvite(driver, summary.id, T0 + 1)).toBe(true)
    expect(await revokeInvite(driver, summary.id, T0 + 2)).toBe(false) // already dead
    expect(await redeemInvite(driver, token, 7, T0 + 3)).toBe(false)
  })

  it("cannot revoke a redeemed invite: the person is in", async () => {
    const driver = await controlPlane()
    const { token, summary } = await mintInvite(driver, {
      createdBy: ADMIN,
      note: null,
      expiresInDays: 7,
      now: T0,
    })
    await redeemInvite(driver, token, 7, T0 + 1)
    expect(await revokeInvite(driver, summary.id, T0 + 2)).toBe(false)
  })
})

describe("listInvites", () => {
  it("lists newest first with the redeemer's login where they have a row", async () => {
    const driver = await controlPlane()
    const first = await mintInvite(driver, {
      createdBy: ADMIN,
      note: "a",
      expiresInDays: 7,
      now: T0,
    })
    const second = await mintInvite(driver, {
      createdBy: ADMIN,
      note: "b",
      expiresInDays: 7,
      now: T0 + 1,
    })
    await redeemInvite(driver, first.token, 7, T0 + 2)
    await driver.exec(
      "INSERT INTO users (github_id, login, created_at, email) VALUES (7, 'ada', 1, 'ada@example.com')",
    )
    const listed = await listInvites(driver)
    expect(listed.map((invite) => invite.id)).toEqual([second.summary.id, first.summary.id])
    expect(listed[1]?.redeemedBy).toEqual({ id: 7, login: "ada" })
    expect(listed[0]?.redeemedBy).toBeNull()
  })
})

describe("inviteState", () => {
  const base = { redeemedAt: null, revokedAt: null, expiresAt: T0 + DAY }
  it("names the state, redeemed winning over the rest", () => {
    expect(inviteState(base, T0)).toBe("live")
    expect(inviteState(base, T0 + DAY)).toBe("expired")
    expect(inviteState({ ...base, revokedAt: T0 }, T0)).toBe("revoked")
    expect(inviteState({ ...base, redeemedAt: T0, revokedAt: T0 }, T0 + 2 * DAY)).toBe("redeemed")
  })
})

describe("inviteTokenFromUrl", () => {
  it("reads the token out of an invite page URL and nothing else", () => {
    const token = "rmn_inv_" + "a".repeat(43)
    expect(inviteTokenFromUrl(`https://ruminate.test/invite/${token}`)).toBe(token)
    expect(inviteTokenFromUrl(`https://ruminate.test/invite/${token}?invite=invalid`)).toBe(token)
    expect(inviteTokenFromUrl(`https://ruminate.test/invite/${token}/extra`)).toBe(token)
    expect(inviteTokenFromUrl(`https://ruminate.test/invite/${encodeURIComponent(token)}`)).toBe(
      token,
    )
    expect(inviteTokenFromUrl("https://ruminate.test/notes/abc")).toBeNull()
    expect(inviteTokenFromUrl("https://ruminate.test/invite/")).toBeNull()
    expect(inviteTokenFromUrl("https://ruminate.test/invite/rmn_mcp_notaninvite")).toBeNull()
    expect(inviteTokenFromUrl("not a url")).toBeNull()
    expect(inviteTokenFromUrl(null)).toBeNull()
  })
})
