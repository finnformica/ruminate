// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react"
import { useState } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { parse } from "../../blocks/parse"
import type { BlockDoc } from "../../blocks/types"
import { currentFrame, goTo, paneOf, popFrame, type FocusMove, type Pane } from "../../data/panes"
import { BlockEditor } from "./block-editor"

/**
 * The focus stack through the editor (src/data/panes.ts, docs/split-view.md):
 * a focus pushes a frame with the row selected beneath it, Shift+F pops one,
 * and the view popped back to has that row selected and its folds as they
 * were.
 */

Element.prototype.scrollIntoView = vi.fn()

afterEach(cleanup)

const OUTLINE = ["- A", "  - A1", "- B", "  - B1", "- C", "  - C1", "    - C1a"].join("\n")

/** A host that keeps one pane's stack, as the note page does. */
function PaneHost({ doc, onStack }: { doc: BlockDoc; onStack: (pane: Pane) => void }) {
  const [pane, setPane] = useState<Pane>(() => paneOf("n"))
  const [landing, setLanding] = useState<string | null>(null)
  const apply = (move: FocusMove | null) => {
    if (!move) return
    setPane(move.pane)
    setLanding(move.landing)
    onStack(move.pane)
  }
  return (
    <BlockEditor
      doc={doc}
      onChange={() => {}}
      noteId="n"
      focusRootId={currentFrame(pane).root}
      onFocusNavigate={(id, selected) => apply(goTo(pane, { noteId: "n", root: id }, selected))}
      onFocusBack={popFrame(pane) ? () => apply(popFrame(pane)) : undefined}
      landing={landing}
    />
  )
}

function setup() {
  const doc = parse(OUTLINE)
  const id = (text: string) => Object.values(doc.blocks).find((b) => b.text === text)!.id
  const stacks: Pane[] = []
  const { container, getByText } = render(
    <PaneHost doc={doc} onStack={(pane) => stacks.push(pane)} />,
  )
  const editor = container.querySelector<HTMLElement>("[data-block-editor]")!
  const press = (key: string, mods: { shiftKey?: boolean; metaKey?: boolean } = {}) =>
    fireEvent.keyDown(editor, { key, ...mods })
  const selected = () =>
    container
      .querySelector(".block-highlight")
      ?.closest("[data-occurrence]")
      ?.getAttribute("data-occurrence")
  const shows = (text: string) => container.querySelector(`[data-block-row="${id(text)}"]`) !== null
  return {
    id,
    stacks,
    press,
    selected,
    shows,
    select: (text: string) => fireEvent.click(getByText(text)),
  }
}

describe("the focus stack in the editor", () => {
  it("pushes a frame on f, recording the row selected where the reader was", () => {
    const { id, stacks, press, select } = setup()
    select("C")
    press("f")
    expect(stacks.at(-1)!.frames).toEqual([
      { noteId: "n", root: null, selected: id("C") },
      { noteId: "n", root: id("C"), selected: null },
    ])
  })

  it("pops on Shift+F back to the view before, with its row selected and its folds kept", () => {
    const { id, press, select, selected, shows } = setup()
    // Fold A in the note, then go into C and on into C1.
    select("A")
    press(" ")
    expect(shows("A1")).toBe(false)
    select("C")
    press("f")
    select("C1")
    press("f")
    expect(shows("A")).toBe(false)

    press("F", { shiftKey: true })
    expect(selected()).toBe(`${id("C")}/${id("C1")}`)
    press("F", { shiftKey: true })
    // The whole note again: C selected, A still folded.
    expect(selected()).toBe(id("C"))
    expect(shows("A")).toBe(true)
    expect(shows("A1")).toBe(false)
  })

  it("restores the recorded row, not the block left, when it pops past a frame", () => {
    const { id, stacks, press, select, selected } = setup()
    select("C")
    press("f")
    select("C1")
    press("f")
    // ⌘⇧. goes to the whole note, which is the bottom frame: a pop to it.
    // The block left is C1, but the row selected there was C.
    press(".", { metaKey: true, shiftKey: true })
    expect(stacks.at(-1)!.frames).toEqual([{ noteId: "n", root: null, selected: null }])
    expect(selected()).toBe(id("C"))
  })
})
