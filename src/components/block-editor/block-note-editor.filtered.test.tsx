// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react"
import { Provider, createStore } from "jotai"
import { useMemo, useState } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { parse } from "../../blocks/parse"
import { serialize } from "../../blocks/serialize"
import type { BlockDoc } from "../../blocks/types"
import { buildGraphSnapshot, docToGraph } from "../../data/graph"
import {
  githubUserAtom,
  graphSnapshotAtom,
  isSignedOutAtom,
  sampleGraphAtom,
} from "../../global-state"
import { useNoteDoc } from "../../hooks/note-doc"
import { BlockNoteEditor } from "./block-note-editor"

/**
 * **A filtered view edits as the note does, under the keys.** The note page
 * wires `useNoteDoc` to `BlockNoteEditor`, holding the row being edited for
 * the filter (`keep`); this is that wiring, so a key pressed in a narrowed
 * view is tested through the same filter the page applies. Nothing on this
 * path may special-case a narrowed view: a Backspace that strips a to-do's
 * marker leaves a paragraph the filter would hide — and it stays, being
 * edited, for the next Backspace to merge it up.
 */

afterEach(cleanup)

const NOTE_ID = "blk_note00000"
const EMPTY_DOC: BlockDoc = { props: null, rootBlockIds: [], blocks: {} }

async function signedOutStore(markdown: string) {
  const store = createStore()
  const unsubscribe = store.sub(githubUserAtom, () => {})
  await vi.waitFor(() => {
    expect(store.get(isSignedOutAtom)).toBe(true)
  })
  const { nodes, links } = docToGraph(NOTE_ID, serialize(parse(markdown)), 1, { title: "Note" })
  store.set(sampleGraphAtom, buildGraphSnapshot(nodes, links))
  return { store, unsubscribe }
}

/** The note page's wiring of a narrowed view, and nothing else of it. */
function FilteredNote({ filter }: { filter: string }) {
  const [editing, setEditing] = useState<string | null>(null)
  const keep = useMemo(() => (editing === null ? undefined : new Set([editing])), [editing])
  const { doc, context, setDoc } = useNoteDoc({
    noteId: NOTE_ID,
    defaultDoc: EMPTY_DOC,
    filter,
    keep,
  })
  return (
    <BlockNoteEditor
      noteId={NOTE_ID}
      doc={doc}
      onChange={setDoc}
      context={context}
      onEditingChange={setEditing}
      starter={filter === ""}
    />
  )
}

const bodies = (container: HTMLElement) =>
  Array.from(container.querySelectorAll<HTMLElement>('[data-testid="block-body"]')).map(
    (el) => el.textContent,
  )
const noteLines = (store: ReturnType<typeof createStore>) => {
  const graph = store.get(graphSnapshotAtom)
  return Array.from(graph.nodes.values())
    .filter((node) => node.id !== NOTE_ID)
    .map((node) => `${node.type}:${node.text}`)
    .sort()
}

describe("Backspace in a filtered view", () => {
  it("strips the marker, keeps the row under the caret, then merges it up — as in the note", async () => {
    const { store, unsubscribe } = await signedOutStore(`- Shopping
  - [ ] milk
  - [ ] 
  - bread
`)
    const { container } = render(
      <Provider store={store}>
        <FilteredNote filter="type:todo" />
      </Provider>,
    )
    // The filter shows the two to-dos under their heading; `bread` is hidden.
    expect(bodies(container)).toEqual(["Shopping", "milk", ""])

    // Edit the empty to-do: down to it from the highlighted first row, Enter.
    const root = container.querySelector<HTMLElement>('[tabindex="-1"]')!
    fireEvent.keyDown(root, { key: "ArrowDown" })
    fireEvent.keyDown(root, { key: "ArrowDown" })
    fireEvent.keyDown(root, { key: "Enter" })
    let textarea = container.querySelector("textarea")!
    expect(textarea.value).toBe("")

    // Backspace at its start strips the marker: a paragraph now, which the
    // filter would hide — and which stays, being edited.
    fireEvent.keyDown(textarea, { key: "Backspace" })
    textarea = container.querySelector("textarea")!
    expect(textarea.value).toBe("")
    expect(noteLines(store)).toContain("text:")
    expect(container.querySelectorAll("textarea")).toHaveLength(1)

    // Backspace again merges it up: the row goes, and `milk` is edited at
    // its end, as it would be with the filter cleared.
    fireEvent.keyDown(textarea, { key: "Backspace" })
    textarea = container.querySelector("textarea")!
    expect(textarea.value).toBe("milk")
    expect(textarea.selectionStart).toBe(4)
    expect(noteLines(store)).toEqual(["todo:milk", "ul:Shopping", "ul:bread"])
    expect(bodies(container)).toEqual(["Shopping"])
    unsubscribe()
  })

  it("a to-do made a paragraph stays until the editing leaves it", async () => {
    const { store, unsubscribe } = await signedOutStore(`- [ ] milk
- [ ] eggs
`)
    const { container } = render(
      <Provider store={store}>
        <FilteredNote filter="type:todo" />
      </Provider>,
    )
    const root = container.querySelector<HTMLElement>('[tabindex="-1"]')!
    fireEvent.keyDown(root, { key: "Enter" }) // edit `milk`
    let textarea = container.querySelector("textarea")!
    textarea.setSelectionRange(0, 0)
    fireEvent.keyDown(textarea, { key: "Backspace" }) // the marker goes
    expect(noteLines(store)).toEqual(["text:milk", "todo:eggs"])
    textarea = container.querySelector("textarea")!
    expect(textarea.value).toBe("milk")
    // Leaving the row, the filter has its say.
    fireEvent.keyDown(textarea, { key: "Escape" })
    expect(bodies(container)).toEqual(["eggs"])
    unsubscribe()
  })
})
