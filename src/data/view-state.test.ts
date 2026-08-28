import { describe, expect, it } from "vitest"
import { LEGACY_VIEW_STATE_PATH, viewStatePath } from "./paths"
import {
  buildViewStateWrite,
  parseNoteViewState,
  parseViewState,
  readNoteViewState,
  serializeNoteViewState,
} from "./view-state-parse"

describe("parseViewState (legacy single-file sidecar)", () => {
  it("returns empty for missing content", () => {
    expect(parseViewState(undefined)).toEqual({})
    expect(parseViewState("")).toEqual({})
  })

  it("parses a well-formed sidecar", () => {
    const raw = JSON.stringify({ "work/projects": ["blk_a", "blk_b"], personal: ["blk_c"] })
    expect(parseViewState(raw)).toEqual({
      "work/projects": ["blk_a", "blk_b"],
      personal: ["blk_c"],
    })
  })

  it("degrades to empty on malformed JSON", () => {
    expect(parseViewState("{ not json")).toEqual({})
  })

  it("ignores non-object and array top levels", () => {
    expect(parseViewState("42")).toEqual({})
    expect(parseViewState("null")).toEqual({})
    expect(parseViewState(JSON.stringify(["a", "b"]))).toEqual({})
  })

  it("drops entries whose value is not a string array and non-string ids", () => {
    const raw = JSON.stringify({ a: "not-an-array", b: 3, c: ["blk_x", 5, null, "blk_y"] })
    expect(parseViewState(raw)).toEqual({ c: ["blk_x", "blk_y"] })
  })
})

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

  it("falls back to the legacy sidecar for un-migrated notes", () => {
    const files = { [LEGACY_VIEW_STATE_PATH]: JSON.stringify({ foo: ["blk_a"] }) }
    expect(readNoteViewState(files, "foo")).toEqual(["blk_a"])
    expect(readNoteViewState(files, "bar")).toEqual([])
  })

  it("prefers the per-note file over the legacy sidecar", () => {
    const files = {
      [LEGACY_VIEW_STATE_PATH]: JSON.stringify({ foo: ["blk_old"] }),
      [viewStatePath("foo")]: JSON.stringify(["blk_new"]),
    }
    expect(readNoteViewState(files, "foo")).toEqual(["blk_new"])
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

  it("migrates the legacy sidecar in the same write and deletes it", () => {
    const files = {
      [LEGACY_VIEW_STATE_PATH]: JSON.stringify({
        foo: ["blk_stale"],
        bar: ["blk_b"],
        "work/projects": ["blk_c"],
        empty: [],
      }),
    }
    const updates = buildViewStateWrite(files, "foo", ["blk_a"])
    expect(updates).toEqual({
      // Current note comes from live state, not the stale legacy entry.
      [viewStatePath("foo")]: serializeNoteViewState(["blk_a"]),
      [viewStatePath("bar")]: serializeNoteViewState(["blk_b"]),
      [viewStatePath("work/projects")]: serializeNoteViewState(["blk_c"]),
      [LEGACY_VIEW_STATE_PATH]: null,
    })
  })

  it("does not overwrite already-migrated per-note files during migration", () => {
    const files = {
      [LEGACY_VIEW_STATE_PATH]: JSON.stringify({ bar: ["blk_old"] }),
      [viewStatePath("bar")]: serializeNoteViewState(["blk_new"]),
    }
    const updates = buildViewStateWrite(files, "foo", ["blk_a"])
    expect(updates).toEqual({
      [viewStatePath("foo")]: serializeNoteViewState(["blk_a"]),
      [LEGACY_VIEW_STATE_PATH]: null,
    })
  })

  it("runs the migration only once: after the first write the legacy file is gone", () => {
    const files = {
      [LEGACY_VIEW_STATE_PATH]: JSON.stringify({ bar: ["blk_b"] }),
    }
    const first = buildViewStateWrite(files, "foo", ["blk_a"])
    expect(first).not.toBeNull()

    // Apply the first write to the file map.
    const after: Record<string, string> = { ...files }
    for (const [path, content] of Object.entries(first!)) {
      if (content === null) delete after[path]
      else after[path] = content
    }

    // The same state again: nothing left to write, no second migration.
    expect(buildViewStateWrite(after, "foo", ["blk_a"])).toBeNull()
  })

  it("still writes the migration even when the note's own state is unchanged", () => {
    const files = {
      [LEGACY_VIEW_STATE_PATH]: JSON.stringify({ bar: ["blk_b"] }),
      [viewStatePath("foo")]: serializeNoteViewState(["blk_a"]),
    }
    const updates = buildViewStateWrite(files, "foo", ["blk_a"])
    expect(updates).toEqual({
      [viewStatePath("bar")]: serializeNoteViewState(["blk_b"]),
      [LEGACY_VIEW_STATE_PATH]: null,
    })
  })

  it("degrades a malformed legacy sidecar to a plain delete", () => {
    const files = { [LEGACY_VIEW_STATE_PATH]: "{ not json" }
    expect(buildViewStateWrite(files, "foo", [])).toEqual({ [LEGACY_VIEW_STATE_PATH]: null })
  })
})
