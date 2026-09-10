// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { Provider, createStore } from "jotai"
import { afterEach, describe, expect, it, vi } from "vitest"

// The picker reads the corpus (notes, tags) from the global-state atoms,
// which sit on the app's state machine — mocked here as plain atoms.
vi.mock("../global-state", async () => {
  const { atom } = await import("jotai")
  const note = (id: string, displayName: string) => ({
    id,
    type: "note",
    displayName,
    props: {},
    title: displayName,
    url: null,
    alias: null,
    pinned: false,
    updatedAt: null,
    dates: [],
    tags: [],
    tasks: [],
    headings: [],
    text: "",
  })
  return {
    sortedNotesAtom: atom([note("n1", "Groceries"), note("n2", "Reading list")]),
    sortedTagEntriesAtom: atom([
      ["home", ["n1"]],
      ["work", ["n1", "n2"]],
    ]),
  }
})

import { SearchInput } from "./search-input"

afterEach(cleanup)

Element.prototype.scrollIntoView = vi.fn()

function renderInput(props: { suggest?: boolean } = { suggest: true }) {
  const onChange = vi.fn()
  render(
    <Provider store={createStore()}>
      <SearchInput value="" onChange={onChange} {...props} />
    </Provider>,
  )
  const input = screen.getByRole("searchbox") as HTMLInputElement
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

const picker = () => screen.queryByTestId("qualifier-suggestions")
// The picker is lazy-loaded the first time a box asks for it.
const findPicker = () => screen.findByTestId("qualifier-suggestions")

describe("search input suggestions", () => {
  it("offers the notes for `in:`, and a pick writes the note's id", async () => {
    const { input, onChange } = renderInput()
    type(input, "in:")
    const list = await findPicker()
    expect(list.textContent).toContain("Groceries")
    expect(list.textContent).toContain("Reading list")
    fireEvent.keyDown(input, { key: "ArrowDown" })
    fireEvent.keyDown(input, { key: "Enter" })
    expect(onChange).toHaveBeenLastCalledWith("in:n2 ")
    expect(input.value).toBe("in:n2 ")
    expect(picker()).toBeNull()
  })

  it("narrows notes by name as you type", async () => {
    const { input } = renderInput()
    type(input, "in:read")
    const options = (await findPicker()).querySelectorAll('[role="option"]')
    expect(options).toHaveLength(1)
    expect(options[0].textContent).toContain("Reading list")
  })

  it("offers the tags for `tag:`, with their counts, and Tab picks", async () => {
    const { input, onChange } = renderInput()
    type(input, "milk tag:w")
    const list = await findPicker()
    expect(list.textContent).toContain("work")
    expect(list.textContent).toContain("2")
    expect(list.textContent).not.toContain("home")
    fireEvent.keyDown(input, { key: "Tab" })
    expect(onChange).toHaveBeenLastCalledWith("milk tag:work ")
  })

  it("clicking a row picks it", async () => {
    const { input, onChange } = renderInput()
    type(input, "type:")
    const list = await findPicker()
    fireEvent.click(list.querySelector('[data-suggestion="quote"]')!)
    expect(onChange).toHaveBeenLastCalledWith("type:quote ")
  })

  it("Escape dismisses the picker; leaving the box hides it", async () => {
    const { input } = renderInput()
    type(input, "type:")
    expect(await findPicker()).not.toBeNull()
    fireEvent.keyDown(input, { key: "Escape" })
    expect(picker()).toBeNull()
    // A different qualifier opens afresh.
    type(input, "tag:")
    expect(await findPicker()).not.toBeNull()
    fireEvent.blur(input)
    expect(picker()).toBeNull()
  })

  it("the page's own arrow keys never see a key the picker took", async () => {
    const { input } = renderInput()
    const seen = vi.fn()
    document.addEventListener("keydown", seen)
    type(input, "type:")
    await findPicker()
    fireEvent.keyDown(input, { key: "ArrowDown" })
    expect(seen).not.toHaveBeenCalled()
    document.removeEventListener("keydown", seen)
  })

  it("tells assistive technology which row is highlighted, without moving focus", async () => {
    const { input } = renderInput()
    type(input, "in:")
    const list = await findPicker()
    expect(input.getAttribute("aria-controls")).toBe(list.id)
    expect(input.getAttribute("aria-expanded")).toBe("true")
    const rows = list.querySelectorAll('[role="option"]')
    expect(input.getAttribute("aria-activedescendant")).toBe(rows[0].id)
    fireEvent.keyDown(input, { key: "ArrowDown" })
    expect(input.getAttribute("aria-activedescendant")).toBe(rows[1].id)
    expect(document.activeElement).toBe(input)
    fireEvent.keyDown(input, { key: "Escape" })
    expect(input.getAttribute("aria-activedescendant")).toBeNull()
    expect(input.getAttribute("aria-expanded")).toBeNull()
  })

  it("closes once the value is typed out in full", async () => {
    const { input } = renderInput()
    type(input, "type:quot")
    expect(await findPicker()).not.toBeNull()
    type(input, "type:quote")
    expect(picker()).toBeNull()
  })

  it("only opens where asked for (a plain filter box gets none)", async () => {
    const { input } = renderInput({ suggest: false })
    type(input, "type:")
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(picker()).toBeNull()
  })
})
