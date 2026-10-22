// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react"
import { useState } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { parse } from "../../blocks/parse"
import type { BlockDoc } from "../../blocks/types"
import {
  currentFrame,
  goAbove,
  goTo,
  goVia,
  keyOfPath,
  paneOf,
  pathOfKey,
  popFrame,
  popTo,
  type FocusMove,
  type Pane,
} from "../../data/panes"
import { FocusTrail } from "../focus-trail"
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
function PaneHost({
  doc,
  onStack,
  start = paneOf("n"),
}: {
  doc: BlockDoc
  onStack: (pane: Pane) => void
  /** The stack the pane opens with (a block opened from Views: one frame). */
  start?: Pane
}) {
  const [pane, setPane] = useState<Pane>(start)
  const [landing, setLanding] = useState<string | null>(null)
  const apply = (move: FocusMove | null) => {
    if (!move) return
    setPane(move.pane)
    // The page's step: a frame's path is the editor's occurrence key.
    setLanding(move.landing ? keyOfPath(move.landing) : null)
    onStack(move.pane)
  }
  return (
    <BlockEditor
      doc={doc}
      onChange={() => {}}
      noteId="n"
      focusRootId={currentFrame(pane).root}
      onFocusNavigate={(id, selected) =>
        apply(goTo(pane, { noteId: "n", root: id }, selected ? pathOfKey(selected) : null))
      }
      onFocusBack={popFrame(pane) ? () => apply(popFrame(pane)) : undefined}
      // The page's trail, wired as the note page wires it.
      focusTrail={
        <FocusTrail
          frames={pane.frames}
          onPopTo={(at) => apply(popTo(pane, at))}
          onGoVia={(at, target) => apply(goVia(pane, at, target))}
          onGoAbove={(target) => apply(goAbove(pane, target))}
        />
      }
      landing={landing}
    />
  )
}

function setup(startOn?: string) {
  const doc = parse(OUTLINE)
  const id = (text: string) => Object.values(doc.blocks).find((b) => b.text === text)!.id
  const stacks: Pane[] = []
  const { container, getByText } = render(
    <PaneHost
      doc={doc}
      onStack={(pane) => stacks.push(pane)}
      start={startOn ? paneOf("n", id(startOn)) : undefined}
    />,
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
      { noteId: "n", root: null, selected: [id("C")] },
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

describe("the breadcrumb (Finn's bug: a crumb up the stack pushed a frame)", () => {
  /** The trail's frame crumbs that are buttons, bottom first. */
  const frameCrumbs = (container: HTMLElement) =>
    Array.from(container.querySelectorAll<HTMLElement>('button[data-crumb="frame"]'))

  it("pops to an earlier frame, as Shift+F that many times does", () => {
    const { id, stacks, press, select, selected } = setup()
    const { container } = { container: document.body }
    select("C")
    press("f")
    select("C1")
    press("f")
    select("C1a")
    press("f")
    expect(stacks.at(-1)!.frames.map((frame) => frame.root)).toEqual([
      null,
      id("C"),
      id("C1"),
      id("C1a"),
    ])
    // Click the frame crumb for C: the stack is n › C, with C1 selected.
    fireEvent.click(frameCrumbs(container)[1])
    expect(stacks.at(-1)!.frames.map((frame) => frame.root)).toEqual([null, id("C")])
    expect(selected()).toBe(`${id("C")}/${id("C1")}`)
    // And the note's crumb: the bottom frame, with C selected.
    fireEvent.click(frameCrumbs(container)[0])
    expect(stacks.at(-1)!.frames).toEqual([{ noteId: "n", root: null, selected: null }])
    expect(selected()).toBe(id("C"))
  })
})

describe("a crumb before the stack's first frame (Finn's bug)", () => {
  it("does not push the note above a stack opened on a block", () => {
    const { id, stacks, press, select } = setup("C")
    select("C1")
    press("f")
    expect(stacks.at(-1)!.frames.map((frame) => frame.root)).toEqual([id("C"), id("C1")])
    // The trail leads with the note: a path crumb, before the first frame.
    const note = document.body.querySelector<HTMLElement>(
      'nav[data-testid="focus-breadcrumb"] button[data-crumb="path"]',
    )!
    fireEvent.click(note)
    // The note alone, not C › C1 › note.
    expect(stacks.at(-1)!.frames).toEqual([{ noteId: "n", root: null, selected: null }])
  })
})
