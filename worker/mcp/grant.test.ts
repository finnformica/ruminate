import { describe, expect, it } from "vitest"
import {
  allows,
  coversNote,
  describeGrant,
  grantFromRow,
  mayCreateNotes,
  parseNoteIds,
  parsePermissions,
  serializePermissions,
  type Grant,
  type McpTokenRow,
} from "./grant"

/**
 * The permission boundary, adversarially.
 *
 * Every case here is a way a grant could accidentally be WIDER than the user
 * asked for — a malformed column read as "everything", an expired row that
 * still works, a scoped grant that can reach outside its notes. A grant that
 * is too narrow is a bug report; a grant that is too wide is the thing this
 * whole feature exists to prevent, so those are the tests.
 */

const row = (overrides: Partial<McpTokenRow> = {}): McpTokenRow => ({
  id: "mcp_test",
  user_id: 42,
  name: "Test token",
  permissions: "read",
  note_ids: null,
  expires_at: null,
  revoked_at: null,
  ...overrides,
})

const grantOf = (overrides: Partial<McpTokenRow> = {}, now = 1000): Grant => {
  const decision = grantFromRow(row(overrides), now)
  if (!decision.ok) throw new Error(`expected a grant, got ${decision.refusal}`)
  return decision.grant
}

describe("parsePermissions", () => {
  it("reads the three verbs", () => {
    expect([...parsePermissions("read,write,delete")]).toEqual(["read", "write", "delete"])
  })

  it("yields NOTHING for an empty or malformed column", () => {
    for (const stored of ["", "   ", ",,,", "admin", "*", "all"]) {
      expect([...parsePermissions(stored)]).toEqual([])
    }
  })

  it("keeps the verbs it knows and drops the ones it does not", () => {
    // A token minted by a newer build must not fail shut on the user.
    expect([...parsePermissions("read,teleport,delete")].sort()).toEqual(["delete", "read"])
  })

  it("round-trips through serialize in a stable order", () => {
    expect(serializePermissions(["delete", "read"])).toBe("read,delete")
    expect(serializePermissions(["write", "write", "read"])).toBe("read,write")
  })
})

describe("parseNoteIds", () => {
  it("reads NULL as every note", () => {
    expect(parseNoteIds(null)).toBeNull()
  })

  it("reads a JSON array as exactly those notes", () => {
    expect(parseNoteIds('["a","b"]')).toEqual(new Set(["a", "b"]))
  })

  it("reads anything MALFORMED as NO notes, never as every note", () => {
    // The direction of this failure is the whole point: a column we cannot
    // parse must not widen into unrestricted access.
    for (const stored of ["not json", "{}", '"a"', "null", "[]", "123", "[1,2]"]) {
      const parsed = parseNoteIds(stored)
      expect(parsed).not.toBeNull()
      expect(parsed?.size).toBe(0)
    }
  })

  it("keeps the string entries of a mixed array and drops the rest", () => {
    expect(parseNoteIds('["a",1,null,"b",""]')).toEqual(new Set(["a", "b"]))
  })
})

describe("grantFromRow — refusals", () => {
  it("refuses a revoked token", () => {
    expect(grantFromRow(row({ revoked_at: 500 }), 1000)).toEqual({ ok: false, refusal: "revoked" })
  })

  it("refuses an expired token, and at the exact moment it expires", () => {
    expect(grantFromRow(row({ expires_at: 999 }), 1000)).toEqual({ ok: false, refusal: "expired" })
    expect(grantFromRow(row({ expires_at: 1000 }), 1000)).toEqual({ ok: false, refusal: "expired" })
    expect(grantFromRow(row({ expires_at: 1001 }), 1000).ok).toBe(true)
  })

  it("refuses a row whose user id is not a safe integer", () => {
    expect(grantFromRow(row({ user_id: 1.5 }), 1000).ok).toBe(false)
    expect(grantFromRow(row({ user_id: Number.MAX_VALUE }), 1000).ok).toBe(false)
  })

  it("checks revocation before expiry, so a revoked token never reads as merely stale", () => {
    expect(grantFromRow(row({ revoked_at: 1, expires_at: 1 }), 1000)).toEqual({
      ok: false,
      refusal: "revoked",
    })
  })
})

describe("allows", () => {
  it("permits only the verbs the grant names", () => {
    const grant = grantOf({ permissions: "read,write" })
    expect(allows(grant, "read")).toBe(true)
    expect(allows(grant, "write")).toBe(true)
    expect(allows(grant, "delete")).toBe(false)
  })

  it("permits nothing at all when the column is empty", () => {
    const grant = grantOf({ permissions: "" })
    expect(allows(grant, "read")).toBe(false)
    expect(allows(grant, "write")).toBe(false)
    expect(allows(grant, "delete")).toBe(false)
  })
})

describe("coversNote", () => {
  it("covers every note when the grant names none", () => {
    const grant = grantOf({ note_ids: null })
    expect(coversNote(grant, "anything")).toBe(true)
    expect(coversNote(grant, "blk_zzz")).toBe(true)
  })

  it("covers only the notes it names", () => {
    const grant = grantOf({ note_ids: '["blk_a","blk_b"]' })
    expect(coversNote(grant, "blk_a")).toBe(true)
    expect(coversNote(grant, "blk_b")).toBe(true)
    expect(coversNote(grant, "blk_c")).toBe(false)
  })

  it("covers NOTHING when the stored scope was malformed", () => {
    const grant = grantOf({ note_ids: "corrupted" })
    expect(coversNote(grant, "blk_a")).toBe(false)
  })
})

describe("mayCreateNotes", () => {
  it("needs write AND an unrestricted scope", () => {
    expect(mayCreateNotes(grantOf({ permissions: "read,write", note_ids: null }))).toBe(true)
    expect(mayCreateNotes(grantOf({ permissions: "read", note_ids: null }))).toBe(false)
    expect(mayCreateNotes(grantOf({ permissions: "read,write", note_ids: '["blk_a"]' }))).toBe(
      false,
    )
  })

  it("refuses a note-scoped grant even though it may write its own notes", () => {
    // The widening this prevents: a grant over one note must not be able to
    // manufacture a corpus of notes it also controls.
    const grant = grantOf({ permissions: "read,write,delete", note_ids: '["blk_a"]' })
    expect(allows(grant, "write")).toBe(true)
    expect(mayCreateNotes(grant)).toBe(false)
  })
})

describe("describeGrant", () => {
  it("names the verbs and the size of the scope, and no secret", () => {
    expect(describeGrant(grantOf({ permissions: "read", note_ids: null }))).toBe(
      "read access to every note",
    )
    expect(describeGrant(grantOf({ permissions: "read,write", note_ids: '["a"]' }))).toBe(
      "read+write access to 1 note",
    )
    expect(describeGrant(grantOf({ permissions: "", note_ids: '["a","b"]' }))).toBe(
      "no access to 2 notes",
    )
  })
})
