import { describe, expect, test } from "vitest"
import { buildGraphSnapshot, docToGraph, type GraphSnapshot } from "../data/graph"
import type { Note } from "../schema"
import {
  blockKey,
  createBlockIndexer,
  createChildResolver,
  hasBlockTypeFilter,
  indexNoteBlocks,
  isBlockTypeFilter,
  notesFromBlockHits,
  searchBlocks,
  type BlockAncestor,
  type BlockHit,
} from "./block-search"
import type { BlockType } from "../blocks/types"
import { parseQuery } from "./search"

/** A note plus the markdown its page holds — the graph the tests index. */
type Fixture = Note & { content: string }

function makeNote(overrides: Partial<Fixture> = {}): Fixture {
  return {
    id: "1",
    content: "",
    type: "note",
    displayName: "",
    props: {},
    title: "",
    url: null,
    alias: null,
    pinned: false,
    updatedAt: null,
    dates: [],
    tags: [],
    tasks: [],
    headings: [],
    text: "",
    ...overrides,
  }
}

/** The graph holding every fixture's page. */
function snapshotFor(notes: Fixture[]): GraphSnapshot {
  const nodes = []
  const links = []
  for (const note of notes) {
    const g = docToGraph(note.id, note.content, 1)
    nodes.push(...g.nodes)
    links.push(...g.links)
  }
  return buildGraphSnapshot(nodes, links)
}

/** Markdown from lines, with a trailing newline (the canonical file shape). */
const md = (...lines: string[]) => lines.join("\n") + "\n"

// `id::` lines pin block ids so hits are deterministic (parse mints random
// ids otherwise). The two-space indent matches the serializer's output.
const TASKS_NOTE = makeNote({
  id: "tasks",
  updatedAt: 200,
  tags: ["work"],
  content: md(
    "# Today",
    "  id:: blk_head",
    "  [ ] buy milk",
    "    id:: blk_milk",
    "  [x] ship it",
    "    id:: blk_ship",
  ),
})

const MISC_NOTE = makeNote({
  id: "misc",
  updatedAt: 100,
  tags: ["home"],
  content: md(
    "[ ] water plants",
    "  id:: blk_plants",
    "- a bullet",
    "  id:: blk_bullet",
    "1. an ordered item",
    "  id:: blk_ordered",
    "> a quote",
    "  id:: blk_quote",
    "plain paragraph",
    "  id:: blk_plain",
  ),
})

function buildIndex(notes: Fixture[]) {
  return createBlockIndexer()(notes, snapshotFor(notes))
}

function run(query: string, notes: Fixture[] = [TASKS_NOTE, MISC_NOTE]) {
  return searchBlocks(parseQuery(query), buildIndex(notes))
}

const ids = (hits: BlockHit[]) => hits.map((hit) => hit.blockId)

describe("type mapping", () => {
  const types = (content: string): [string, BlockType][] =>
    indexNoteBlocks(makeNote({ content }), snapshotFor([makeNote({ content })])).hits.map((hit) => [
      hit.text,
      hit.type,
    ])

  test("types every block by its stored type — the registry's vocabulary", () => {
    // Every heading marker is one heading type: size comes from outline depth
    // (docs/graph-schema-v2.md), and that is what the graph stores.
    expect(types(md("# one", "## two", "### three", "###### six"))).toEqual([
      ["one", "h1"],
      ["two", "h1"],
      ["three", "h1"],
      ["six", "h1"],
    ])
    expect(types(md("[ ] open", "[] shorthand", "[x] closed", "[X] closed too"))).toEqual([
      ["open", "todo"],
      ["shorthand", "todo"],
      ["closed", "done"],
      ["closed too", "done"],
    ])
    expect(types(md("- dash", "* star", "1. first", "2) second"))).toEqual([
      ["dash", "ul"],
      ["star", "ul"],
      ["first", "ol"],
      ["second", "ol"],
    ])
    expect(types(md("> quoted", "no marker"))).toEqual([
      ["quoted", "quote"],
      ["no marker", "text"],
    ])
  })

  test("a fence is one code block; nothing inside it is a todo or a heading", () => {
    expect(types(md("```js", "[ ] in a fence", "# also code", "```", "[ ] after"))).toEqual([
      ["[ ] in a fence\n# also code", "code"],
      ["after", "todo"],
    ])
  })

  test("fenced lines stored as text before code blocks existed still read as code", () => {
    // Old notes hold the fence and its lines as text blocks; the index keeps
    // typing them as code so `type:code` still finds them.
    const note = makeNote({ id: "old" })
    const row = (id: string, text: string) => ({
      id,
      type: "text",
      text,
      props: null,
      updated_at: 1,
    })
    const link = (destination_id: string, sort_key: string) => ({
      source_id: "old",
      destination_id,
      kind: "child",
      sort_key,
      updated_at: 1,
    })
    const snapshot = buildGraphSnapshot(
      [
        { id: "old", type: "page", text: "old", props: null, updated_at: 1 },
        row("f", "```"),
        row("l", "[ ] not a todo"),
        row("g", "```"),
        row("after", "after"),
      ],
      [link("f", "a0"), link("l", "a1"), link("g", "a2"), link("after", "a3")],
    )
    expect(indexNoteBlocks(note, snapshot).hits.map((hit) => [hit.blockId, hit.type])).toEqual([
      ["f", "code"],
      ["l", "code"],
      ["g", "code"],
      ["after", "text"],
    ])
  })
})

describe("block hits", () => {
  test("carry ids, note id, marker-free text, and the containing note", () => {
    const [hit] = run("type:h1")
    expect(hit.blockId).toBe("blk_head")
    expect(hit.noteId).toBe("tasks")
    expect(hit.text).toBe("Today")
    expect(hit.type).toBe("h1")
    expect(hit.note).toBe(TASKS_NOTE)
  })

  test("carry ancestry under headings and nested lists, outermost first", () => {
    const note = makeNote({
      id: "n",
      content: md(
        "# Setup",
        "  id:: blk_setup",
        "  - api",
        "    id:: blk_api",
        "    [ ] add auth",
        "      id:: blk_auth",
      ),
    })
    const { hits } = indexNoteBlocks(note, snapshotFor([note]))
    const auth = hits.find((hit) => hit.blockId === "blk_auth")
    const expected: BlockAncestor[] = [
      { id: "blk_setup", text: "Setup" },
      { id: "blk_api", text: "api" },
    ]
    expect(auth?.ancestors).toEqual(expected)
    const api = hits.find((hit) => hit.blockId === "blk_api")
    expect(api?.ancestors).toEqual([{ id: "blk_setup", text: "Setup" }])
    expect(hits.find((hit) => hit.blockId === "blk_setup")?.ancestors).toEqual([])
  })

  test("never embed their children — only the has-downstream count", () => {
    const [head] = run("type:h1")
    expect(head.childCount).toBe(2)
    expect(head).not.toHaveProperty("children")
    // Children are context, not matches: the heading is the only hit.
    expect(ids(run("type:h1"))).toEqual(["blk_head"])
  })

  test("carry an ordered item's number in its run", () => {
    const note = makeNote({
      id: "n",
      content: md("1. one", "  id:: blk_1", "2. two", "  id:: blk_2", "- dash", "  id:: blk_d"),
    })
    const { hits } = indexNoteBlocks(note, snapshotFor([note]))
    expect(hits.map((hit) => [hit.blockId, hit.olNumber])).toEqual([
      ["blk_1", 1],
      ["blk_2", 2],
      ["blk_d", 1],
    ])
  })

  test("a leaf block reports no downstream", () => {
    const [milk] = run("type:todo")
    expect(milk.blockId).toBe("blk_milk")
    expect(milk.childCount).toBe(0)
  })

  test("childCount is the block's true child count, however many", () => {
    const lines = ["# Big", "  id:: blk_big"]
    for (let i = 0; i < 25; i++) lines.push(`  - child ${i}`, `    id:: blk_c${i}`)
    const bigNote = makeNote({ content: md(...lines) })
    const [big] = indexNoteBlocks(bigNote, snapshotFor([bigNote])).hits
    expect(big.blockId).toBe("blk_big")
    expect(big.childCount).toBe(25)
  })
})

describe("lazy child resolution", () => {
  test("resolves a hit's direct children, in document order", () => {
    const index = buildIndex([TASKS_NOTE, MISC_NOTE])
    const [head] = searchBlocks(parseQuery("type:h1"), index)
    expect(ids(index.getChildren(head))).toEqual(["blk_milk", "blk_ship"])
    expect(index.getChildren(head).map((hit) => [hit.text, hit.type])).toEqual([
      ["buy milk", "todo"],
      ["ship it", "done"],
    ])
  })

  test("a leaf resolves to nothing", () => {
    const index = buildIndex([TASKS_NOTE])
    const [milk] = searchBlocks(parseQuery("type:todo"), index)
    expect(index.getChildren(milk)).toEqual([])
  })

  test("expanding a child resolves the next level the same way", () => {
    const note = makeNote({
      id: "n",
      content: md(
        "# Setup",
        "  id:: blk_setup",
        "  - api",
        "    id:: blk_api",
        "    [ ] add auth",
        "      id:: blk_auth",
      ),
    })
    const index = buildIndex([note])
    const [setup] = searchBlocks(parseQuery("type:h1"), index)
    const [api] = index.getChildren(setup)
    expect(api.blockId).toBe("blk_api")
    expect(api.childCount).toBe(1)
    expect(ids(index.getChildren(api))).toEqual(["blk_auth"])
  })

  test("resolution is memoized — a second expand does no work", () => {
    let calls = 0
    const resolve = createChildResolver((hit) => {
      calls++
      return [{ ...hit, blockId: `${hit.blockId}_child` }]
    })
    const index = buildIndex([TASKS_NOTE])
    const [head] = searchBlocks(parseQuery("type:h1"), index)
    const first = resolve(head)
    expect(calls).toBe(1)
    // Same block again: cached, down to the array identity.
    expect(resolve(head)).toBe(first)
    expect(calls).toBe(1)
    // A different block still resolves.
    resolve(index.hits[1])
    expect(calls).toBe(2)
  })

  test("the index's own resolver caches too", () => {
    const index = buildIndex([TASKS_NOTE])
    const [head] = searchBlocks(parseQuery("type:h1"), index)
    expect(index.getChildren(head)).toBe(index.getChildren(head))
  })

  test("a block reached from two pages is one node: both hits resolve the same children", () => {
    // In the graph an id names ONE block; a second page naming it links the
    // same node, so every child it has is there from either page.
    const a = makeNote({
      id: "a",
      content: md("# Shared", "  id:: blk_dup", "  - only in a", "    id:: blk_a1"),
    })
    const b = makeNote({
      id: "b",
      content: md(
        "# Shared",
        "  id:: blk_dup",
        "  - first in b",
        "    id:: blk_b1",
        "  - second in b",
        "    id:: blk_b2",
      ),
    })
    const index = buildIndex([a, b])
    const [fromA, fromB] = searchBlocks(parseQuery("type:h1"), index)
    expect(blockKey(fromA)).toBe("a::blk_dup")
    expect(blockKey(fromB)).toBe("b::blk_dup")
    expect(fromA.childCount).toBe(3)
    expect(fromB.childCount).toBe(3)
    expect(ids(index.getChildren(fromA)).sort()).toEqual(["blk_a1", "blk_b1", "blk_b2"])
    expect(ids(index.getChildren(fromB)).sort()).toEqual(["blk_a1", "blk_b1", "blk_b2"])
  })
})

describe("searchBlocks", () => {
  test("type:todo finds every unchecked checkbox in the corpus", () => {
    expect(ids(run("type:todo"))).toEqual(["blk_milk", "blk_plants"])
  })

  test("task matches both states; comma lists and finer values compose", () => {
    expect(ids(run("type:task"))).toEqual(["blk_milk", "blk_ship", "blk_plants"])
    expect(ids(run("type:todo,done"))).toEqual(["blk_milk", "blk_ship", "blk_plants"])
    expect(ids(run("type:done"))).toEqual(["blk_ship"])
    expect(ids(run("type:list"))).toEqual(["blk_bullet", "blk_ordered"])
    expect(ids(run("type:ul,ol"))).toEqual(["blk_bullet", "blk_ordered"])
    expect(ids(run("type:quote"))).toEqual(["blk_quote"])
    expect(ids(run("type:text"))).toEqual(["blk_plain"])
    expect(ids(run('type:"heading"'))).toEqual(["blk_head"])
  })

  test("- excludes block types", () => {
    expect(ids(run("type:task -type:done"))).toEqual(["blk_milk", "blk_plants"])
  })

  test("note-level qualifiers filter by the containing note", () => {
    expect(ids(run("type:todo tag:work"))).toEqual(["blk_milk"])
    expect(ids(run("type:todo -tag:work"))).toEqual(["blk_plants"])
    expect(ids(run("type:todo tag:work,home"))).toEqual(["blk_milk", "blk_plants"])
  })

  test("fuzzy text matches the block's own text", () => {
    expect(ids(run("type:todo milk"))).toEqual(["blk_milk"])
    // Fuzzy alone (no block filter) still ranks blocks when called directly.
    expect(ids(run("plants"))).toEqual(["blk_plants"])
  })

  test("sort:updated orders blocks by their note's updated_at, recent first", () => {
    // Per-block timestamps aren't reachable synchronously; the documented
    // fallback is the note-level updated_at (tasks=200, misc=100).
    expect(ids(run("type:todo sort:updated"))).toEqual(["blk_milk", "blk_plants"])
    expect(ids(run("type:todo sort:updated:asc"))).toEqual(["blk_plants", "blk_milk"])
  })

  test("sort:text orders by block text; note-level sort keys delegate to the note", () => {
    expect(ids(run("type:task sort:text"))).toEqual(["blk_milk", "blk_ship", "blk_plants"])
    // id sorts notes alphabetically: misc before tasks.
    expect(ids(run("type:todo sort:id"))).toEqual(["blk_plants", "blk_milk"])
  })

  test("empty query returns every block in document order grouped by note", () => {
    const hits = run("")
    expect(ids(hits)).toEqual([
      "blk_head",
      "blk_milk",
      "blk_ship",
      "blk_plants",
      "blk_bullet",
      "blk_ordered",
      "blk_quote",
      "blk_plain",
    ])
  })

  test("an unknown type value matches nothing", () => {
    // Alone it is not block vocabulary (stays a note-type filter → no notes
    // of type "zzz"); mixed into a block-scoped list it matches no blocks.
    expect(run("type:zzz")).toEqual([])
    expect(ids(run("type:todo,zzz"))).toEqual(["blk_milk", "blk_plants"])
  })

  test("in: scopes to the blocks downstream of a note, by id or by name", () => {
    expect(ids(run("type:todo in:tasks"))).toEqual(["blk_milk"])
    expect(ids(run("type:todo in:misc"))).toEqual(["blk_plants"])
    // By the note's name (case-insensitive), quoted when it has spaces.
    const named = makeNote({ ...TASKS_NOTE, displayName: "Today's tasks", title: "Today's tasks" })
    expect(ids(run('type:task in:"today\'s tasks"', [named, MISC_NOTE]))).toEqual([
      "blk_milk",
      "blk_ship",
    ])
    // Comma lists OR; `-in:` excludes.
    expect(ids(run("type:todo in:tasks,misc"))).toEqual(["blk_milk", "blk_plants"])
    expect(ids(run("type:todo -in:tasks"))).toEqual(["blk_plants"])
    // A note nothing is in.
    expect(run("type:todo in:nowhere")).toEqual([])
  })

  test("in: with a block id scopes to what is reachable beneath it — the block itself excluded", () => {
    expect(ids(run("in:blk_head"))).toEqual(["blk_milk", "blk_ship"])
    expect(ids(run("type:done in:blk_head"))).toEqual(["blk_ship"])
    // Composes with everything else, and a leaf has nothing downstream.
    expect(ids(run("type:todo in:blk_head tag:work"))).toEqual(["blk_milk"])
    expect(run("in:blk_milk")).toEqual([])
  })
})

describe("getBlock", () => {
  test("looks a block up by id alone, in the first note carrying it", () => {
    const index = buildIndex([TASKS_NOTE, MISC_NOTE])
    expect(index.getBlock("blk_milk")?.text).toBe("buy milk")
    expect(index.getBlock("blk_milk")?.noteId).toBe("tasks")
    expect(index.getBlock("blk_nope")).toBeUndefined()
  })
})

describe("block-scoped type detection", () => {
  test("block values are block-scoped; note types and other keys are not", () => {
    const filterOf = (query: string) => parseQuery(query).filters[0]
    expect(isBlockTypeFilter(filterOf("type:todo"))).toBe(true)
    expect(isBlockTypeFilter(filterOf("-type:heading"))).toBe(true)
    expect(isBlockTypeFilter(filterOf("type:daily"))).toBe(false)
    expect(isBlockTypeFilter(filterOf("type:template"))).toBe(false)
    expect(isBlockTypeFilter(filterOf("tag:todo"))).toBe(false)
    expect(hasBlockTypeFilter(parseQuery("tag:a type:todo").filters)).toBe(true)
    expect(hasBlockTypeFilter(parseQuery("tag:a type:daily").filters)).toBe(false)
  })
})

describe("createBlockIndexer", () => {
  test("re-walks only notes whose Note object changed", () => {
    const calls: string[] = []
    const build = createBlockIndexer((note, snapshot) => {
      calls.push(note.id)
      return indexNoteBlocks(note, snapshot)
    })
    const notes = [TASKS_NOTE, MISC_NOTE]
    const snapshot = snapshotFor(notes)

    build(notes, snapshot)
    expect(calls).toEqual(["tasks", "misc"])

    // Same Note objects again: nothing recomputed.
    build(notes, snapshot)
    expect(calls).toEqual(["tasks", "misc"])

    // One note changed (a new Note object — `createNotesBuilder` keeps the
    // object while a page's rows are unchanged): only it is re-walked.
    const changed = makeNote({ id: "misc", content: md("[ ] new todo", "  id:: blk_new") })
    const index = build([TASKS_NOTE, changed], snapshotFor([TASKS_NOTE, changed]))
    expect(calls).toEqual(["tasks", "misc", "misc"])
    expect(ids(searchBlocks(parseQuery("type:todo"), index))).toEqual(["blk_milk", "blk_new"])
    expect(index.hits[0].note).toBe(TASKS_NOTE)
  })

  test("evicts deleted notes and re-indexes them if they return", () => {
    const calls: string[] = []
    const build = createBlockIndexer((note, snapshot) => {
      calls.push(note.id)
      return indexNoteBlocks(note, snapshot)
    })
    const snapshot = snapshotFor([TASKS_NOTE, MISC_NOTE])
    build([TASKS_NOTE, MISC_NOTE], snapshot)
    expect(ids(build([TASKS_NOTE], snapshot).hits)).toEqual(["blk_head", "blk_milk", "blk_ship"])
    build([TASKS_NOTE, MISC_NOTE], snapshot)
    expect(calls).toEqual(["tasks", "misc", "misc"])
  })
})

describe("notesFromBlockHits", () => {
  test("dedupes to containing notes in first-hit order", () => {
    const hits = run("type:task")
    expect(notesFromBlockHits(hits).map((note) => note.id)).toEqual(["tasks", "misc"])
  })
})
