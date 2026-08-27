import { describe, expect, it } from "vitest"
import { resolveDisplayName } from "./github-auth"

describe("resolveDisplayName", () => {
  it("uses the GitHub display name when present", () => {
    expect(resolveDisplayName("Ada Lovelace", "ada")).toBe("Ada Lovelace")
  })

  it("falls back to the login when name is null (never the literal 'null')", () => {
    expect(resolveDisplayName(null, "ada")).toBe("ada")
    expect(resolveDisplayName(undefined, "ada")).toBe("ada")
  })

  it("falls back to the login for empty, whitespace, or literal 'null' names", () => {
    expect(resolveDisplayName("", "ada")).toBe("ada")
    expect(resolveDisplayName("   ", "ada")).toBe("ada")
    expect(resolveDisplayName("null", "ada")).toBe("ada")
  })
})
