// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { useBlockResultTree } from "../hooks/block-result-tree"
import { useListKeyboardNav } from "../hooks/list-keyboard-nav"
import type { Note } from "../schema"
import type { BlockHit, BlockSearchType } from "../utils/block-search"
import type { BlockSearchSource } from "../utils/block-search-source"
import { SearchResults, blockHitNavigation } from "./search-results"

afterEach(cleanup)

const NOTE: Note = {
  id: "research",
  content: "",
  type: "note",
  displayName: "research",
  frontmatter: {},
  title: "research",
  url: null,
  alias: null,
  pinned: false,
  updatedAt: null,
  dates: [],
  tags: [],
  tasks: [],
}

/** The raw line the index would have read this hit from — the marker the
 * editor renders the block's type from (`getBlockType`). */
function contentFor(text: string, type: BlockSearchType): string {
  switch (type) {
    case "todo":
      return `[ ] ${text}`
    case "done":
      return `[x] ${text}`
    case "bullet":
      return `- ${text}`
    case "ordered":
      return `1. ${text}`
    case "quote":
      return `> ${text}`
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6":
      return `# ${text}`
    default:
      return text
  }
}

function hit(
  blockId: string,
  text: string,
  type: BlockSearchType,
  ancestors: { id: string; text: string }[] = [],
  childCount = 0,
): BlockHit {
  return {
    blockId,
    noteId: NOTE.id,
    content: contentFor(text, type),
    text,
    type,
    ancestors,
    childCount,
    note: NOTE,
  }
}

/** The owner's two reported cases, as fixtures: a heading nested two levels
 * down, and unchecked todos anywhere in the corpus. */
const NVIDIA = hit(
  "blk_nvidia",
  "nvidia",
  "h3",
  [
    { id: "blk_semis", text: "Semiconductors" },
    { id: "blk_gpus", text: "GPUs" },
  ],
  2,
)
const MILK = hit("blk_milk", "buy milk", "todo")
const SHIP = hit("blk_ship", "ship it", "done")

const H100 = hit("blk_h100", "H100 supply", "bullet", [], 1)
const H100_DETAIL = hit("blk_detail", "80GB HBM3", "text")
const REVENUE = hit("blk_rev", "datacenter revenue", "bullet")

/** A synchronous source over a fixed child table, counting its calls so lazy
 * resolution can be pinned. */
function makeSource(children: Record<string, BlockHit[]>) {
  const calls: string[] = []
  const source: BlockSearchSource = {
    search: () => [],
    children: (parent) => {
      calls.push(parent.blockId)
      return children[parent.blockId] ?? []
    },
  }
  return { source, calls }
}

/** The full results view, in miniature: the page variant driven by the same
 * two hooks the notes route uses. */
function Harness({ hits, source }: { hits: BlockHit[]; source: BlockSearchSource }) {
  const { rows, expand, collapse, toggle } = useBlockResultTree({ hits, source, resetKey: "q" })
  const { activeIndex, setActiveIndex, containerRef } = useListKeyboardNav({
    count: rows.length,
    resetKey: "q",
    onActivate: (index) => onActivate(blockHitNavigation(rows[index].hit)),
    onExpand: (index) => expand(rows[index]),
    onCollapse: (index) => {
      const row = rows[index]
      if (row.expanded) {
        collapse(row)
        return
      }
      const parentIndex = rows.findIndex((other) => other.key === row.parentKey)
      if (parentIndex !== -1) setActiveIndex(parentIndex)
    },
  })
  return (
    <div ref={containerRef}>
      <SearchResults
        variant="page"
        rows={rows}
        activeIndex={activeIndex}
        onActivate={(hit) => onActivate(blockHitNavigation(hit))}
        onToggle={toggle}
      />
    </div>
  )
}

const onActivate = vi.fn()

function renderResults(hits: BlockHit[], children: Record<string, BlockHit[]> = {}) {
  onActivate.mockClear()
  const { source, calls } = makeSource(children)
  render(<Harness hits={hits} source={source} />)
  return { calls }
}

const rowAt = (index: number) =>
  document.querySelector(`[data-list-index="${index}"]`) as HTMLElement | null
const activeRow = () => document.querySelector('[data-active="true"]') as HTMLElement | null
const arrow = (key: string) => fireEvent.keyDown(document.body, { key })

describe("search results (page)", () => {
  it("renders a nested block as its own row, with its breadcrumb", () => {
    renderResults([NVIDIA])
    const row = rowAt(0)
    expect(row?.textContent).toContain("nvidia")
    // Where it lives: the note, then its ancestry.
    expect(row?.textContent).toContain("research")
    expect(row?.textContent).toContain("Semiconductors")
    expect(row?.textContent).toContain("GPUs")
  })

  it("renders each block in its own type's style", () => {
    renderResults([NVIDIA, MILK, SHIP])
    // A heading keeps its `#` and its weight.
    expect(rowAt(0)?.querySelector('[data-testid="result-block"]')?.className).toContain(
      "font-bold",
    )
    // …in the editor's own marker slot, at the editor's root-heading scale.
    const hash = rowAt(0)?.querySelector('[data-testid="heading-hash"]')
    expect(hash?.textContent).toBe("#")
    expect(hash?.className).toContain("text-2xl")
    // Todos render as real checkboxes; a done one is struck through.
    const boxes = document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
    expect(boxes).toHaveLength(2)
    expect(boxes[0].checked).toBe(false)
    expect(boxes[1].checked).toBe(true)
    expect(rowAt(2)?.querySelector('[data-testid="result-block"]')?.className).toContain(
      "line-through",
    )
  })

  it("draws the expand chevron only for blocks with something downstream", () => {
    renderResults([NVIDIA, MILK])
    // One chevron: the leaf has none at all (the editor's rule — a leaf's
    // marker slot holds only its key).
    const toggles = screen.getAllByLabelText("Expand")
    expect(toggles).toHaveLength(1)
    // It sits in the heading's marker slot, pinned while the result is
    // closed, exactly like a folded block's in the editor.
    expect(toggles[0].className).toContain("block-toggle-pinned")
    expect(toggles[0].closest('[data-testid="heading-hash"]')).not.toBeNull()
    expect(rowAt(1)?.querySelector(".block-toggle")).toBeNull()
  })

  it("draws every marker the editor draws: dot, number, quote glyph and bar, empty slot", () => {
    const BULLET = hit("blk_b", "a bullet", "bullet")
    const ORDERED = hit("blk_o", "an item", "ordered")
    const QUOTE = hit("blk_q", "a quote", "quote")
    const PLAIN = hit("blk_p", "plain", "text")
    renderResults([BULLET, ORDERED, QUOTE, PLAIN])
    expect(rowAt(0)?.querySelector(".size-1\\.5.rounded-full")).not.toBeNull()
    expect(rowAt(1)?.textContent).toContain("1.")
    expect(rowAt(2)?.querySelector('[data-testid="quote-glyph"]')?.textContent).toBe(">")
    // The quote's bar stands beside its text, and the text is set in secondary ink.
    expect(rowAt(2)?.querySelector(".self-stretch.rounded-full")).not.toBeNull()
    expect(rowAt(2)?.querySelector('[data-testid="result-block"]')?.className).toContain(
      "text-text-secondary",
    )
    expect(rowAt(3)?.querySelector('[data-testid="paragraph-slot"]')).not.toBeNull()
  })

  it("scales a revealed child heading by its depth, as the editor does", () => {
    const SECTION = hit("blk_sec", "Section", "h2")
    renderResults([NVIDIA], { blk_nvidia: [SECTION] })
    fireEvent.click(screen.getByLabelText("Expand"))
    // Depth 1: the editor's second heading scale, hash and text alike.
    const child = rowAt(1)
    expect(child?.querySelector('[data-testid="result-block"]')?.className).toContain("text-xl")
    expect(child?.querySelector('[data-testid="heading-hash"]')?.className).toContain("text-xl")
    // Its guide hangs from the parent's marker, 24px in (11px + rule + 12px).
    expect(child?.querySelector(".ml-\\[11px\\].border-l.pl-3")).not.toBeNull()
  })

  it("puts a parent todo's chevron beside its checkbox, like the editor", () => {
    const PARENT = hit("blk_pt", "parent todo", "todo", [], 1)
    renderResults([PARENT])
    const toggle = screen.getByLabelText("Expand")
    expect(toggle.closest(".block-toggle-beside")).not.toBeNull()
    expect(rowAt(0)?.querySelector(".block-toggle-hint")).not.toBeNull()
  })

  it("expands on click, resolving children lazily and once", () => {
    const { calls } = renderResults([NVIDIA], { blk_nvidia: [H100, REVENUE] })
    // Nothing is fetched until the reader asks.
    expect(calls).toEqual([])
    expect(screen.queryByText("H100 supply")).toBeNull()

    fireEvent.click(screen.getByLabelText("Expand"))
    expect(calls).toEqual(["blk_nvidia"])
    expect(screen.getByText("H100 supply")).toBeTruthy()
    expect(screen.getByText("datacenter revenue")).toBeTruthy()
    // Children are rows of their own, indented under the hit.
    expect(rowAt(1)?.textContent).toContain("H100 supply")

    fireEvent.click(screen.getByLabelText("Collapse"))
    expect(screen.queryByText("H100 supply")).toBeNull()
  })

  it("→ expands, ← collapses, and ← from a child moves to its parent", () => {
    renderResults([NVIDIA], { blk_nvidia: [H100, REVENUE], blk_h100: [H100_DETAIL] })

    arrow("ArrowDown")
    expect(activeRow()?.textContent).toContain("nvidia")

    arrow("ArrowRight")
    expect(screen.getByText("H100 supply")).toBeTruthy()

    // Down into a child, then open the next level the same way.
    arrow("ArrowDown")
    expect(activeRow()?.textContent).toContain("H100 supply")
    arrow("ArrowRight")
    expect(screen.getByText("80GB HBM3")).toBeTruthy()

    // ← closes the child…
    arrow("ArrowLeft")
    expect(screen.queryByText("80GB HBM3")).toBeNull()
    // …and again, from a closed child, steps out to its parent.
    arrow("ArrowLeft")
    expect(activeRow()?.textContent).toContain("nvidia")
    // …which then collapses.
    arrow("ArrowLeft")
    expect(screen.queryByText("H100 supply")).toBeNull()
  })

  it("Enter opens the highlighted block: its note, zoomed to the block", () => {
    renderResults([NVIDIA])
    arrow("ArrowDown")
    arrow("Enter")
    expect(onActivate).toHaveBeenCalledWith({
      to: "/notes/$",
      params: { _splat: "research" },
      search: { query: undefined, block: "blk_nvidia" },
    })
  })

  it("clicking a row opens it the same way", () => {
    renderResults([MILK])
    fireEvent.click(screen.getByText("buy milk"))
    expect(onActivate).toHaveBeenCalledWith({
      to: "/notes/$",
      params: { _splat: "research" },
      search: { query: undefined, block: "blk_milk" },
    })
  })

  it("only the matched hits carry a breadcrumb — revealed children are context", () => {
    renderResults([NVIDIA], { blk_nvidia: [REVENUE] })
    fireEvent.click(screen.getByLabelText("Expand"))
    expect(rowAt(0)?.textContent).toContain("Semiconductors")
    // The child row is already positioned under its parent; repeating the
    // note and ancestry there would be noise.
    expect(rowAt(1)?.textContent).toBe("datacenter revenue")
  })
})
