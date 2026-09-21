import { describe, expect, it } from "vitest"
import {
  normalizeEmail,
  serializeSharePermissions,
  shareAllows,
  shareFromRow,
  type ShareRow,
} from "./grant"

const row: ShareRow = {
  id: "shr_1",
  owner_id: 7,
  grantee_email: "bob@example.com",
  view_id: "blk_a",
  permissions: "read,write",
  created_at: 1,
  revoked_at: null,
}

describe("shareFromRow", () => {
  it("reads the view and verbs off the row", () => {
    const grant = shareFromRow(row)
    expect(grant.viewId).toBe("blk_a")
    expect([...grant.permissions]).toEqual(["read", "write"])
    expect(shareAllows(grant, "write")).toBe(true)
    expect(shareAllows(grant, "delete")).toBe(false)
  })

  it("permits nothing once revoked", () => {
    const grant = shareFromRow({ ...row, revoked_at: 5 })
    expect(shareAllows(grant, "read")).toBe(false)
  })

  it("reads a row with no view as a share over nothing, never over everything", () => {
    expect(shareFromRow({ ...row, view_id: undefined as unknown as string }).viewId).toBe("")
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
