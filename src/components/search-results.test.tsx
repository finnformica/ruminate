// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { useBlockResultTree } from "../hooks/block-result-tree"
import { useListKeyboardNav } from "../hooks/list-keyboard-nav"
import type { BlockType } from "../blocks/types"
import type { Note } from "../schema"
import type { BlockHit } from "../utils/block-search"
import type { BlockSearchSource } from "../utils/block-search-source"
import { SearchResults, blockHitNavigation } from "./search-results"

afterEach(cleanup)

const NOTE: Note = {
  id: "research",
  type: "note",
  displayName: "research",
  props: {},
  title: "research",
  url: null,
  alias: null,
  pinned: false,
  updatedAt: null,
  dates: [],
  tags: [],
  tasks: [],
  headings: [],
  text: "",
}

function hit(
  blockId: string,
  text: string,
  type: BlockType,
  ancestors: { id: string; text: string }[] = [],
  childCount = 0,
): BlockHit {
  return { blockId, noteId: NOTE.id, text, type, olNumber: 1, ancestors, childCount, note: NOTE }
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

const H100 = hit("blk_h100", "H100 supply", "ul", [], 1)
const H100_DETAIL = hit("blk_detail", "80GB HBM3", "text")
const REVENUE = hit("blk_rev", "datacenter revenue", "ul")

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

  it("draws each block exactly as the editor does — the same row component", () => {
    renderResults([NVIDIA, MILK, SHIP])
    // A heading hangs the editor's `#` in the marker slot, at its scale.
    expect(rowAt(0)?.querySelector('[data-testid="heading-hash"]')).not.toBeNull()
    expect(rowAt(0)?.querySelector('[data-testid="block-body"]')?.className).toContain("font-bold")
    // Todos are the editor's checkboxes (read-only here); a done one is
    // struck through by the same rule.
    const boxes = document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
    expect(boxes).toHaveLength(2)
    expect(boxes[0].checked).toBe(false)
    expect(boxes[0].disabled).toBe(true)
    expect(boxes[1].checked).toBe(true)
    expect(rowAt(2)?.querySelector('[data-testid="block-body"]')?.className).toContain(
      "line-through",
    )
    // Rows are occurrences: the editor's own DOM hooks are there.
    expect(rowAt(0)?.querySelector("[data-occurrence]")?.getAttribute("data-block-row")).toBe(
      "blk_nvidia",
    )
  })

  it("draws the collapse chevron only for blocks with something downstream, in the marker slot", () => {
    renderResults([NVIDIA, MILK])
    const toggles = screen.getAllByLabelText("Expand")
    expect(toggles).toHaveLength(1)
    expect(rowAt(0)?.contains(toggles[0])).toBe(true)
    // Collapsed by default, so the chevron is pinned visible.
    expect(toggles[0].className).toContain("block-toggle-pinned")
  })

  it("the keyboard highlight is the editor's selection surface", () => {
    renderResults([NVIDIA, MILK])
    arrow("ArrowDown")
    expect(rowAt(0)?.querySelector(".block-highlight")).not.toBeNull()
    expect(rowAt(1)?.querySelector(".block-highlight")).toBeNull()
    arrow("ArrowDown")
    expect(rowAt(0)?.querySelector(".block-highlight")).toBeNull()
    expect(rowAt(1)?.querySelector(".block-highlight")).not.toBeNull()
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
    // Children are rows of their own, indented under the hit and hanging
    // from its guide line, as in the note.
    expect(rowAt(1)?.textContent).toContain("H100 supply")
    expect(rowAt(1)?.querySelector("[data-guide]")).not.toBeNull()
    expect(rowAt(1)?.querySelector<HTMLElement>("[data-occurrence]")?.style.paddingLeft).not.toBe(
      "0px",
    )

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
    expect(rowAt(0)?.querySelector('[data-testid="result-breadcrumb"]')?.textContent).toContain(
      "Semiconductors",
    )
    // The child row is already positioned under its parent; repeating the
    // note and ancestry there would be noise.
    expect(rowAt(1)?.querySelector('[data-testid="result-breadcrumb"]')).toBeNull()
    expect(rowAt(1)?.querySelector('[data-testid="block-body"]')?.textContent).toBe(
      "datacenter revenue",
    )
  })
})
