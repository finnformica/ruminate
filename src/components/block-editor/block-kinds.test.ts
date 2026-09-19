import { describe, expect, it } from "vitest"
import type { Block, BlockType } from "../../blocks/types"
import { BLOCK_TYPE_DEFS } from "../../blocks/registry"
import { BLOCK_KINDS, KINDS_COVER_REGISTRY, wearsPinAsKey, type RowContext } from "./block-kinds"

describe("block kinds", () => {
  it("draws every type the registry defines, and nothing else", () => {
    expect(KINDS_COVER_REGISTRY).toBe(true)
    expect(Object.keys(BLOCK_KINDS).sort()).toEqual(BLOCK_TYPE_DEFS.map((def) => def.id).sort())
  })
})

/** A row of `type`, pinned or not, as a listed root or nested in a note. */
const rowOf = (type: BlockType, { pinned = false, listed = false, depth = 0 } = {}): RowContext =>
  ({
    block: {
      id: "blk_x",
      type,
      text: "",
      children: [],
      ...(pinned ? { props: { pinned: true } } : {}),
    } as Block,
    api: { fixedRoots: listed },
    depth,
  }) as RowContext

describe("the pin as a row's key", () => {
  it("is worn by a pinned note wherever it is drawn", () => {
    expect(wearsPinAsKey(rowOf("note", { pinned: true, listed: true }))).toBe(true)
    expect(wearsPinAsKey(rowOf("note", { pinned: true, listed: false, depth: 2 }))).toBe(true)
  })

  it("is not worn by a note that is not pinned", () => {
    expect(wearsPinAsKey(rowOf("note", { listed: true }))).toBe(false)
  })

  it("is worn by a pinned block listed as a row of its own", () => {
    expect(wearsPinAsKey(rowOf("text", { pinned: true, listed: true }))).toBe(true)
  })

  it("is not worn by a pinned block inside a note — there the pin trails", () => {
    expect(wearsPinAsKey(rowOf("text", { pinned: true, listed: false }))).toBe(false)
    // Nor by one nested beneath a listed root.
    expect(wearsPinAsKey(rowOf("text", { pinned: true, listed: true, depth: 1 }))).toBe(false)
  })

  it("never displaces a key that already means something", () => {
    for (const type of ["todo", "ul", "ol", "h1"] as BlockType[]) {
      expect(wearsPinAsKey(rowOf(type, { pinned: true, listed: true }))).toBe(false)
    }
  })
})
