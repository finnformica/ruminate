// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Note } from "../schema"

import { hashNoteContent } from "../utils/note-draft"
import { useEditorValue } from "./editor-value"

const note = (content: string) => ({ content }) as Note

/** Write a provenance-carrying draft the way `setNoteDraft` persists it. */
const writeDraft = (value: string, baseHash: string | null) =>
  window.localStorage.setItem("draft::test-note", JSON.stringify({ v: 1, value, baseHash }))

function renderEditorValue(initialNote: Note | undefined) {
  return renderHook(
    ({ note }: { note: Note | undefined }) =>
      useEditorValue({ noteId: "test-note", note, defaultValue: "" }),
    { initialProps: { note: initialNote } },
  )
}

beforeEach(() => window.localStorage.clear())
afterEach(() => {
  cleanup()
  window.localStorage.clear()
})

describe("useEditorValue (pull → editor propagation)", () => {
  it("re-seeds the editor when the note changes externally and there are no unsaved edits", () => {
    const { result, rerender } = renderEditorValue(note("original content"))
    expect(result.current.editorValue).toBe("original content")

    // A pull updates the open note's content.
    rerender({ note: note("pulled content") })

    expect(result.current.editorValue).toBe("pulled content")
    expect(result.current.remoteNotice).toBe(false)
    expect(result.current.isDraft).toBe(false)
  })

  it("preserves unsaved edits and raises the remote notice instead", () => {
    const { result, rerender } = renderEditorValue(note("original content"))

    // The user types (a draft — even before the debounced draft write lands).
    act(() => result.current.setEditorValue("local unsaved edits"))
    expect(result.current.isDraft).toBe(true)

    // A pull updates the note underneath the editor.
    rerender({ note: note("pulled content") })

    expect(result.current.editorValue).toBe("local unsaved edits")
    expect(result.current.remoteNotice).toBe(true)

    // "Show latest" is the explicit choice to load the remote version.
    act(() => result.current.loadRemoteVersion())
    expect(result.current.editorValue).toBe("pulled content")
    expect(result.current.remoteNotice).toBe(false)
  })

  it("lets the user dismiss the notice and keep editing", () => {
    const { result, rerender } = renderEditorValue(note("original content"))
    act(() => result.current.setEditorValue("local unsaved edits"))
    rerender({ note: note("pulled content") })
    expect(result.current.remoteNotice).toBe(true)

    act(() => result.current.dismissRemoteNotice())
    expect(result.current.remoteNotice).toBe(false)
    expect(result.current.editorValue).toBe("local unsaved edits")
  })

  it("does not raise the notice when the external change is the user's own save landing", () => {
    const { result, rerender } = renderEditorValue(note("original content"))
    act(() => result.current.setEditorValue("saved content"))

    // The save round-trips through the machine: note.content catches up.
    rerender({ note: note("saved content") })

    expect(result.current.editorValue).toBe("saved content")
    expect(result.current.remoteNotice).toBe(false)
    expect(result.current.isDraft).toBe(false)
  })

  it("adopts a save that only stamped updated_at, without raising the notice", () => {
    // useSaveNote writes the note with a fresh `updated_at` frontmatter, so
    // the round-tripped content is byte-different from the editor value by an
    // invisible timestamp. That must read as the user's own save, not as a
    // remote edit ("This note was updated on another device" on every ⌘S).
    const { result, rerender } = renderEditorValue(note("original content"))
    act(() => result.current.setEditorValue("edited content"))

    const stamped = "---\nupdated_at: 2026-08-28T09:00:00.000Z\n---\n\nedited content"
    rerender({ note: note(stamped) })

    expect(result.current.remoteNotice).toBe(false)
    expect(result.current.editorValue).toBe(stamped)
    expect(result.current.isDraft).toBe(false)
  })

  it("clears a stale no-op draft and re-seeds on pull instead of raising a phantom notice", () => {
    // A leftover localStorage draft that is byte-identical to the note carries
    // no real edits (nothing was ever changed) — a pull must adopt the new
    // content silently, not cry "updated on another device".
    window.localStorage.setItem("draft::test-note", "original content")
    const { result, rerender } = renderEditorValue(note("original content"))
    expect(result.current.editorValue).toBe("original content")

    rerender({ note: note("pulled content") })

    expect(result.current.editorValue).toBe("pulled content")
    expect(result.current.remoteNotice).toBe(false)
    expect(window.localStorage.getItem("draft::test-note")).toBeNull()
  })

  it("still raises the notice for a draft with real edits, even when the editor value is clean", () => {
    const { result, rerender } = renderEditorValue(note("original content"))
    // A draft with REAL edits exists (e.g. written by this note's editor in
    // another tab) while this editor's value still matches the note.
    window.localStorage.setItem("draft::test-note", "real draft edits")

    rerender({ note: note("pulled content") })

    expect(result.current.remoteNotice).toBe(true)
    expect(result.current.editorValue).toBe("original content")
    expect(window.localStorage.getItem("draft::test-note")).toBe("real draft edits")
  })

  it("still raises the notice for a real remote edit that also differs in updated_at", () => {
    const { result, rerender } = renderEditorValue(note("original content"))
    act(() => result.current.setEditorValue("my local edit"))

    rerender({
      note: note("---\nupdated_at: 2026-08-28T09:00:00.000Z\n---\n\nsomeone else's edit"),
    })

    expect(result.current.remoteNotice).toBe(true)
    expect(result.current.editorValue).toBe("my local edit")
  })
})

describe("useEditorValue (draft provenance)", () => {
  it("records the note content a draft was based on when persisting it", () => {
    vi.useFakeTimers()
    try {
      const { result } = renderEditorValue(note("original content"))
      act(() => result.current.setEditorValue("edited content"))
      act(() => vi.advanceTimersByTime(600)) // flush the debounced draft write

      const raw = window.localStorage.getItem("draft::test-note")
      expect(raw).not.toBeNull()
      expect(JSON.parse(raw as string)).toEqual({
        v: 1,
        value: "edited content",
        baseHash: hashNoteContent("original content"),
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it("raises the notice at mount when the note advanced beneath a draft with real edits", () => {
    // Device B's scenario: a draft with real edits based on version 1 sleeps
    // in localStorage; the repo has since pulled version 2. The draft stays
    // visible, but the notice is up immediately — no further pull needed —
    // and a plain save is blocked.
    writeDraft("version 1 plus my edits", hashNoteContent("version 1"))

    const { result } = renderEditorValue(note("version 2"))

    expect(result.current.editorValue).toBe("version 1 plus my edits")
    expect(result.current.remoteNotice).toBe(true)
    expect(result.current.canSaveSilently).toBe(false)
    expect(window.localStorage.getItem("draft::test-note")).not.toBeNull()
  })

  it("silently drops a provenly no-op draft of an older version and shows the newer note", () => {
    // The silent-revert incident: the draft is an unmodified copy of version 1
    // (no real edits) and the note has advanced to version 2. Seeding from it
    // would show — and on save, commit — stale content.
    writeDraft("version 1", hashNoteContent("version 1"))

    const { result } = renderEditorValue(note("version 2"))

    expect(result.current.editorValue).toBe("version 2")
    expect(result.current.remoteNotice).toBe(false)
    expect(result.current.canSaveSilently).toBe(true)
    expect(window.localStorage.getItem("draft::test-note")).toBeNull()
  })

  it("stays silent at mount for an ordinary draft whose base matches the current note", () => {
    writeDraft("original content plus edits", hashNoteContent("original content"))

    const { result } = renderEditorValue(note("original content"))

    expect(result.current.editorValue).toBe("original content plus edits")
    expect(result.current.remoteNotice).toBe(false)
    expect(result.current.canSaveSilently).toBe(true)
  })

  it("loads a legacy bare-string draft silently (unknown base)", () => {
    window.localStorage.setItem("draft::test-note", "legacy draft edits")

    const { result } = renderEditorValue(note("newer content"))

    expect(result.current.editorValue).toBe("legacy draft edits")
    expect(result.current.remoteNotice).toBe(false)
  })
})

describe("useEditorValue (save guard contract)", () => {
  it("allows silent saves normally and blocks them while the notice is up", () => {
    const { result, rerender } = renderEditorValue(note("original content"))
    expect(result.current.canSaveSilently).toBe(true)

    act(() => result.current.setEditorValue("my local edit"))
    expect(result.current.canSaveSilently).toBe(true)

    // A pull lands a newer version beneath the edits.
    rerender({ note: note("pulled content") })
    expect(result.current.remoteNotice).toBe(true)
    expect(result.current.canSaveSilently).toBe(false)
  })

  it("re-enables saves after the user explicitly dismisses the notice", () => {
    const { result, rerender } = renderEditorValue(note("original content"))
    act(() => result.current.setEditorValue("my local edit"))
    rerender({ note: note("pulled content") })
    expect(result.current.canSaveSilently).toBe(false)

    act(() => result.current.dismissRemoteNotice())
    expect(result.current.canSaveSilently).toBe(true)
    expect(result.current.editorValue).toBe("my local edit")
  })

  it("re-enables saves when the override's save lands (timestamp-only difference)", () => {
    writeDraft("version 1 plus my edits", hashNoteContent("version 1"))
    const { result, rerender } = renderEditorValue(note("version 2"))
    expect(result.current.canSaveSilently).toBe(false)

    // "Save mine anyway" commits the editor value; useSaveNote stamps
    // updated_at and the note round-trips.
    rerender({
      note: note("---\nupdated_at: 2026-08-28T09:00:00.000Z\n---\n\nversion 1 plus my edits"),
    })

    expect(result.current.remoteNotice).toBe(false)
    expect(result.current.canSaveSilently).toBe(true)
  })
})
