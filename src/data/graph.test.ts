import { describe, expect, it } from "vitest"
import type { LinkRow, NodeRow } from "../../worker/handlers/replica-payload"
import { parse } from "../blocks/parse"
import { serialize } from "../blocks/serialize"
import { getSampleMarkdownFiles } from "../utils/sample-markdown-files"
import {
  buildGraphSnapshot,
  docToGraph,
  findCrossNoteIdCollisions,
  reconcileSortKeys,
  rollup,
  sortKeyBetween,
} from "./graph"

/**
 * The rollup test plan (docs/graph-schema-v2.md). The rollup replaces stored
 * bytes as the source of exported markdown, so the load-bearing invariant is
 * pinned from every direction: for canonical markdown (the fixpoint of the
 * editor's `serialize(parse(md))`), `rollup(docToGraph(md))` reproduces it
 * byte-for-byte, frontmatter included.
 */

const canonical = (markdown: string) => serialize(parse(markdown))

const viaGraph = (markdown: string, noteId = "note") => {
  const { nodes, links } = docToGraph(noteId, markdown, 123)
  return rollup(noteId, buildGraphSnapshot(nodes, links))
}

/** Assert the invariant for one document (canonicalized first, so ids exist). */
function expectEquivalent(markdown: string) {
  const fixed = canonical(markdown)
  expect(viaGraph(fixed)).toBe(fixed)
  // And the canonical form is a fixpoint of the graph round-trip itself.
  expect(viaGraph(viaGraph(fixed) as string)).toBe(fixed)
}

const types = (markdown: string) => {
  const { nodes } = docToGraph("note", canonical(markdown), 0)
  return nodes.filter((node) => node.type !== "page").map((node) => `${node.type}:${node.text}`)
}

describe("rollup equivalence (named cases)", () => {
  it("covers every marker in the type registry", () => {
    expectEquivalent(
      [
        "# Heading",
        "Plain paragraph",
        "- Bullet",
        "[ ] Open todo",
        "[x] Done todo",
        "> Quote",
        "1. First",
        "2. Second",
        "",
      ].join("\n"),
    )
  })

  it("assigns marker-free text and stored types", () => {
    expect(types("# H\nplain\n- b\n[ ] t\n[x] d\n> q\n1. o\n")).toEqual([
      "h1:H",
      "text:plain",
      "ul:b",
      "todo:t",
      "done:d",
      "quote:q",
      "ol:o",
    ])
  })

  it("preserves frontmatter verbatim through page props", () => {
    const markdown =
      "---\ntitle: Weird   spacing\ntags: [a, b]\nnested:\n  - x\n  - 'y: z'\n---\n- body\n"
    expectEquivalent(markdown)
    const { nodes } = docToGraph("note", markdown, 0)
    const page = nodes.find((node) => node.type === "page")
    expect(page?.props).toBe(
      JSON.stringify({
        frontmatter: "title: Weird   spacing\ntags: [a, b]\nnested:\n  - x\n  - 'y: z'",
      }),
    )
  })

  it("keeps frontmatter that contains lines that look like blocks", () => {
    expectEquivalent("---\ndescription: |\n  - not a bullet\n  # not a heading\n---\nhello\n")
  })

  it("handles an empty page and a frontmatter-only page", () => {
    expectEquivalent("")
    expectEquivalent("---\ntitle: empty\n---\n")
  })

  it("does not type fake markers inside code fences", () => {
    const markdown = "```js\n- [ ] not a todo\n# not a heading\n1. not a list\n```\nafter\n"
    expectEquivalent(markdown)
    // (parse itself rewrites the GFM `- [ ]` spelling to the bare `[ ]` marker
    // before ingest sees it; the fence guard keeps it a text node either way.)
    expect(types(markdown)).toEqual([
      "text:```js",
      "text:[ ] not a todo",
      "text:# not a heading",
      "text:1. not a list",
      "text:```",
      "text:after",
    ])
  })

  it("normalizes multi-# heading markers exactly like the serializer", () => {
    expect(canonical("## Foo\n")).toContain("# Foo")
    expectEquivalent("## Foo\n### Bar\n#### Baz\n")
    expect(types("## Foo\n")).toEqual(["h1:Foo"])
  })

  it("keeps non-canonical marker spellings verbatim as text nodes", () => {
    const markdown = "* star bullet\n[X] caps todo\n[] shorthand\n2) paren ordered\n#nospace\n"
    expectEquivalent(markdown)
    expect(types(markdown)).toEqual([
      "text:* star bullet",
      "text:[X] caps todo",
      "text:[] shorthand",
      "text:2) paren ordered",
      "text:#nospace",
    ])
  })

  it("renumbers ordered runs and leaves mismatched numbers verbatim", () => {
    // 1/2 form a run (typed ol, renumbered by position); 5 breaks it.
    const markdown = "1. a\n2. b\n5. c\n1. d\n"
    expectEquivalent(markdown)
    expect(types(markdown)).toEqual(["ol:a", "ol:b", "text:5. c", "ol:d"])
  })

  it("treats leading-zero ordered markers as text (never renumbered)", () => {
    expectEquivalent("01. zero padded\n0. zero\n")
    expect(types("01. zero padded\n")).toEqual(["text:01. zero padded"])
  })

  it("scopes ordered runs per parent", () => {
    expectEquivalent("1. a\n  1. nested one\n  2. nested two\n2. b\n")
  })

  it("preserves unicode and odd whitespace inside text", () => {
    expectEquivalent(
      "- café \u{1f9e0}‍⚙️\n- text   with   runs\n- trailing  \n> 　ideographic space\n",
    )
  })

  it("preserves empty blocks and deep nesting", () => {
    expectEquivalent("- a\n  - b\n    - c\n      - d\n        \n- e\n")
  })

  it("round-trips the sample notes shipped to signed-out users", () => {
    for (const content of Object.values(getSampleMarkdownFiles())) {
      expectEquivalent(content)
    }
  })

  it("stamps every row with the ingest updated_at", () => {
    const { nodes, links } = docToGraph("note", "- a\n  - b\n", 777)
    expect(nodes.every((node) => node.updated_at === 777)).toBe(true)
    expect(links.every((link) => link.updated_at === 777)).toBe(true)
  })

  it("assigns evenly-spaced sibling sort keys in document order", () => {
    const { links } = docToGraph("note", canonical("- a\n- b\n- c\n"), 0)
    const roots = links.filter((link) => link.source_id === "note")
    const keys = roots.map((link) => link.sort_key)
    expect([...keys].sort()).toEqual(keys)
    expect(new Set(keys).size).toBe(3)
  })
})

describe("rollup (graph-side behavior)", () => {
  const node = (id: string, type: string, text: string, props: string | null = null): NodeRow => ({
    id,
    type,
    text,
    props,
    updated_at: 0,
  })
  const link = (source: string, destination: string, sortKey: string): LinkRow => ({
    source_id: source,
    destination_id: destination,
    kind: "child",
    sort_key: sortKey,
    updated_at: 0,
  })

  it("renders a multi-parent node fully in every location", () => {
    const snapshot = buildGraphSnapshot(
      [
        node("page-a", "page", "page-a"),
        node("page-b", "page", "page-b"),
        node("blk_shared", "ul", "shared"),
        node("blk_child", "text", "under shared"),
      ],
      [
        link("page-a", "blk_shared", "a0"),
        link("page-b", "blk_shared", "a0"),
        link("blk_shared", "blk_child", "a0"),
      ],
    )
    const expected = "- shared\n  id:: blk_shared\n  under shared\n    id:: blk_child\n"
    expect(rollup("page-a", snapshot)).toBe(expected)
    expect(rollup("page-b", snapshot)).toBe(expected)
  })

  it("breaks sort-key collisions deterministically by destination id", () => {
    const snapshot = buildGraphSnapshot(
      [node("p", "page", "p"), node("blk_b", "text", "b"), node("blk_a", "text", "a")],
      [link("p", "blk_b", "a0"), link("p", "blk_a", "a0")],
    )
    expect(rollup("p", snapshot)).toBe("a\n  id:: blk_a\nb\n  id:: blk_b\n")
  })

  it("caps the walk depth so a corrupted (cyclic) graph cannot hang it", () => {
    const snapshot = buildGraphSnapshot(
      [node("p", "page", "p"), node("blk_x", "text", "x"), node("blk_y", "text", "y")],
      [link("p", "blk_x", "a0"), link("blk_x", "blk_y", "a0"), link("blk_y", "blk_x", "a0")],
    )
    const markdown = rollup("p", snapshot)
    expect(markdown).not.toBeNull()
    expect((markdown as string).length).toBeLessThan(10_000)
  })

  it("renders code nodes as fenced blocks with the props language", () => {
    const snapshot = buildGraphSnapshot(
      [
        node("p", "page", "p"),
        node("blk_c", "code", "const x = 1\nconst y = 2", JSON.stringify({ language: "js" })),
      ],
      [link("p", "blk_c", "a0")],
    )
    expect(rollup("p", snapshot)).toBe("```js\nconst x = 1\nconst y = 2\n```\n  id:: blk_c\n")
  })

  it("returns null for a missing or non-page node", () => {
    const snapshot = buildGraphSnapshot([node("blk_a", "text", "a")], [])
    expect(rollup("missing", snapshot)).toBeNull()
    expect(rollup("blk_a", snapshot)).toBeNull()
  })

  it("tolerates malformed page props (renders without frontmatter)", () => {
    const snapshot = buildGraphSnapshot([node("p", "page", "p", "{not json")], [])
    expect(rollup("p", snapshot)).toBe("\n")
  })
})

describe("property: generated documents round-trip", () => {
  // Deterministic PRNG so failures reproduce.
  const mulberry32 = (seed: number) => () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  const MARKERS = [
    "",
    "",
    "# ",
    "## ",
    "[ ] ",
    "[x] ",
    "[X] ",
    "[] ",
    "- ",
    "* ",
    "> ",
    "1. ",
    "2. ",
    "3) ",
    "0. ",
  ]
  const WORDS = [
    "alpha",
    "café",
    "\u{1f331}",
    "x  y",
    "((blk_ref))",
    "[[wiki]]",
    "#tag",
    "```",
    "---",
  ]

  function generateDocument(rand: () => number): string {
    const lines: string[] = []
    const lineCount = 1 + Math.floor(rand() * 20)
    let depth = 0
    for (let i = 0; i < lineCount; i += 1) {
      depth = Math.max(0, Math.min(depth + Math.floor(rand() * 3) - 1, 5))
      const marker = MARKERS[Math.floor(rand() * MARKERS.length)]
      const words = Array.from(
        { length: Math.floor(rand() * 3) },
        () => WORDS[Math.floor(rand() * WORDS.length)],
      )
      lines.push("  ".repeat(depth) + marker + words.join(" "))
    }
    const frontmatter = rand() < 0.3 ? "---\ntitle: generated\nlist:\n  - a\n---\n" : ""
    return frontmatter + lines.join("\n") + "\n"
  }

  it("rollup(docToGraph(md)) === canonicalize(md) for 200 generated documents", () => {
    const rand = mulberry32(20260829)
    for (let i = 0; i < 200; i += 1) {
      const markdown = generateDocument(rand)
      const fixed = canonical(markdown)
      expect(viaGraph(fixed), `seed doc ${i}:\n${markdown}`).toBe(fixed)
    }
  })

  it("parse(rollup(docToGraph(md))) preserves the block tree", () => {
    const rand = mulberry32(42)
    for (let i = 0; i < 50; i += 1) {
      const fixed = canonical(generateDocument(rand))
      const rolled = viaGraph(fixed) as string
      expect(serialize(parse(rolled))).toBe(fixed)
    }
  })
})

describe("sort keys", () => {
  it("sortKeyBetween is strictly between its neighbours", () => {
    let low = sortKeyBetween(null, null)
    const high = sortKeyBetween(low, null)
    for (let i = 0; i < 50; i += 1) {
      const mid = sortKeyBetween(low, high)
      expect(mid > low && mid < high).toBe(true)
      low = mid
    }
  })

  it("order survives arbitrary insert sequences", () => {
    const rand = (() => {
      let seed = 7
      return () => ((seed = (seed * 48271) % 2147483647) - 1) / 2147483646
    })()
    const entries: { id: number; key: string }[] = [{ id: 0, key: sortKeyBetween(null, null) }]
    for (let i = 1; i < 100; i += 1) {
      const at = Math.floor(rand() * (entries.length + 1))
      const before = at > 0 ? entries[at - 1].key : null
      const after = at < entries.length ? entries[at].key : null
      entries.splice(at, 0, { id: i, key: sortKeyBetween(before, after) })
    }
    const keys = entries.map((entry) => entry.key)
    expect([...keys].sort()).toEqual(keys)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it("reconcileSortKeys keeps keys for unchanged siblings", () => {
    const existing = [
      { id: "a", sortKey: "a0" },
      { id: "b", sortKey: "a1" },
      { id: "c", sortKey: "a2" },
    ]
    const keys = reconcileSortKeys(existing, ["a", "b", "c"])
    expect([...keys]).toEqual([
      ["a", "a0"],
      ["b", "a1"],
      ["c", "a2"],
    ])
  })

  it("reconcileSortKeys inserts between neighbours without touching them", () => {
    const keys = reconcileSortKeys(
      [
        { id: "a", sortKey: "a0" },
        { id: "b", sortKey: "a1" },
      ],
      ["a", "new", "b"],
    )
    expect(keys.get("a")).toBe("a0")
    expect(keys.get("b")).toBe("a1")
    const inserted = keys.get("new") as string
    expect(inserted > "a0" && inserted < "a1").toBe(true)
  })

  it("reconcileSortKeys re-keys the minimum on a reorder", () => {
    const keys = reconcileSortKeys(
      [
        { id: "a", sortKey: "a0" },
        { id: "b", sortKey: "a1" },
        { id: "c", sortKey: "a2" },
      ],
      ["b", "a", "c"],
    )
    // b and c keep their keys; only a needs a fresh one, between them.
    expect(keys.get("b")).toBe("a1")
    expect(keys.get("c")).toBe("a2")
    const moved = keys.get("a") as string
    expect(moved > "a1" && moved < "a2").toBe(true)
  })

  it("reconcileSortKeys yields strictly increasing keys for any order", () => {
    const existing = [
      { id: "a", sortKey: "a0" },
      { id: "b", sortKey: "a1" },
      { id: "c", sortKey: "a2" },
    ]
    for (const desired of [
      ["c", "b", "a"],
      ["c", "a", "x", "b"],
      ["x", "y", "z"],
      ["b", "c"],
    ]) {
      const keys = reconcileSortKeys(existing, desired)
      const ordered = desired.map((id) => keys.get(id) as string)
      expect([...ordered].sort()).toEqual(ordered)
      expect(new Set(ordered).size).toBe(ordered.length)
    }
  })
})

describe("findCrossNoteIdCollisions", () => {
  it("reports ids declared by more than one note, deterministically", () => {
    const collisions = findCrossNoteIdCollisions({
      "note-b": "- dup\n  id:: blk_dup\n",
      "note-a": "- dup\n  id:: blk_dup\n- own\n  id:: blk_own\n",
    })
    expect(collisions).toEqual([{ blockId: "blk_dup", noteIds: ["note-a", "note-b"] }])
  })

  it("returns empty when every id is unique", () => {
    expect(
      findCrossNoteIdCollisions({ a: "- x\n  id:: blk_x\n", b: "- y\n  id:: blk_y\n" }),
    ).toEqual([])
  })
})
