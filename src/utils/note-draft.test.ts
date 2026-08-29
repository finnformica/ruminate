// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  clearNoteDraft,
  getNoteDraft,
  getNoteDraftEntry,
  hashNoteContent,
  setNoteDraft,
} from "./note-draft"

const noteId = "test-note"

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
      noteId,
      value: "draft body",
      baseHash: hashNoteContent("base"),
      immediate: true,
    })

    expect(getNoteDraftEntry(noteId)).toEqual({
      value: "draft body",
      baseHash: hashNoteContent("base"),
    })
    expect(getNoteDraft(noteId)).toBe("draft body")
  })

  it("loads legacy bare-string drafts with unknown base", () => {
    window.localStorage.setItem("draft::test-note", "legacy draft body")

    expect(getNoteDraftEntry(noteId)).toEqual({ value: "legacy draft body", baseHash: null })
    expect(getNoteDraft(noteId)).toBe("legacy draft body")
  })

  it("treats note content that happens to be JSON (but not the envelope) as a legacy draft", () => {
    window.localStorage.setItem("draft::test-note", `{"v": 2, "note": "not a draft envelope"}`)

    expect(getNoteDraftEntry(noteId)).toEqual({
      value: `{"v": 2, "note": "not a draft envelope"}`,
      baseHash: null,
    })
  })

  it("preserves the existing provenance when baseHash is omitted (in-place draft edits)", () => {
    setNoteDraft({ noteId, value: "draft v1", baseHash: hashNoteContent("base"), immediate: true })
    // task.ts-style modification: rewrite the draft without knowing its base.
    setNoteDraft({ noteId, value: "draft v2", immediate: true })

    expect(getNoteDraftEntry(noteId)).toEqual({
      value: "draft v2",
      baseHash: hashNoteContent("base"),
    })
  })

  it("stores null provenance when explicitly unknown and clears cleanly", () => {
    setNoteDraft({ noteId, value: "draft body", baseHash: null, immediate: true })
    expect(getNoteDraftEntry(noteId)).toEqual({ value: "draft body", baseHash: null })

    clearNoteDraft(noteId)
    expect(getNoteDraftEntry(noteId)).toBeNull()
  })
})
