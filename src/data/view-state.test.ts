import { describe, expect, it } from "vitest"
import { viewStatePath } from "./paths"
import {
  buildViewStateWrite,
  parseNoteViewState,
  readNoteViewState,
  serializeNoteViewState,
} from "./view-state-parse"

describe("parseNoteViewState (per-note file)", () => {
  it("returns empty for missing content", () => {
    expect(parseNoteViewState(undefined)).toEqual([])
    expect(parseNoteViewState("")).toEqual([])
  })

  it("parses a well-formed file", () => {
    expect(parseNoteViewState(JSON.stringify(["blk_a", "blk_b"]))).toEqual(["blk_a", "blk_b"])
  })

  it("degrades to empty on malformed JSON", () => {
    expect(parseNoteViewState("[ not json")).toEqual([])
  })

  it("ignores non-array top levels and non-string entries", () => {
    expect(parseNoteViewState(JSON.stringify({ a: 1 }))).toEqual([])
    expect(parseNoteViewState("42")).toEqual([])
    expect(parseNoteViewState(JSON.stringify(["blk_a", 5, null, "blk_b"]))).toEqual([
      "blk_a",
      "blk_b",
    ])
  })
})

describe("serializeNoteViewState", () => {
  it("sorts and de-duplicates so the same set always produces the same bytes", () => {
    expect(serializeNoteViewState(["blk_b", "blk_a", "blk_b"])).toEqual(
      serializeNoteViewState(["blk_a", "blk_b"]),
    )
  })

  it("round-trips through parseNoteViewState", () => {
    expect(parseNoteViewState(serializeNoteViewState(["blk_b", "blk_a"]))).toEqual([
      "blk_a",
      "blk_b",
    ])
  })
})

describe("readNoteViewState", () => {
  it("reads the per-note file", () => {
    const files = { [viewStatePath("foo")]: JSON.stringify(["blk_a"]) }
    expect(readNoteViewState(files, "foo")).toEqual(["blk_a"])
  })

  it("returns empty for no note id or no files", () => {
    expect(readNoteViewState({}, "foo")).toEqual([])
    expect(readNoteViewState({}, undefined)).toEqual([])
  })
})

describe("buildViewStateWrite", () => {
  it("writes only the current note's file", () => {
    const updates = buildViewStateWrite({}, "foo", ["blk_a"])
    expect(updates).toEqual({ [viewStatePath("foo")]: serializeNoteViewState(["blk_a"]) })
  })

  it("supports note ids with directories", () => {
    const updates = buildViewStateWrite({}, "work/projects", ["blk_a"])
    expect(updates).toEqual({
      ".ruminate/view-state/work/projects.json": serializeNoteViewState(["blk_a"]),
    })
  })

  it("skips the write entirely when the serialized content is unchanged", () => {
    const files = { [viewStatePath("foo")]: serializeNoteViewState(["blk_a", "blk_b"]) }
    // Same set in a different order (fold-then-unfold) is still unchanged.
    expect(buildViewStateWrite(files, "foo", ["blk_b", "blk_a"])).toBeNull()
  })

  it("skips the write when the set is empty and no file exists", () => {
    expect(buildViewStateWrite({}, "foo", [])).toBeNull()
  })

  it("deletes the per-note file when the set becomes empty", () => {
    const files = { [viewStatePath("foo")]: serializeNoteViewState(["blk_a"]) }
    expect(buildViewStateWrite(files, "foo", [])).toEqual({ [viewStatePath("foo")]: null })
  })
})
