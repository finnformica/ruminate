// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  clearNoteDraft,
  getNoteDraft,
  getNoteDraftEntry,
  hashNoteContent,
  setNoteDraft,
} from "./note-draft"

const key = { githubRepo: null, noteId: "test-note" }

beforeEach(() => window.localStorage.clear())
afterEach(() => window.localStorage.clear())

describe("hashNoteContent", () => {
  it("is deterministic and content-sensitive", () => {
    expect(hashNoteContent("hello")).toBe(hashNoteContent("hello"))
    expect(hashNoteContent("hello")).not.toBe(hashNoteContent("hello!"))
    expect(hashNoteContent("")).toBe(hashNoteContent(""))
  })
})

describe("draft provenance storage", () => {
  it("round-trips value and baseHash through the JSON envelope", () => {
    setNoteDraft({
      ...key,
      value: "draft body",
      baseHash: hashNoteContent("base"),
      immediate: true,
    })

    expect(getNoteDraftEntry(key)).toEqual({
      value: "draft body",
      baseHash: hashNoteContent("base"),
    })
    expect(getNoteDraft(key)).toBe("draft body")
  })

  it("loads legacy bare-string drafts with unknown base", () => {
    window.localStorage.setItem("draft::test-note", "legacy draft body")

    expect(getNoteDraftEntry(key)).toEqual({ value: "legacy draft body", baseHash: null })
    expect(getNoteDraft(key)).toBe("legacy draft body")
  })

  it("treats note content that happens to be JSON (but not the envelope) as a legacy draft", () => {
    window.localStorage.setItem("draft::test-note", `{"v": 2, "note": "not a draft envelope"}`)

    expect(getNoteDraftEntry(key)).toEqual({
      value: `{"v": 2, "note": "not a draft envelope"}`,
      baseHash: null,
    })
  })

  it("preserves the existing provenance when baseHash is omitted (in-place draft edits)", () => {
    setNoteDraft({ ...key, value: "draft v1", baseHash: hashNoteContent("base"), immediate: true })
    // task.ts-style modification: rewrite the draft without knowing its base.
    setNoteDraft({ ...key, value: "draft v2", immediate: true })

    expect(getNoteDraftEntry(key)).toEqual({
      value: "draft v2",
      baseHash: hashNoteContent("base"),
    })
  })

  it("stores null provenance when explicitly unknown and clears cleanly", () => {
    setNoteDraft({ ...key, value: "draft body", baseHash: null, immediate: true })
    expect(getNoteDraftEntry(key)).toEqual({ value: "draft body", baseHash: null })

    clearNoteDraft(key)
    expect(getNoteDraftEntry(key)).toBeNull()
  })
})
