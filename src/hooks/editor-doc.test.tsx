// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { parse } from "../blocks/parse"
import { serialize } from "../blocks/serialize"
import type { BlockDoc } from "../blocks/types"
import { buildGraphSnapshot, docToGraph, type GraphSnapshot } from "../data/graph"
import { AUTOSAVE_DEBOUNCE_MS, useEditorDoc } from "./editor-doc"

const NOTE = "note"
const EMPTY = buildGraphSnapshot([], [])

/** A graph holding `NOTE` with the given markdown (the canonical form, so the
 * walked doc's bytes are the markdown's). */
function graphWith(markdown: string): GraphSnapshot {
  const { nodes, links } = docToGraph(NOTE, serialize(parse(markdown)), 1)
  return buildGraphSnapshot(nodes, links)
}

/** The doc's bytes, minus `id::` lines — what the tests compare on. */
const text = (doc: BlockDoc) =>
  serialize(doc)
    .split("\n")
    .filter((line) => !line.includes("id::"))
    .join("\n")

function renderEditorDoc(
  initial: GraphSnapshot,
  { defaultDoc = parse("") }: { defaultDoc?: BlockDoc } = {},
) {
  const onSave = vi.fn()
  const hook = renderHook(
    ({ snapshot }: { snapshot: GraphSnapshot }) =>
      useEditorDoc({ noteId: NOTE, snapshot, defaultDoc, onSave }),
    { initialProps: { snapshot: initial } },
  )
  return { ...hook, onSave }
}

/** An edit: the stored doc with one more line. */
const edited = (doc: BlockDoc, line: string) => parse(serialize(doc) + line + "\n")

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

describe("useEditorDoc (seeding)", () => {
  it("seeds from the note's doc in the graph", () => {
    const { result } = renderEditorDoc(graphWith("original content\n"))
    expect(text(result.current.editorDoc)).toBe("original content\n")
  })

  it("seeds a new note from the default doc (template)", () => {
    const { result } = renderEditorDoc(EMPTY, { defaultDoc: parse("# Template\n") })
    expect(text(result.current.editorDoc)).toBe("# Template\n")
  })

  it("shows a note that arrives after mount (cold load: store still opening)", () => {
    // The refresh case: the store is opening, so the graph is empty for a
    // beat and the editor seeds empty. When the note lands it must replace
    // that placeholder.
    const { result, rerender } = renderEditorDoc(EMPTY)
    expect(text(result.current.editorDoc)).toBe("\n")
    rerender({ snapshot: graphWith("- pulled from the store\n") })
    expect(text(result.current.editorDoc)).toBe("- pulled from the store\n")
  })

  it("a template stays put when the note arrives empty-handed, then adopts it", () => {
    const { result, rerender } = renderEditorDoc(EMPTY, { defaultDoc: parse("# Template\n") })
    expect(text(result.current.editorDoc)).toBe("# Template\n")
    rerender({ snapshot: graphWith("- real content\n") })
    expect(text(result.current.editorDoc)).toBe("- real content\n")
  })

  it("does NOT clobber typing that happened before the note arrived", () => {
    // The genuine new-note flow: the user types into a note that does not
    // exist yet. Their work must survive the note landing.
    const { result, rerender } = renderEditorDoc(EMPTY)
    act(() => result.current.setEditorDoc(parse("- my new thought\n")))
    rerender({ snapshot: graphWith("- something else entirely\n") })
    expect(text(result.current.editorDoc)).toBe("- my new thought\n")
  })
})

describe("useEditorDoc (autosave)", () => {
  it("saves a change after the debounce, not immediately", () => {
    const { result, onSave } = renderEditorDoc(graphWith("original content\n"))
    const next = edited(result.current.editorDoc, "more")

    act(() => result.current.setEditorDoc(next))
    expect(onSave).not.toHaveBeenCalled()

    act(() => vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS))
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave).toHaveBeenCalledWith(next)
  })

  it("coalesces rapid edits into one save of the latest doc", () => {
    const { result, onSave } = renderEditorDoc(graphWith("original content\n"))
    const one = edited(result.current.editorDoc, "edit 1")
    const two = edited(result.current.editorDoc, "edit 2")

    act(() => result.current.setEditorDoc(one))
    act(() => vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS - 100))
    act(() => result.current.setEditorDoc(two))
    act(() => vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS - 100))
    expect(onSave).not.toHaveBeenCalled()

    act(() => vi.advanceTimersByTime(100))
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave).toHaveBeenCalledWith(two)
  })

  it("flushNow saves immediately (⌘S) and a second flush is a no-op", () => {
    const { result, onSave } = renderEditorDoc(graphWith("original content\n"))
    const next = edited(result.current.editorDoc, "more")

    act(() => result.current.setEditorDoc(next))
    act(() => result.current.flushNow())
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave).toHaveBeenCalledWith(next)

    // Nothing left pending: neither a repeat flush nor the old timer saves again.
    act(() => result.current.flushNow())
    act(() => vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS))
    expect(onSave).toHaveBeenCalledTimes(1)
  })

  it("flushes when the page hides, on pagehide, and on unmount", () => {
    for (const leave of [hidePage, () => window.dispatchEvent(new Event("pagehide")), null]) {
      const { result, onSave, unmount } = renderEditorDoc(graphWith("original content\n"))
      const next = edited(result.current.editorDoc, "more")
      act(() => result.current.setEditorDoc(next))
      if (leave) act(() => leave())
      else unmount()
      expect(onSave).toHaveBeenCalledTimes(1)
      expect(onSave).toHaveBeenCalledWith(next)
      cleanup()
    }
  })

  it("never saves when nothing was edited, nor an unedited template", () => {
    const idle = renderEditorDoc(graphWith("original content\n"))
    act(() => hidePage())
    act(() => vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS * 5))
    idle.unmount()
    expect(idle.onSave).not.toHaveBeenCalled()

    const template = renderEditorDoc(EMPTY, { defaultDoc: parse("# Template\n") })
    act(() => vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS * 5))
    template.unmount()
    expect(template.onSave).not.toHaveBeenCalled()
  })
})

describe("useEditorDoc (external changes)", () => {
  it("re-seeds the editor when the note changes in the graph and the editor is idle", () => {
    const { result, rerender } = renderEditorDoc(graphWith("original content\n"))
    // A pull updates the open note.
    rerender({ snapshot: graphWith("pulled content\n") })
    expect(text(result.current.editorDoc)).toBe("pulled content\n")
  })

  it("keeps the local doc when an external change lands mid-edit, and the next flush settles it", () => {
    const { result, rerender, onSave } = renderEditorDoc(graphWith("original content\n"))
    const local = edited(result.current.editorDoc, "local unflushed edits")

    act(() => result.current.setEditorDoc(local))
    rerender({ snapshot: graphWith("pulled content\n") })

    // Local typing wins over the pull (per-row last-writer-wins)...
    expect(result.current.editorDoc).toBe(local)

    // ...and the pending autosave commits it.
    act(() => vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS))
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave).toHaveBeenCalledWith(local)
  })

  it("adopts its own save once it lands (stamped frontmatter and all)", () => {
    const { result, rerender, onSave } = renderEditorDoc(graphWith("original content\n"))
    const local = edited(result.current.editorDoc, "typed")
    act(() => result.current.setEditorDoc(local))
    act(() => vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS))
    expect(onSave).toHaveBeenCalledWith(local)

    // The save round-trips with `updated_at` stamped: not an unflushed edit,
    // so the editor takes the graph's version of what it just wrote.
    const stamped = "---\nupdated_at: 2026-09-10T09:00:00.000Z\n---\n" + serialize(local)
    rerender({ snapshot: graphWith(stamped) })
    expect(result.current.editorDoc.frontmatter).toContain("updated_at")
    expect(text(result.current.editorDoc)).toContain("typed")
  })
})
