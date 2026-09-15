// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { NoteTitle } from "./note-title"

afterEach(cleanup)

describe("NoteTitle editing across a window blur", () => {
  it("keeps the field open when the window loses focus, commits on a real blur", () => {
    const onRename = vi.fn(() => true)
    const { getByRole, queryByRole } = render(<NoteTitle title="Plans" onRename={onRename} />)
    fireEvent.click(getByRole("button"))
    const input = getByRole("textbox", { name: "Note name" }) as HTMLInputElement
    expect(document.activeElement).toBe(input)
    fireEvent.change(input, { target: { value: "Plans for spring" } })

    // A tab switch: the window goes, nothing in the page takes focus. The
    // field stays, with what was typed, for the browser to refocus on return.
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(false)
    fireEvent.blur(input)
    expect(queryByRole("textbox", { name: "Note name" })).toBe(input)
    expect(input.value).toBe("Plans for spring")
    expect(onRename).not.toHaveBeenCalled()

    // Focus leaving for another control commits and closes the field.
    hasFocus.mockReturnValue(true)
    fireEvent.blur(input)
    expect(queryByRole("textbox", { name: "Note name" })).toBeNull()
    expect(onRename).toHaveBeenCalledWith("Plans for spring")
    hasFocus.mockRestore()
  })

  it("focus moving to another control ends the edit even while the document reports no focus", () => {
    const onRename = vi.fn(() => true)
    const { getByRole, queryByRole } = render(
      <>
        <NoteTitle title="Plans" onRename={onRename} />
        <input data-testid="outside" />
      </>,
    )
    fireEvent.click(getByRole("button"))
    const input = getByRole("textbox", { name: "Note name" })
    // jsdom clears the document's focus while it fires the blur of a focus
    // move; `relatedTarget` still names where focus went, which is enough.
    act(() => document.querySelector<HTMLInputElement>('[data-testid="outside"]')!.focus())
    expect(queryByRole("textbox", { name: "Note name" })).toBeNull()
    expect(input.isConnected).toBe(false)
  })
})
