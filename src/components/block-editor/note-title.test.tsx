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
    const { getByRole } = render(<NoteTitle title="" onRename={onRename} startEditing />)
    const input = getByRole("textbox", { name: "Note name" }) as HTMLInputElement
    expect(document.activeElement).toBe(input)
  })

  it("Enter commits the name and carries on into a block below", () => {
    const onRename = vi.fn(() => true)
    const onCreateBelow = vi.fn()
    const { getByRole, queryByRole } = render(
      <NoteTitle title="" onRename={onRename} onCreateBelow={onCreateBelow} startEditing />,
    )
    const input = getByRole("textbox", { name: "Note name" })
    fireEvent.change(input, { target: { value: "Plans" } })
    fireEvent.keyDown(input, { key: "Enter" })
    expect(onRename).toHaveBeenCalledWith("Plans")
    expect(onCreateBelow).toHaveBeenCalledTimes(1)
    // The title is left, not highlighted: the keyboard is in the block now.
    expect(queryByRole("textbox", { name: "Note name" })).toBeNull()
    expect(getByRole("button").className).not.toContain("block-highlight")
  })

  it("Enter on an unchanged name still moves on into a block below", () => {
    const onRename = vi.fn(() => true)
    const onCreateBelow = vi.fn()
    const { getByRole } = render(
      <NoteTitle title="Plans" onRename={onRename} onCreateBelow={onCreateBelow} />,
    )
    fireEvent.click(getByRole("button"))
    fireEvent.keyDown(getByRole("textbox", { name: "Note name" }), { key: "Enter" })
    expect(onRename).not.toHaveBeenCalled()
    expect(onCreateBelow).toHaveBeenCalledTimes(1)
  })

  it("opens highlighted, not editing, by default", () => {
    const { getByRole, queryByRole } = render(<NoteTitle title="" onRename={() => true} />)
    expect(queryByRole("textbox", { name: "Note name" })).toBeNull()
    expect(getByRole("button")).toBeTruthy()
  })
})
