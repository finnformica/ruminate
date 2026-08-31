// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Note } from "../schema"

import { AUTOSAVE_DEBOUNCE_MS, useEditorValue } from "./editor-value"

const note = (content: string) => ({ content }) as Note

function renderEditorValue(
  initialNote: Note | undefined,
  { defaultValue = "" }: { defaultValue?: string } = {},
) {
  const onSave = vi.fn()
  const hook = renderHook(
    ({ note }: { note: Note | undefined }) => useEditorValue({ note, defaultValue, onSave }),
    { initialProps: { note: initialNote } },
  )
  return { ...hook, onSave }
}

/** Simulate the user's own save landing: `useSaveNote` stamps `updated_at`. */
const stamp = (content: string) => `---\nupdated_at: 2026-08-28T09:00:00.000Z\n---\n${content}`

/** Fire `visibilitychange` with `document.visibilityState === "hidden"`. */
function hidePage() {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => "hidden",
  })
  try {
    document.dispatchEvent(new Event("visibilitychange"))
  } finally {
    delete (document as { visibilityState?: unknown }).visibilityState
  }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe("useEditorValue (seeding)", () => {
  it("seeds from the note content", () => {
    const { result } = renderEditorValue(note("original content"))
    expect(result.current.editorValue).toBe("original content")
  })

  it("seeds a new note from the default value (template)", () => {
    const { result } = renderEditorValue(undefined, { defaultValue: "# Template\n" })
    expect(result.current.editorValue).toBe("# Template\n")
  })

  it("shows a note that arrives after mount (cold load: store still opening)", () => {
    // The refresh case: the store is opening, so the note is undefined for a
    // beat and the editor seeds empty. When the note lands it must replace
    // that placeholder — comparing the seeded value against the previous
    // (undefined) note content read as "the user has edits", leaving a blank
    // editor over real content.
    const { result, rerender } = renderEditorValue(undefined)
    expect(result.current.editorValue).toBe("")
    rerender({ note: note("- pulled from the store\n") })
    expect(result.current.editorValue).toBe("- pulled from the store\n")
  })

  it("a template stays put when the note arrives empty-handed, then adopts it", () => {
    const { result, rerender } = renderEditorValue(undefined, { defaultValue: "# Template\n" })
    expect(result.current.editorValue).toBe("# Template\n")
    rerender({ note: note("- real content\n") })
    expect(result.current.editorValue).toBe("- real content\n")
  })

  it("does NOT clobber typing that happened before the note arrived", () => {
    // The genuine new-note flow: the user types into a note that does not
    // exist yet. Their work must survive the note landing.
    const { result, rerender } = renderEditorValue(undefined)
    act(() => result.current.setEditorValue("- my new thought\n"))
    rerender({ note: note("- something else entirely\n") })
    expect(result.current.editorValue).toBe("- my new thought\n")
  })
})

describe("useEditorValue (autosave)", () => {
  it("saves a change after the debounce, not immediately", () => {
    const { result, onSave } = renderEditorValue(note("original content"))

    act(() => result.current.setEditorValue("edited content"))
    expect(onSave).not.toHaveBeenCalled()

    act(() => vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS))
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave).toHaveBeenCalledWith("edited content")
  })

  it("coalesces rapid edits into one save of the latest value", () => {
    const { result, onSave } = renderEditorValue(note("original content"))

    act(() => result.current.setEditorValue("edit 1"))
    act(() => vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS - 100))
    act(() => result.current.setEditorValue("edit 2"))
    act(() => vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS - 100))
    expect(onSave).not.toHaveBeenCalled()

    act(() => vi.advanceTimersByTime(100))
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave).toHaveBeenCalledWith("edit 2")
  })

  it("flushNow saves immediately (⌘S) and a second flush is a no-op", () => {
    const { result, onSave } = renderEditorValue(note("original content"))

    act(() => result.current.setEditorValue("edited content"))
    act(() => result.current.flushNow())
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave).toHaveBeenCalledWith("edited content")

    // Nothing left pending: neither a repeat flush nor the old timer saves again.
    act(() => result.current.flushNow())
    act(() => vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS))
    expect(onSave).toHaveBeenCalledTimes(1)
  })

  it("flushes when the page hides (visibilitychange → hidden)", () => {
    const { result, onSave } = renderEditorValue(note("original content"))
    act(() => result.current.setEditorValue("edited content"))

    act(() => hidePage())

    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave).toHaveBeenCalledWith("edited content")
  })

  it("flushes on pagehide", () => {
    const { result, onSave } = renderEditorValue(note("original content"))
    act(() => result.current.setEditorValue("edited content"))

    act(() => {
      window.dispatchEvent(new Event("pagehide"))
    })

    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave).toHaveBeenCalledWith("edited content")
  })

  it("flushes on unmount (note switch, navigation)", () => {
    const { result, unmount, onSave } = renderEditorValue(note("original content"))
    act(() => result.current.setEditorValue("edited content"))

    unmount()

    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave).toHaveBeenCalledWith("edited content")
  })

  it("never saves when nothing was edited", () => {
    const { unmount, onSave } = renderEditorValue(note("original content"))

    act(() => hidePage())
    act(() => vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS * 5))
    unmount()

    expect(onSave).not.toHaveBeenCalled()
  })

  it("does not save an unedited template (visiting a daily note creates nothing)", () => {
    const { unmount, onSave } = renderEditorValue(undefined, { defaultValue: "# Template\n" })

    act(() => vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS * 5))
    unmount()

    expect(onSave).not.toHaveBeenCalled()
  })
})

describe("useEditorValue (external changes)", () => {
  it("re-seeds the editor when the note changes externally and the editor is idle", () => {
    const { result, rerender } = renderEditorValue(note("original content"))

    // A pull updates the open note's content.
    rerender({ note: note("pulled content") })

    expect(result.current.editorValue).toBe("pulled content")
  })

  it("keeps the local value when an external change lands mid-edit, and the next flush settles it", () => {
    const { result, rerender, onSave } = renderEditorValue(note("original content"))

    act(() => result.current.setEditorValue("local unflushed edits"))
    rerender({ note: note("pulled content") })

    // Local typing wins over the pull (per-row last-writer-wins)...
    expect(result.current.editorValue).toBe("local unflushed edits")

    // ...and the pending autosave commits it.
    act(() => vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS))
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave).toHaveBeenCalledWith("local unflushed edits")
  })

  it("adopts the save round-trip (stamped updated_at) without saving again", () => {
    const { result, rerender, onSave } = renderEditorValue(note("original content"))

    act(() => result.current.setEditorValue("edited content"))
    act(() => vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS))
    expect(onSave).toHaveBeenCalledTimes(1)

    // The save lands in the store with a stamped timestamp; the editor adopts
    // the canonical bytes (no local edits are newer than the flush).
    rerender({ note: note(stamp("edited content")) })
    expect(result.current.editorValue).toBe(stamp("edited content"))

    // Adoption must not trigger another save — no autosave feedback loop.
    act(() => vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS * 5))
    expect(onSave).toHaveBeenCalledTimes(1)
  })

  it("keeps edits typed after a flush when that flush's round-trip lands", () => {
    const { result, rerender, onSave } = renderEditorValue(note("original content"))

    act(() => result.current.setEditorValue("edited content"))
    act(() => vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS))
    expect(onSave).toHaveBeenCalledTimes(1)

    // The user keeps typing before the stamped round-trip lands.
    act(() => result.current.setEditorValue("edited content plus more"))
    rerender({ note: note(stamp("edited content")) })

    expect(result.current.editorValue).toBe("edited content plus more")
    act(() => vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS))
    expect(onSave).toHaveBeenCalledTimes(2)
    expect(onSave).toHaveBeenLastCalledWith("edited content plus more")
  })

  it("does not commit a stale pending value over a re-seed (typed and reverted)", () => {
    const { result, rerender, onSave } = renderEditorValue(note("original content"))

    // A no-op edit: typed and reverted to the exact original bytes.
    act(() => result.current.setEditorValue("original contentX"))
    act(() => result.current.setEditorValue("original content"))

    // A pull lands inside the debounce window; the editor (idle in substance)
    // re-seeds to the pulled content.
    rerender({ note: note("pulled content") })
    expect(result.current.editorValue).toBe("pulled content")

    // The stale pending value must not overwrite what the editor now shows.
    act(() => vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS))
    expect(onSave).not.toHaveBeenCalled()
  })
})

describe("useEditorValue (new-note flow)", () => {
  it("saves the first edit of a new note and adopts its stamped round-trip", () => {
    const { result, rerender, onSave } = renderEditorValue(undefined, {
      defaultValue: "# Template\n",
    })

    act(() => result.current.setEditorValue("# Template\nfirst line\n"))
    act(() => vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS))
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave).toHaveBeenCalledWith("# Template\nfirst line\n")

    // The note now exists; the stamped store copy is adopted.
    rerender({ note: note(stamp("# Template\nfirst line\n")) })
    expect(result.current.editorValue).toBe(stamp("# Template\nfirst line\n"))

    act(() => vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS * 5))
    expect(onSave).toHaveBeenCalledTimes(1)
  })
})
