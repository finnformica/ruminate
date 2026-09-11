// @vitest-environment jsdom
import { createStore } from "jotai"
import { afterEach, describe, expect, it, vi } from "vitest"
import { databaseGraphAtom, databaseModeStatusAtom } from "./data/database-mode"
import { buildGraphSnapshot, docToGraph, pageDoc, rollup } from "./data/graph"
import { serialize } from "./blocks/serialize"
import { applyOps } from "./data/ops"
import {
  blockIndexAtom,
  githubUserAtom,
  isBootingAtom,
  signInAtom,
  signOutAtom,
  graphSnapshotAtom,
  isSignedOutAtom,
  notesAtom,
  sampleGraphAtom,
  searchBlocksAtom,
} from "./global-state"

/**
 * The unchecked-boxes flow end-to-end at the atom level: sign in,
 * feed the database graph atom a corpus, and `type:todo` resolves to block
 * hits through `graphSnapshotAtom` → `notesAtom` → `blockIndexAtom` →
 * `searchBlocksAtom` — the exact derivation chain the app runs.
 */

/** A graph from `<id>.md` → markdown, as a full pull would leave it. */
function graphOf(files: Record<string, string>) {
  const nodes = []
  const links = []
  for (const [path, markdown] of Object.entries(files)) {
    const g = docToGraph(path.replace(/\.md$/, ""), markdown, 1)
    nodes.push(...g.nodes)
    links.push(...g.links)
  }
  return buildGraphSnapshot(nodes, links)
}

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
  // Mounting the identity atom resolves the stored session.
  const unsubscribe = store.sub(githubUserAtom, () => {})
  // No stored identity in the test environment → signed out.
  await vi.waitFor(() => {
    expect(store.get(isSignedOutAtom)).toBe(true)
  })
  store.set(signInAtom, { token: "t", login: "finn", name: "Finn", email: "finn@example.com" })
  store.set(databaseGraphAtom, graphOf(files))
  return { store, unsubscribe }
}

afterEach(() => {
  localStorage.clear()
})

describe("graphSnapshotAtom", () => {
  it("signed in, serves the database graph", async () => {
    const { store, unsubscribe } = await signedInStore(FILES)
    const { nodes, links } = docToGraph("tasks", FILES["tasks.md"], 1)
    const snapshot = buildGraphSnapshot(nodes, links)
    store.set(databaseGraphAtom, snapshot)

    expect(store.get(graphSnapshotAtom)).toBe(snapshot)
    expect(serialize(pageDoc("tasks", store.get(graphSnapshotAtom))!)).toBe(FILES["tasks.md"])

    unsubscribe()
  })

  it("signed out, serves the sample graph, and notes derive from it", async () => {
    const store = createStore()
    const unsubscribe = store.sub(githubUserAtom, () => {})
    await vi.waitFor(() => {
      expect(store.get(isSignedOutAtom)).toBe(true)
    })

    const snapshot = store.get(graphSnapshotAtom)
    expect(snapshot).toBe(store.get(sampleGraphAtom))
    const notes = store.get(notesAtom)
    const readme = notes.get("readme")!
    // The readme's title and props come from the page node, not markdown.
    expect(readme.title).toBe("👋 Welcome to Ruminate")
    expect(readme.pinned).toBe(true)
    expect(readme.tags).toEqual(["ruminate", "ruminate/welcome"])
    expect(rollup("readme", snapshot)).toBe(serialize(pageDoc("readme", snapshot)!))

    // An edit signed out applies to the sample graph in memory, and the
    // note follows.
    store.set(
      sampleGraphAtom,
      applyOps(snapshot, [{ op: "setText", id: "blk_welcome001", text: "edited" }], 1),
    )
    expect(store.get(notesAtom).get("readme")!.text).toContain("edited")

    unsubscribe()
  })
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

    store.set(
      databaseGraphAtom,
      graphOf({ ...FILES, "misc.md": md("[x] water plants", "  id:: blk_plants") }),
    )
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
    expect(byId.get("blk_bullet")).toBe("ul")

    unsubscribe()
  })
})

describe("isBootingAtom", () => {
  const status = (patch: Partial<Parameters<typeof databaseModeStatusAtom.write>[2]>) => ({
    status: "ready" as const,
    pull: "idle" as const,
    lastPullAt: null,
    lastPullError: null,
    emptyOffline: false,
    ...patch,
  })

  it("is true only while the notes are still on their way", () => {
    const store = createStore()
    // Identity unresolved: booting.
    expect(store.get(isBootingAtom)).toBe(true)
    // Signed out: the sample notes are always there.
    store.set(signOutAtom)
    expect(store.get(isBootingAtom)).toBe(false)
    // Signed in, store not started / opening: booting.
    store.set(signInAtom, { token: "t", login: "finn", name: "Finn", email: "finn@example.com" })
    expect(store.get(isBootingAtom)).toBe(true)
    store.set(databaseModeStatusAtom, status({ status: "opening" }))
    expect(store.get(isBootingAtom)).toBe(true)
    // Ready with nothing local while the first pull is in flight: booting.
    store.set(databaseModeStatusAtom, status({ pull: "pulling" }))
    expect(store.get(isBootingAtom)).toBe(true)
    // …until notes land.
    store.set(databaseGraphAtom, graphOf({ "a.md": md("# A", "hello") }))
    expect(store.get(isBootingAtom)).toBe(false)
    // A device that has pulled before shows what it has, even while pulling.
    store.set(databaseGraphAtom, graphOf({}))
    store.set(databaseModeStatusAtom, status({ pull: "pulling", lastPullAt: 1 }))
    expect(store.get(isBootingAtom)).toBe(false)
    // A failed store, or a first pull that could not reach the replica, says
    // what it is rather than waiting.
    store.set(databaseModeStatusAtom, status({ status: "error" }))
    expect(store.get(isBootingAtom)).toBe(false)
    store.set(databaseModeStatusAtom, status({ pull: "error", emptyOffline: true }))
    expect(store.get(isBootingAtom)).toBe(false)
  })
})
