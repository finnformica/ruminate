// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Note } from "../schema"

// The hook only reads `githubRepoAtom` (to key drafts); the real atom drags in
// the whole global state machine, far too heavy for jsdom.
vi.mock("../global-state", async () => {
  const { atom } = await import("jotai")
  return { githubRepoAtom: atom(null) }
})

import { useEditorValue } from "./editor-value"

const note = (content: string) => ({ content }) as Note

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
})
