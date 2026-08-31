// @vitest-environment jsdom
import { createStore } from "jotai"
import { afterEach, describe, expect, it, vi } from "vitest"
import { databaseFilesAtom } from "./data/database-mode"
import {
  blockIndexAtom,
  globalStateMachineAtom,
  isSignedOutAtom,
  searchBlocksAtom,
} from "./global-state"

/**
 * The unchecked-boxes flow end-to-end at the atom level: sign the machine in,
 * feed the database files atom a corpus, and `type:todo` resolves to block
 * hits through `markdownFilesAtom` → `notesAtom` → `blockIndexAtom` →
 * `searchBlocksAtom` — the exact derivation chain the app runs.
 */

/** Markdown from lines, with a trailing newline (the canonical file shape). */
const md = (...lines: string[]) => lines.join("\n") + "\n"

const FILES = {
  "tasks.md": md(
    "# Today",
    "  id:: blk_head",
    "  [ ] buy milk #work",
    "    id:: blk_milk",
    "  [x] ship it",
    "    id:: blk_ship",
  ),
  "misc.md": md("[ ] water plants", "  id:: blk_plants", "- a bullet", "  id:: blk_bullet"),
}

async function signedInStore(files: Record<string, string>) {
  const store = createStore()
  // Keep the machine mounted so its resolve-user service runs and events land.
  const unsubscribe = store.sub(globalStateMachineAtom, () => {})
  // No stored identity in the test environment → the machine settles signed
  // out, from where SIGN_IN is accepted.
  await vi.waitFor(() => {
    expect(store.get(isSignedOutAtom)).toBe(true)
  })
  store.set(globalStateMachineAtom, {
    type: "SIGN_IN",
    githubUser: { token: "t", login: "finn", name: "Finn", email: "finn@example.com" },
  })
  store.set(databaseFilesAtom, files)
  return { store, unsubscribe }
}

afterEach(() => {
  localStorage.clear()
})

describe("block search atoms", () => {
  it("resolves type:todo to every unchecked checkbox in the corpus", async () => {
    const { store, unsubscribe } = await signedInStore(FILES)

    const hits = store.get(searchBlocksAtom)("type:todo")
    // Grouped by note in `sortedNotesAtom` order; with no `updated_at` on
    // either note that is alphabetical by name — "misc" before "Today"
    // (`tasks.md`'s h1). Ids are opaque now, so they no longer order anything.
    expect(hits.map((hit) => hit.blockId)).toEqual(["blk_plants", "blk_milk"])

    const milk = hits.find((hit) => hit.blockId === "blk_milk") as (typeof hits)[number]
    // Everything a results row needs, without re-deriving: text, breadcrumb
    // ancestry, and the note-route + ?block= navigation target.
    expect(milk.text).toBe("buy milk #work")
    expect(milk.noteId).toBe("tasks")
    expect(milk.ancestors).toEqual([{ id: "blk_head", text: "Today" }])
    expect(milk.note.tags).toEqual(["work"])

    // A matched section carries only its has-downstream count; the children
    // themselves are resolved (and cached) on expand.
    const [head] = store.get(searchBlocksAtom)("type:heading")
    expect(head.blockId).toBe("blk_head")
    expect(head).not.toHaveProperty("children")
    expect(head.childCount).toBe(2)
    const getChildren = store.get(blockIndexAtom).getChildren
    expect(getChildren(head).map((child) => child.blockId)).toEqual(["blk_milk", "blk_ship"])
    expect(getChildren(head)).toBe(getChildren(head))

    unsubscribe()
  })

  it("composes with note-level qualifiers and fuzzy text", async () => {
    const { store, unsubscribe } = await signedInStore(FILES)
    const search = store.get(searchBlocksAtom)

    expect(search("type:todo tag:work").map((hit) => hit.blockId)).toEqual(["blk_milk"])
    expect(search("type:todo plants").map((hit) => hit.blockId)).toEqual(["blk_plants"])
    expect(search("type:done").map((hit) => hit.blockId)).toEqual(["blk_ship"])

    unsubscribe()
  })

  it("reflects corpus edits: checking a box removes it from type:todo", async () => {
    const { store, unsubscribe } = await signedInStore(FILES)
    expect(store.get(searchBlocksAtom)("type:todo")).toHaveLength(2)

    store.set(databaseFilesAtom, {
      ...FILES,
      "misc.md": md("[x] water plants", "  id:: blk_plants"),
    })
    expect(
      store
        .get(searchBlocksAtom)("type:todo")
        .map((hit) => hit.blockId),
    ).toEqual(["blk_milk"])

    unsubscribe()
  })

  it("indexes every block with its type", async () => {
    const { store, unsubscribe } = await signedInStore(FILES)

    const index = store.get(blockIndexAtom)
    const byId = new Map(index.hits.map((hit) => [hit.blockId, hit.type]))
    expect(byId.get("blk_head")).toBe("h1")
    expect(byId.get("blk_milk")).toBe("todo")
    expect(byId.get("blk_ship")).toBe("done")
    expect(byId.get("blk_bullet")).toBe("bullet")

    unsubscribe()
  })
})
