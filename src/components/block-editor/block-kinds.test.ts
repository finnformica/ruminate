import { describe, expect, it } from "vitest"
import { BLOCK_TYPE_DEFS } from "../../blocks/registry"
import { BLOCK_KINDS, KINDS_COVER_REGISTRY } from "./block-kinds"

describe("block kinds", () => {
  it("draws every type the registry defines, and nothing else", () => {
    expect(KINDS_COVER_REGISTRY).toBe(true)
    expect(Object.keys(BLOCK_KINDS).sort()).toEqual(BLOCK_TYPE_DEFS.map((def) => def.id).sort())
  })
})
