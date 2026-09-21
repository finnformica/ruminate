// @vitest-environment jsdom
import { createStore } from "jotai"
import { afterEach, describe, expect, it, vi } from "vitest"
import { databaseGraphAtom, databaseModeStatusAtom } from "./data/database-mode"
import { buildGraphSnapshot, docToGraph, noteDoc, rollup } from "./data/graph"
import { serialize } from "./blocks/serialize"
import { applyOps } from "./data/ops"
import { receivedSharesAtom, sharedOriginAtom } from "./data/shared-mode"
import { viewMapOf, viewsAtom } from "./data/views"
import {
  blockIndexAtom,
  githubUserAtom,
  isBootingAtom,
  signInAtom,
  signOutAtom,
  graphSnapshotAtom,
  isSignedOutAtom,
  linkDirectionsAtom,
  notesAtom,
  ownSortedNotesAtom,
  pinnedBlocksAtom,
  pinnedEntriesAtom,
  pinnedNotesAtom,
  pinnedRootsAtom,
  recentTouchesAtom,
  sampleGraphAtom,
  searchBlocksAtom,
  sharedNotesAtom,
  touchNoteAtom,
} from "./global-state"
import { RECENT_STORAGE_KEY } from "./utils/recent-notes"

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
    "  [ ] buy milk",
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
    expect(serialize(noteDoc("tasks", store.get(graphSnapshotAtom))!)).toBe(FILES["tasks.md"])

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
    // The readme's title and props come from the note node, not markdown.
    expect(readme.title).toBe("👋 Welcome to Ruminate")
    // The welcome note is pinned by a sample VIEW, not by a prop.
    expect(store.get(pinnedNotesAtom).map((note) => note.id)).toEqual(["readme"])
    expect(rollup("readme", snapshot)).toBe(serialize(noteDoc("readme", snapshot)!))

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

describe("linkDirectionsAtom", () => {
  it("follows downstream links by default, so a note reads as its outline", () => {
    const store = createStore()
    expect(store.get(linkDirectionsAtom)).toBe("downstream")
  })

  it("keeps a chosen direction, and falls back to the default on an unknown value", () => {
    const store = createStore()
    store.set(linkDirectionsAtom, "both")
    expect(store.get(linkDirectionsAtom)).toBe("both")
    store.set(linkDirectionsAtom, "upstream")
    expect(store.get(linkDirectionsAtom)).toBe("upstream")
    localStorage.setItem("link-directions", JSON.stringify("sideways"))
    expect(createStore().get(linkDirectionsAtom)).toBe("downstream")
  })
})

describe("pinnedBlocksAtom", () => {
  /** Pin a block: a VIEW rooted at it (src/data/views.ts), never a prop. */
  const pin = (store: ReturnType<typeof createStore>, ...ids: string[]) =>
    store.set(
      viewsAtom,
      viewMapOf(
        ids.map((id) => ({
          id,
          root_id: id,
          filter: null,
          sort: null,
          pinned: true,
          sort_key: null,
          updated_at: 2,
        })),
      ),
    )

  it("lists the blocks with a pinned view, each with the note it opens in, in index order", async () => {
    const { store, unsubscribe } = await signedInStore(FILES)
    store.set(viewsAtom, new Map())
    expect(store.get(pinnedBlocksAtom)).toEqual([])

    pin(store, "blk_milk")
    expect(store.get(pinnedBlocksAtom)).toMatchObject([
      { id: "blk_milk", noteId: "tasks", text: "buy milk", note: { id: "tasks" } },
    ])

    // Index order: `misc` (plants) is indexed before `tasks` (milk).
    pin(store, "blk_milk", "blk_plants")
    expect(store.get(pinnedBlocksAtom).map((block) => block.id)).toEqual(["blk_plants", "blk_milk"])

    // Unpinned, the block is gone from the list.
    pin(store, "blk_milk")
    expect(store.get(pinnedBlocksAtom).map((block) => block.id)).toEqual(["blk_milk"])
    unsubscribe()
  })

  it("opens a block held in several notes in the note it was written in", async () => {
    const { store, unsubscribe } = await signedInStore(FILES)
    // A block written in `tasks` (its `notes_id`), held by `tasks` and by
    // `misc` — which the index lists first. The row still opens in `tasks`.
    store.set(
      databaseGraphAtom,
      applyOps(
        store.get(databaseGraphAtom),
        [
          {
            op: "create",
            id: "blk_both",
            type: "text",
            text: "both",
            props: null,
            notesId: "tasks",
          },
          { op: "link", source: "misc", destination: "blk_both", sortKey: "a0" },
          { op: "link", source: "tasks", destination: "blk_both", sortKey: "a0" },
        ],
        2,
      ),
    )
    pin(store, "blk_both")
    expect(store.get(pinnedBlocksAtom)).toMatchObject([{ id: "blk_both", noteId: "tasks" }])
    unsubscribe()
  })

  it("lists a block in a note someone shared with the user — the view is theirs, not the owner's", async () => {
    const { store, unsubscribe } = await signedInStore(FILES)
    pin(store, "blk_milk")
    store.set(sharedOriginAtom, new Map([["blk_milk", "share-1"]]))
    expect(store.get(pinnedBlocksAtom).map((block) => block.id)).toEqual(["blk_milk"])
    unsubscribe()
  })

  it("leaves out a view whose root the graph no longer holds", async () => {
    const { store, unsubscribe } = await signedInStore(FILES)
    pin(store, "blk_gone")
    expect(store.get(pinnedBlocksAtom)).toEqual([])
    unsubscribe()
  })
})

describe("pinnedEntriesAtom", () => {
  const pinnedView = (id: string, sort_key: string | null) => ({
    id,
    root_id: id,
    filter: null,
    sort: null,
    pinned: true,
    sort_key,
    updated_at: 2,
  })

  it("lists the notes then the blocks until something is dragged", async () => {
    const { store, unsubscribe } = await signedInStore(FILES)
    store.set(viewsAtom, viewMapOf([pinnedView("blk_milk", null), pinnedView("tasks", null)]))
    expect(store.get(pinnedEntriesAtom).map((entry) => `${entry.kind}:${entry.id}`)).toEqual([
      "note:tasks",
      "block:blk_milk",
    ])
    unsubscribe()
  })

  it("puts keyed views in key order, blocks above notes if that is where they were dragged", async () => {
    const { store, unsubscribe } = await signedInStore(FILES)
    store.set(
      viewsAtom,
      viewMapOf([
        pinnedView("blk_milk", "a0"),
        pinnedView("tasks", "a1"),
        // Pinned after the drag: no key, so it joins the end.
        pinnedView("misc", null),
      ]),
    )
    expect(store.get(pinnedEntriesAtom).map((entry) => entry.id)).toEqual([
      "blk_milk",
      "tasks",
      "misc",
    ])
    expect(store.get(pinnedRootsAtom)).toEqual([
      { id: "blk_milk", noteId: "tasks" },
      { id: "tasks", noteId: "tasks" },
      { id: "misc", noteId: "misc" },
    ])
    unsubscribe()
  })
})

describe("sharedNotesAtom", () => {
  it("is one list of the notes shared with the user, each with its share, apart from their own", async () => {
    const { store, unsubscribe } = await signedInStore(FILES)
    expect(store.get(sharedNotesAtom)).toEqual([])
    const share = {
      id: "share-1",
      owner: { login: "octocat", name: "John Smith" },
      view: { id: "misc", rootId: "misc", filter: null, sort: null },
      permissions: ["read" as const],
      createdAt: 1,
    }
    store.set(receivedSharesAtom, [share])
    store.set(sharedOriginAtom, new Map([["misc", "share-1"]]))
    expect(store.get(sharedNotesAtom)).toMatchObject([{ note: { id: "misc" }, share }])
    expect(store.get(ownSortedNotesAtom).map((note) => note.id)).toEqual(["tasks"])
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
    expect(milk.text).toBe("buy milk")
    expect(milk.noteId).toBe("tasks")
    expect(milk.ancestors).toEqual([{ id: "blk_head", text: "Today" }])
    expect(milk.note.id).toBe("tasks")

    // A matched section is one hit; its children are walked out of the
    // graph by the results view, never embedded here.
    const [head] = store.get(searchBlocksAtom)("type:heading")
    expect(head.blockId).toBe("blk_head")
    expect(head).not.toHaveProperty("children")

    unsubscribe()
  })

  it("composes with note-level qualifiers and fuzzy text", async () => {
    const { store, unsubscribe } = await signedInStore(FILES)
    const search = store.get(searchBlocksAtom)

    expect(search("type:todo in:tasks").map((hit) => hit.blockId)).toEqual(["blk_milk"])
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

describe("touchNoteAtom", () => {
  it("notes a touch once, writes the one storage key, and coalesces bumps within a second", () => {
    localStorage.clear()
    const store = createStore()
    store.set(recentTouchesAtom, [])
    store.set(touchNoteAtom, "a", 1000)
    store.set(touchNoteAtom, "b", 2000)
    expect(store.get(recentTouchesAtom)).toEqual([
      { id: "b", at: 2000 },
      { id: "a", at: 1000 },
    ])
    expect(JSON.parse(localStorage.getItem(RECENT_STORAGE_KEY)!)).toEqual([
      { id: "b", at: 2000 },
      { id: "a", at: 1000 },
    ])
    // A selection walking through `b` within the second: nothing changes,
    // nothing is written.
    const before = store.get(recentTouchesAtom)
    localStorage.setItem(RECENT_STORAGE_KEY, "sentinel")
    store.set(touchNoteAtom, "b", 2500)
    expect(store.get(recentTouchesAtom)).toBe(before)
    expect(localStorage.getItem(RECENT_STORAGE_KEY)).toBe("sentinel")
    // A second on, it is noted again — and only one key is ever used.
    store.set(touchNoteAtom, "b", 3000)
    expect(store.get(recentTouchesAtom)[0]).toEqual({ id: "b", at: 3000 })
    expect(Object.keys(localStorage)).toEqual([RECENT_STORAGE_KEY])
  })
})
