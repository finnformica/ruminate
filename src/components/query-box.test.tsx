// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { Provider, createStore } from "jotai"
import { useState } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"

// The popover reads the corpus (notes) from the global-state atoms, which sit
// on the app's state machine — mocked here as plain atoms; the scope pill
// names a note through the note hook and the block index, pinned too.
vi.mock("../global-state", async () => {
  const { atom } = await import("jotai")
  const note = (id: string, displayName: string) => ({
    id,
    type: "note",
    displayName,
    props: {},
    title: displayName,
    pinned: false,
    updatedAt: null,
    dates: [],
    tasks: [],
    headings: [],
    text: "",
  })
  return {
    sortedNotesAtom: atom([note("n1", "Groceries"), note("n2", "Reading list")]),
    blockIndexAtom: atom({ hits: [], getBlock: () => undefined }),
  }
})
vi.mock("../hooks/note", () => ({ useNoteById: () => undefined }))

import { QueryBox } from "./query-box"

afterEach(cleanup)

Element.prototype.scrollIntoView = vi.fn()

/** The box is controlled: its caller holds the text and writes it back the
 * same render, as the notes page and the palette do. */
function Harness({
  onChange,
  value: initial = "",
  ...props
}: Partial<React.ComponentProps<typeof QueryBox>> & { onChange: (value: string) => void }) {
  const [value, setValue] = useState(initial)
  return (
    <QueryBox
      {...props}
      value={value}
      onChange={(next) => {
        setValue(next)
        onChange(next)
      }}
    />
  )
}

function renderBox(
  props: Partial<React.ComponentProps<typeof QueryBox>> & { value?: string } = {},
) {
  const onChange = vi.fn()
  render(
    <Provider store={createStore()}>
      <Harness onChange={onChange} {...props} />
    </Provider>,
  )
  const input = screen.getByTestId("query-box") as HTMLInputElement
  return { input, onChange }
}

/** Type with focus in the box and the caret at the end (jsdom places the
 * caret for us on a value set, but not focus). */
function type(input: HTMLInputElement, value: string) {
  input.focus()
  fireEvent.change(input, { target: { value } })
  input.setSelectionRange(value.length, value.length)
  fireEvent.keyUp(input, { key: value.slice(-1) })
}

const popover = () => screen.queryByTestId("qualifier-suggestions")
const options = () => Array.from(popover()?.querySelectorAll('[role="option"]') ?? [])

describe("the qualifier popover", () => {
  it("offers the notes for `in:`, and a pick writes the note's id", () => {
    const { input, onChange } = renderBox()
    type(input, "in:")
    expect(popover()?.textContent).toContain("Groceries")
    expect(popover()?.textContent).toContain("Reading list")
    fireEvent.keyDown(input, { key: "ArrowDown" })
    fireEvent.keyDown(input, { key: "Enter" })
    expect(onChange).toHaveBeenLastCalledWith("in:n2 ")
    expect(input.value).toBe("in:n2 ")
    expect(popover()).toBeNull()
  })

  it("narrows notes by name as you type", () => {
    const { input } = renderBox()
    type(input, "in:read")
    expect(options()).toHaveLength(1)
    expect(options()[0].textContent).toContain("Reading list")
  })

  it("lists the sort keys with their directions, and the relative dates", () => {
    const { input } = renderBox()
    type(input, "sort:")
    expect(options().map((row) => row.getAttribute("data-suggestion"))).toContain("title:desc")
    type(input, "sort:updated_at:")
    expect(options().map((row) => row.getAttribute("data-suggestion"))).toEqual(["updated_at:asc"])
    type(input, "date:")
    // The slash menu's shortcuts, each resolved to a day: the row reads as
    // the word, glossed with the date, and the day is what lands.
    const words = ["Today", "Tomorrow", "Yesterday", "Next week", "Last week"]
    const labels = options().map((row) => row.textContent?.replace(/^:\s*/, "") ?? "")
    expect(labels.map((label) => words.find((word) => label.startsWith(word)))).toEqual(words)
    const dates = options().map((row) => row.getAttribute("data-suggestion"))
    for (const date of dates) expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    fireEvent.keyDown(input, { key: "Tab" })
    expect(input.value).toBe(`date:${dates[0]} `)
    // `tom` finds Tomorrow by its label.
    type(input, "date:tom")
    expect(options()).toHaveLength(1)
    expect(options()[0].textContent).toContain("Tomorrow")
  })

  it("clicking a row picks it", () => {
    const { input, onChange } = renderBox()
    type(input, "type:")
    fireEvent.click(popover()!.querySelector('[data-suggestion="quote"]')!)
    expect(onChange).toHaveBeenLastCalledWith("type:quote ")
  })

  it("Escape dismisses it; leaving the box hides it", () => {
    const { input } = renderBox()
    type(input, "type:")
    expect(popover()).not.toBeNull()
    fireEvent.keyDown(input, { key: "Escape" })
    expect(popover()).toBeNull()
    // A different qualifier opens afresh.
    type(input, "in:")
    expect(popover()).not.toBeNull()
    fireEvent.blur(input)
    expect(popover()).toBeNull()
  })

  it("keeps its keys to itself: nothing beneath sees a key it took", () => {
    const { input } = renderBox()
    const seen = vi.fn()
    document.addEventListener("keydown", seen)
    type(input, "type:")
    fireEvent.keyDown(input, { key: "ArrowDown" })
    fireEvent.keyDown(input, { key: "Escape" })
    expect(seen).not.toHaveBeenCalled()
    document.removeEventListener("keydown", seen)
  })

  it("hangs beside the token — or, in a narrow box, under the whole box", () => {
    const { input } = renderBox()
    type(input, "milk type:")
    // jsdom lays nothing out, so the box measures narrow: the full width.
    expect(popover()?.getAttribute("data-placement")).toBe("full")
    expect(popover()?.style.top).not.toBe("")
  })

  it("tells assistive technology which row is highlighted, without moving focus", () => {
    const { input } = renderBox()
    type(input, "in:")
    const list = popover()!
    expect(input.getAttribute("aria-controls")).toBe(list.id)
    expect(input.getAttribute("aria-expanded")).toBe("true")
    const rows = options()
    expect(input.getAttribute("aria-activedescendant")).toBe(rows[0].id)
    fireEvent.keyDown(input, { key: "ArrowDown" })
    expect(input.getAttribute("aria-activedescendant")).toBe(rows[1].id)
    expect(document.activeElement).toBe(input)
    fireEvent.keyDown(input, { key: "Escape" })
    expect(input.getAttribute("aria-activedescendant")).toBeNull()
    expect(input.getAttribute("aria-expanded")).toBeNull()
  })

  it("closes once the value is typed out in full", () => {
    const { input } = renderBox()
    type(input, "type:quot")
    expect(popover()).not.toBeNull()
    type(input, "type:quote")
    expect(popover()).toBeNull()
  })

  it("stays shut for plain text and for unknown keys", () => {
    const { input } = renderBox()
    type(input, "nvidia")
    expect(popover()).toBeNull()
    type(input, "https://example.com")
    expect(popover()).toBeNull()
  })
})

describe("the box around the query", () => {
  it("shows each `in:` in the text as a pill, and the pill takes it out", () => {
    const { onChange } = renderBox({ value: "in:n1 milk" })
    const pills = screen.getByTestId("query-scopes")
    expect(pills.querySelector("[data-scope='n1']")).not.toBeNull()
    fireEvent.click(pills.querySelector("button")!)
    expect(onChange).toHaveBeenLastCalledWith("milk")
  })

  it("shows a scope in force that is not in the text, with its own remove", () => {
    const onRemove = vi.fn()
    renderBox({ impliedScope: { value: "n2", onRemove } })
    const pills = screen.getByTestId("query-scopes")
    expect(pills.querySelector("[data-scope='n2']")).not.toBeNull()
    fireEvent.click(pills.querySelector("button")!)
    expect(onRemove).toHaveBeenCalled()
  })

  it("↓ hands the keyboard off when the caller takes it, and not otherwise", () => {
    const onHandOff = vi.fn(() => true)
    const { input } = renderBox({ onHandOff })
    type(input, "milk")
    const down = fireEvent.keyDown(input, { key: "ArrowDown" })
    expect(onHandOff).toHaveBeenCalled()
    expect(down).toBe(false) // consumed
    onHandOff.mockReturnValue(false)
    expect(fireEvent.keyDown(input, { key: "ArrowDown" })).toBe(true)
    // With the popover open ↓ is the popover's, whatever the caller says.
    onHandOff.mockClear()
    type(input, "type:")
    fireEvent.keyDown(input, { key: "ArrowDown" })
    expect(onHandOff).not.toHaveBeenCalled()
  })

  it("↵ submits when the caller takes it — never while the popover is open", () => {
    const onSubmit = vi.fn(() => true)
    const { input } = renderBox({ onSubmit })
    type(input, "type:")
    fireEvent.keyDown(input, { key: "Enter" })
    expect(onSubmit).not.toHaveBeenCalled()
    expect(input.value).toBe("type:todo ")
    fireEvent.keyDown(input, { key: "Enter" })
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it("dresses for the palette: a bare line, plain text, no icon", () => {
    const { input } = renderBox({ variant: "palette" })
    expect(input.type).toBe("text")
    expect(screen.getByTestId("query-box-root").dataset.variant).toBe("palette")
    expect(screen.queryByLabelText("Clear")).toBeNull()
  })
})
