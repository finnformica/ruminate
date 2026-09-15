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

describe("NoteTitle on a new note", () => {
  it("opens editing with the caret in the field when asked to start editing", () => {
    const onRename = vi.fn(() => true)
    const { getByRole, queryByRole } = render(
      <NoteTitle title="" onRename={onRename} startEditing />,
    )
    const input = getByRole("textbox", { name: "Note name" }) as HTMLInputElement
    expect(document.activeElement).toBe(input)
    fireEvent.change(input, { target: { value: "Plans" } })
    fireEvent.keyDown(input, { key: "Enter" })
    expect(onRename).toHaveBeenCalledWith("Plans")
    expect(queryByRole("textbox", { name: "Note name" })).toBeNull()
  })

  it("stays highlighted when the title it committed comes back", () => {
    // The page passes the committed title back as the prop; that echo must
    // not reset the field, or Enter would leave nothing focused.
    const onRename = vi.fn(() => true)
    const { getByRole, rerender } = render(<NoteTitle title="" onRename={onRename} startEditing />)
    const input = getByRole("textbox", { name: "Note name" })
    fireEvent.change(input, { target: { value: "Plans " } })
    fireEvent.keyDown(input, { key: "Enter" })
    rerender(<NoteTitle title="Plans" onRename={onRename} startEditing />)
    const heading = getByRole("button")
    expect(document.activeElement).toBe(heading)
    expect(heading.className).toContain("block-highlight")
    // A retitle from elsewhere still resets it.
    rerender(<NoteTitle title="Other" onRename={onRename} startEditing />)
    expect(getByRole("button").className).not.toContain("block-highlight")
    expect(getByRole("button").textContent).toBe("Other")
  })

  it("opens highlighted, not editing, by default", () => {
    const { getByRole, queryByRole } = render(<NoteTitle title="" onRename={() => true} />)
    expect(queryByRole("textbox", { name: "Note name" })).toBeNull()
    expect(getByRole("button")).toBeTruthy()
  })
})
