// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react"
import { useState } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"

// `useCollapseState` persists a per-device collapsed set to localStorage
// (src/data/view-state.ts) — these tests only exercise value propagation, and
// no noteId is passed, so transient collapse state is all that's needed.
vi.mock("../../data/view-state", () => ({
  useCollapseState: () => ({ collapsed: new Set<string>(), toggleCollapse: () => {} }),
}))
vi.mock("../../global-state", async () => {
  const { atom } = await import("jotai")
  return {
    noteOutlineAtom: atom(null),
    blockRevealAtom: atom(null),
    markdownFilesAtom: atom({}),
    // Signed out: developer mode (`hooks/is-developer.ts`) stays off.
    githubUserAtom: atom(null),
    // Enter's new-block marker preference (Settings → Editor), at its default.
    newBlockMarkerAtom: atom("- "),
  }
})

import { parse } from "../../blocks/parse"
import { serialize } from "../../blocks/serialize"
import { BlockNoteEditor } from "./block-note-editor"

afterEach(cleanup)

/** A controlled host, like the real note page: it owns the doc and echoes
 * editor changes back down as the `doc` prop. */
function Host({ initial, startEditing }: { initial: string; startEditing?: boolean }) {
  const [doc, setDoc] = useState(() => parse(initial))
  return (
    <>
      <BlockNoteEditor doc={doc} onChange={setDoc} startEditing={startEditing} />
      <button data-testid="external-update" onClick={() => setDoc(parse("- pulled from remote"))}>
        external
      </button>
      <pre data-testid="value">{serialize(doc)}</pre>
    </>
  )
}

describe("BlockNoteEditor doc propagation", () => {
  it("re-seeds from an external doc (a pull updating the open note) without a remount", () => {
    const { container, getByTestId } = render(<Host initial="- original local line" />)
    expect(container.textContent).toContain("original local line")

    // Simulate a pull updating the note's content from outside the editor.
    fireEvent.click(getByTestId("external-update"))

    expect(container.textContent).toContain("pulled from remote")
    expect(container.textContent).not.toContain("original local line")
  })

  it("does not re-seed from its own edits when the parent echoes them back (typing survives)", () => {
    // A brand-new note mounts with its starter block already in edit mode.
    const { container } = render(<Host initial="" startEditing />)
    const textarea = container.querySelector("textarea")
    expect(textarea).not.toBeNull()

    // Type — the change round-trips through the parent's value state.
    fireEvent.change(textarea!, { target: { value: "typing in progress" } })

    // The editor keeps its live edit session: same textarea, same content —
    // the echoed doc must not trigger a re-seed that would clobber it.
    const after = container.querySelector("textarea")
    expect(after).toBe(textarea)
    expect(after!.value).toBe("typing in progress")
  })
})
