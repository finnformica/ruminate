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
/** The filter pills beneath the line: an `in:` by its scope, the rest by
 * the token. */
const pillTokens = () =>
  Array.from(
    screen
      .queryByTestId("query-filters")
      ?.querySelectorAll<HTMLElement>("[data-scope],[data-filter]") ?? [],
  ).map((pill) => pill.dataset.scope ?? pill.dataset.filter)
const options = () => Array.from(popover()?.querySelectorAll('[role="option"]') ?? [])

describe("the qualifier popover", () => {
  it("offers the notes for `in:`, and a pick writes the note's id", () => {
    const { input, onChange } = renderBox()
    type(input, "in:")
    expect(popover()?.textContent).toContain("Groceries")
    expect(popover()?.textContent).toContain("Reading list")
    fireEvent.keyDown(input, { key: "ArrowDown" })
    fireEvent.keyDown(input, { key: "Enter" })
    // The pick is a finished filter: a pill, and the line clear again.
    expect(onChange).toHaveBeenLastCalledWith("in:n2")
    expect(input.value).toBe("")
    expect(pillTokens()).toEqual(["n2"])
    expect(popover()).toBeNull()
  })

  it("leads with the open note, before typing and among what typing keeps", () => {
    const { input } = renderBox({ currentNoteId: "n2" })
    type(input, "in:")
    expect(options()[0].getAttribute("data-suggestion")).toBe("n2")
    type(input, "in:re")
    expect(options()[0].getAttribute("data-suggestion")).toBe("n2")
  })

  it("offers an open note the corpus does not hold yet, by its id", () => {
    const { input } = renderBox({ currentNoteId: "2026-09-15" })
    type(input, "in:")
    expect(options()[0].getAttribute("data-suggestion")).toBe("2026-09-15")
    fireEvent.keyDown(input, { key: "Enter" })
    expect(pillTokens()).toEqual(["2026-09-15"])
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
    expect(pillTokens()).toEqual([`date:${dates[0]}`])
    expect(input.value).toBe("")
    // `tom` finds Tomorrow by its label.
    type(input, "date:tom")
    expect(options()).toHaveLength(1)
    expect(options()[0].textContent).toContain("Tomorrow")
  })

  it("draws a block type's markdown glyph beside it, and no gloss; no key hints", () => {
    const { input } = renderBox()
    type(input, "type:")
    const glyphs = Object.fromEntries(
      options().map((row) => [
        row.getAttribute("data-suggestion"),
        row.querySelector("[data-glyph]")?.getAttribute("data-glyph") ?? null,
      ]),
    )
    expect(glyphs).toEqual({
      todo: "[ ]",
      done: "[x]",
      task: "[ ]",
      heading: "#",
      bullet: "-",
      ordered: "1.",
      quote: ">",
      code: "```",
      image: "![]",
      text: "¶",
      note: null,
      daily: null,
      weekly: null,
      template: null,
    })
    // Capitalised, beside the glyph; the heading levels and the list group
    // are typed values only.
    expect(
      options().find((row) => row.getAttribute("data-suggestion") === "todo")?.textContent,
    ).toBe("[ ]Todo")
    expect(popover()?.textContent).not.toContain("move")
    expect(popover()?.textContent).not.toContain("pick")
  })

  it("clicking a row picks it", () => {
    const { input, onChange } = renderBox()
    type(input, "type:")
    fireEvent.click(popover()!.querySelector('[data-suggestion="quote"]')!)
    expect(onChange).toHaveBeenLastCalledWith("type:quote")
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
  it("shows every qualifier in the value as a pill, with only the text in the line", () => {
    const { input, onChange } = renderBox({ value: "in:n1 type:todo milk" })
    expect(input.value).toBe("milk")
    expect(pillTokens()).toEqual(["n1", "type:todo"])
    // A pill's click takes its filter out of the query.
    fireEvent.click(screen.getByTestId("query-filters").querySelector("button")!)
    expect(onChange).toHaveBeenLastCalledWith("type:todo milk")
    expect(pillTokens()).toEqual(["type:todo"])
  })

  it("lifts a qualifier out of the line once a space follows it", () => {
    const { input, onChange } = renderBox()
    type(input, "milk type:todo")
    // Still being typed: no pill yet, and the value is the line as typed.
    expect(pillTokens()).toEqual([])
    expect(onChange).toHaveBeenLastCalledWith("milk type:todo")
    type(input, "milk type:todo ")
    expect(pillTokens()).toEqual(["type:todo"])
    expect(input.value).toBe("milk ")
    // The one string the caller holds: the filters first, then the text.
    expect(onChange).toHaveBeenLastCalledWith("type:todo milk")
    type(input, "milk bread")
    expect(onChange).toHaveBeenLastCalledWith("type:todo milk bread")
  })

  it("⌫ on an empty line takes the last pill back into it to edit", () => {
    const { input, onChange } = renderBox({ value: "in:n1 -type:done" })
    input.focus()
    fireEvent.keyDown(input, { key: "Backspace" })
    expect(input.value).toBe("-type:done")
    expect(pillTokens()).toEqual(["n1"])
    expect(onChange).toHaveBeenLastCalledWith("in:n1 -type:done")
    // With text in the line, ⌫ is the line's own.
    type(input, "milk")
    expect(fireEvent.keyDown(input, { key: "Backspace" })).toBe(true)
    expect(pillTokens()).toEqual(["n1"])
  })

  it("reads a value set from outside afresh: every qualifier a pill", () => {
    function Outside() {
      const [value, setValue] = useState("milk")
      return (
        <>
          <QueryBox value={value} onChange={setValue} />
          <button type="button" onClick={() => setValue("type:done bread")}>
            set
          </button>
        </>
      )
    }
    render(
      <Provider store={createStore()}>
        <Outside />
      </Provider>,
    )
    const input = screen.getByTestId("query-box") as HTMLInputElement
    expect(input.value).toBe("milk")
    fireEvent.click(screen.getByText("set"))
    expect(input.value).toBe("bread")
    expect(pillTokens()).toEqual(["type:done"])
  })

  it("Clear empties the line and the pills together", () => {
    const { onChange } = renderBox({ value: "type:todo milk" })
    fireEvent.click(screen.getByLabelText("Clear"))
    expect(onChange).toHaveBeenLastCalledWith("")
    expect(pillTokens()).toEqual([])
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
    expect(pillTokens()).toEqual(["type:todo"])
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
