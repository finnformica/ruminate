import { describe, expect, it } from "vitest"
import {
  normalizeEmail,
  parseRootIds,
  serializeSharePermissions,
  shareFromRow,
  type ShareRow,
} from "./grant"

const row: ShareRow = {
  id: "shr_1",
  owner_id: 7,
  grantee_email: "bob@example.com",
  root_ids: '["blk_a","blk_b"]',
  permissions: "read",
  created_at: 1,
  revoked_at: null,
}

describe("shareFromRow", () => {
  it("reads the roots and verbs off the row", () => {
    const grant = shareFromRow(row)
    expect([...grant.rootIds]).toEqual(["blk_a", "blk_b"])
    expect([...grant.permissions]).toEqual(["read"])
    expect(grant.revokedAt).toBeNull()
    expect(shareFromRow({ ...row, revoked_at: 5 }).revokedAt).toBe(5)
  })

  it("reads a broken root list as NO notes, never every note", () => {
    expect(parseRootIds("{")).toEqual(new Set())
    expect(parseRootIds('"blk_a"')).toEqual(new Set())
    expect(parseRootIds('["blk_a", 3, ""]')).toEqual(new Set(["blk_a"]))
  })
})

describe("serializeSharePermissions", () => {
  it("forces read in and keeps the canonical order", () => {
    expect(serializeSharePermissions([])).toBe("read")
    expect(serializeSharePermissions(["delete", "write"])).toBe("read,write,delete")
  })
})

describe("normalizeEmail", () => {
  it("lowercases and trims an address", () => {
    expect(normalizeEmail("  Bob@Example.COM ")).toBe("bob@example.com")
  })

  it("refuses what is not an address", () => {
    for (const raw of ["", "bob", "bob@", "@x.com", "a b@x.com", 7, null, undefined]) {
      expect(normalizeEmail(raw)).toBeNull()
    }
    expect(normalizeEmail(`${"a".repeat(250)}@x.com`)).toBeNull()
  })
})
