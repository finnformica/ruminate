// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { useState } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { useListKeyboardNav } from "./list-keyboard-nav"

afterEach(cleanup)

/** A miniature of the notes-index page: a search input filtering a list. */
function Harness({
  items,
  onActivate,
  enabled = true,
}: {
  items: string[]
  onActivate: (index: number) => void
  enabled?: boolean
}) {
  const [query, setQuery] = useState("")
  const visible = items.filter((item) => item.includes(query))
  const { activeIndex, containerRef } = useListKeyboardNav({
    count: visible.length,
    resetKey: query,
    onActivate,
    enabled,
  })
  return (
    <div ref={containerRef}>
      <input
        type="search"
        aria-label="Search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <ul>
        {visible.map((item, index) => (
          <li key={item} data-list-index={index} data-active={activeIndex === index || undefined}>
            {item}
          </li>
        ))}
      </ul>
    </div>
  )
}

const highlighted = (container: HTMLElement) =>
  container.querySelector("[data-active]")?.textContent ?? null

describe("useListKeyboardNav", () => {
  it("arrows move the highlight; nothing is highlighted initially", () => {
    const { container } = render(<Harness items={["a", "b", "c"]} onActivate={() => {}} />)
    expect(highlighted(container)).toBeNull()
    fireEvent.keyDown(document.body, { key: "ArrowDown" })
    expect(highlighted(container)).toBe("a")
    fireEvent.keyDown(document.body, { key: "ArrowDown" })
    expect(highlighted(container)).toBe("b")
    fireEvent.keyDown(document.body, { key: "ArrowUp" })
    expect(highlighted(container)).toBe("a")
    // Clamped at the ends.
    fireEvent.keyDown(document.body, { key: "ArrowUp" })
    expect(highlighted(container)).toBe("a")
  })

  it("↑ from nothing starts at the last item; Home/End jump", () => {
    const { container } = render(<Harness items={["a", "b", "c"]} onActivate={() => {}} />)
    fireEvent.keyDown(document.body, { key: "ArrowUp" })
    expect(highlighted(container)).toBe("c")
    fireEvent.keyDown(document.body, { key: "Home" })
    expect(highlighted(container)).toBe("a")
    fireEvent.keyDown(document.body, { key: "End" })
    expect(highlighted(container)).toBe("c")
  })

  it("Enter activates the highlighted item", () => {
    const onActivate = vi.fn()
    render(<Harness items={["a", "b"]} onActivate={onActivate} />)
    // Enter with no highlight does nothing.
    fireEvent.keyDown(document.body, { key: "Enter" })
    expect(onActivate).not.toHaveBeenCalled()
    fireEvent.keyDown(document.body, { key: "ArrowDown" })
    fireEvent.keyDown(document.body, { key: "ArrowDown" })
    fireEvent.keyDown(document.body, { key: "Enter" })
    expect(onActivate).toHaveBeenCalledWith(1)
  })

  it("↓ inside the search input hands off to the first result", () => {
    const { container } = render(<Harness items={["a", "b"]} onActivate={() => {}} />)
    const search = screen.getByLabelText("Search")
    search.focus()
    fireEvent.keyDown(search, { key: "ArrowDown" })
    expect(highlighted(container)).toBe("a")
    expect(document.activeElement).not.toBe(search)
    // Other keys in the search input are left alone (typing keeps working).
    fireEvent.keyDown(search, { key: "ArrowUp" })
    expect(highlighted(container)).toBe("a")
  })

  it("Escape clears the highlight and returns focus to the search input", () => {
    const { container } = render(<Harness items={["a", "b"]} onActivate={() => {}} />)
    fireEvent.keyDown(document.body, { key: "ArrowDown" })
    expect(highlighted(container)).toBe("a")
    fireEvent.keyDown(document.body, { key: "Escape" })
    expect(highlighted(container)).toBeNull()
    expect(document.activeElement).toBe(screen.getByLabelText("Search"))
  })

  it("a query change resets an existing highlight to the first result", () => {
    const { container } = render(
      <Harness items={["apple", "banana", "cherry"]} onActivate={() => {}} />,
    )
    fireEvent.keyDown(document.body, { key: "ArrowDown" })
    fireEvent.keyDown(document.body, { key: "ArrowDown" })
    expect(highlighted(container)).toBe("banana")
    fireEvent.change(screen.getByLabelText("Search"), { target: { value: "c" } })
    expect(highlighted(container)).toBe("cherry") // first (only) match
    // Clearing the filter keeps the highlight pinned to the top.
    fireEvent.change(screen.getByLabelText("Search"), { target: { value: "" } })
    expect(highlighted(container)).toBe("apple")
  })

  it("does not create a highlight from a query change alone", () => {
    const { container } = render(<Harness items={["a", "b"]} onActivate={() => {}} />)
    fireEvent.change(screen.getByLabelText("Search"), { target: { value: "a" } })
    expect(highlighted(container)).toBeNull()
  })

  it("ignores typing targets and modifier combos", () => {
    const { container } = render(
      <>
        <Harness items={["a", "b"]} onActivate={() => {}} />
        <input aria-label="Other" />
      </>,
    )
    const other = screen.getByLabelText("Other")
    other.focus()
    fireEvent.keyDown(other, { key: "ArrowDown" })
    expect(highlighted(container)).toBeNull()
    fireEvent.keyDown(document.body, { key: "ArrowDown", metaKey: true })
    expect(highlighted(container)).toBeNull()
  })

  it("mounts no listener when disabled (embedded lists)", () => {
    const { container } = render(
      <Harness items={["a", "b"]} onActivate={() => {}} enabled={false} />,
    )
    fireEvent.keyDown(document.body, { key: "ArrowDown" })
    expect(highlighted(container)).toBeNull()
  })
})
