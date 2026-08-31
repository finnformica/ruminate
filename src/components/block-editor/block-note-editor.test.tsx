// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react"
import { useState } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"

// `useCollapseState` persists per-device collapse overrides to localStorage
// (src/data/view-state.ts) — these tests only exercise value propagation, and
// no noteId is passed, so transient collapse state is all that's needed.
vi.mock("../../data/view-state", () => ({
  useCollapseState: () => ({ collapsed: new Set<string>(), toggleCollapse: () => {} }),
}))
vi.mock("../../global-state", async () => {
  const { atom } = await import("jotai")
  return { noteOutlineAtom: atom(null), blockRevealAtom: atom(null), markdownFilesAtom: atom({}) }
})

import { BlockNoteEditor } from "./block-note-editor"

afterEach(cleanup)

/** A controlled host, like the real note page: it owns the markdown value and
 * echoes editor changes back down as the `value` prop. */
function Host({ initial, startEditing }: { initial: string; startEditing?: boolean }) {
  const [value, setValue] = useState(initial)
  return (
    <>
      <BlockNoteEditor value={value} onChange={setValue} startEditing={startEditing} />
      <button data-testid="external-update" onClick={() => setValue("- pulled from remote")}>
        external
      </button>
      <pre data-testid="value">{value}</pre>
    </>
  )
}

describe("BlockNoteEditor value propagation", () => {
  it("re-parses external value changes (a pull updating the open note) without a remount", () => {
    const { container, getByTestId } = render(<Host initial="- original local line" />)
    expect(container.textContent).toContain("original local line")

    // Simulate a pull updating the note's content from outside the editor.
    fireEvent.click(getByTestId("external-update"))

    expect(container.textContent).toContain("pulled from remote")
    expect(container.textContent).not.toContain("original local line")
  })

  it("does not re-parse its own edits when the parent echoes them back (typing survives)", () => {
    // A brand-new note mounts with its starter block already in edit mode.
    const { container } = render(<Host initial="" startEditing />)
    const textarea = container.querySelector("textarea")
    expect(textarea).not.toBeNull()

    // Type — the change round-trips through the parent's value state.
    fireEvent.change(textarea!, { target: { value: "typing in progress" } })

    // The editor keeps its live edit session: same textarea, same content —
    // the echoed value must not trigger a re-parse that would clobber it.
    const after = container.querySelector("textarea")
    expect(after).toBe(textarea)
    expect(after!.value).toBe("typing in progress")
  })
})
