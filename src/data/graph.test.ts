import { describe, expect, it } from "vitest"
import type { LinkRow, NodeRow } from "../../worker/handlers/replica-payload"
import { parse } from "../blocks/parse"
import { serialize } from "../blocks/serialize"
import type { BlockDoc } from "../blocks/types"
import { sampleGraph } from "./sample-graph"
import {
  buildGraphSnapshot,
  docFromGraph,
  docToGraph,
  docToParts,
  pageDoc,
  reconcileSortKeys,
  rollup,
  sortKeyBetween,
} from "./graph"

/**
 * The rollup test plan (docs/graph-schema-v2.md). The rollup replaces stored
 * bytes as the source of exported markdown, so the load-bearing invariant is
 * pinned from every direction: `rollup(docToGraph(md))` is the NORMALIZED
 * form of `md` — ingest deliberately canonicalizes near-miss marker spellings
 * and drops a leading frontmatter block (see graph.ts) — and that normalized
 * form is a strict fixpoint of the round trip. For markdown already in
 * normalized form the round trip reproduces it byte-for-byte.
 */

const canonical = (markdown: string) => serialize(parse(markdown))

const viaGraph = (markdown: string, noteId = "note") => {
  const { nodes, links } = docToGraph(noteId, markdown, 123)
  return rollup(noteId, buildGraphSnapshot(nodes, links))
}

/** Assert byte-exact equivalence for a document already in normalized form
 * (canonicalized first, so ids exist). */
function expectEquivalent(markdown: string, noteId = "note") {
  const fixed = canonical(markdown)
  expect(viaGraph(fixed, noteId)).toBe(fixed)
  // And the canonical form is a fixpoint of the graph round-trip itself.
  expect(viaGraph(viaGraph(fixed, noteId) as string, noteId)).toBe(fixed)
}

/** Assert one pass of the round trip converges: the (possibly normalized)
 * output is a strict fixpoint of a second pass. */
function expectConverges(markdown: string, noteId = "note"): string {
  const fixed = canonical(markdown)
  const normalized = viaGraph(fixed, noteId) as string
  expect(normalized).not.toBeNull()
  expect(viaGraph(normalized, noteId)).toBe(normalized)
  return normalized
}

/** Bare row builders for graph-side and adversarial-row tests. */
const row = (id: string, type: string, text: string, props: string | null = null): NodeRow => ({
  id,
  type,
  text,
  props,
  updated_at: 0,
})
const edge = (source: string, destination: string, sortKey: string, kind = "child"): LinkRow => ({
  source_id: source,
  destination_id: destination,
  kind,
  sort_key: sortKey,
  updated_at: 0,
})

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

  it("drops a leading frontmatter block at import: metadata is props, never markdown", () => {
    const markdown = "---\ntitle: Weird   spacing\ntags: [a, b]\n---\n- body\n"
    const { nodes } = docToGraph("note", markdown, 0)
    const page = nodes.find((node) => node.type === "page")
    expect(page?.props).toBe(null)
    expect(page?.text).toBe("note")
    const normalized = expectConverges(markdown)
    expect(normalized.startsWith("- body\n")).toBe(true)
    expect(normalized).not.toContain("---")
  })

  it("handles an empty page", () => {
    expectEquivalent("")
  })

  it("a code fence is one code block; nothing inside it is a marker", () => {
    const markdown =
      "```js\n- [ ] not a todo\n[x] not done\n# not a heading\n1. not a list\n> not a quote\n- not a bullet\n```\nafter\n"
    expectEquivalent(markdown)
    // The fence's lines are the block's text, verbatim — the GFM `- [ ]`
    // spelling included, since nothing inside a fence is read as a marker.
    expect(types(markdown)).toEqual([
      "code:- [ ] not a todo\n[x] not done\n# not a heading\n1. not a list\n> not a quote\n- not a bullet",
      "text:after",
    ])
  })

  it("an unclosed code fence keeps the rest of the note verbatim, as one code block", () => {
    const markdown = "before\n```\n# still code\n[ ] still code\n1. still code\n"
    expectEquivalent(markdown)
    expect(types(markdown)).toEqual([
      "text:before",
      "code:# still code\n[ ] still code\n1. still code",
    ])
  })

  it("normalizes multi-# heading markers exactly like the serializer", () => {
    expect(canonical("## Foo\n")).toContain("# Foo")
    expectEquivalent("## Foo\n### Bar\n#### Baz\n")
    expect(types("## Foo\n")).toEqual(["h1:Foo"])
  })

  it("normalizes near-miss marker spellings to their typed form (deliberate byte change)", () => {
    const markdown = "* star bullet\n[X] caps todo\n[] shorthand\n2) paren ordered\n"
    expect(types(markdown)).toEqual([
      "ul:star bullet",
      "done:caps todo",
      "todo:shorthand",
      "ol:paren ordered",
    ])
    // One pass rewrites the bytes to canonical markers; then it's a fixpoint.
    const normalized = expectConverges(markdown)
    expect(normalized).toMatch(/^- star bullet\n/)
    expect(normalized).toContain("\n[x] caps todo\n")
    expect(normalized).toContain("\n[ ] shorthand\n")
    expect(normalized).toContain("\n1. paren ordered\n")
  })

  it("keeps genuinely ambiguous near-misses verbatim as text nodes", () => {
    // #nospace is the tag syntax; [link] is prose; tight markers and bare []
    // have no clear intent; 4+ digit "ordered" markers are prose years.
    const markdown =
      "#nospace\n##alsonospace\n[link] text\n[x]tight\n[]\n1990. that was the year\n**bold** start\n+1 to that\n"
    expectEquivalent(markdown)
    expect(types(markdown)).toEqual([
      "text:#nospace",
      "text:##alsonospace", // marker collapse needs a space too — verbatim text
      "text:[link] text",
      "text:[x]tight",
      "text:[]",
      "text:1990. that was the year",
      "text:**bold** start",
      "text:+1 to that",
    ])
  })

  it("renumbers ordered runs; a mismatched number joins the run via normalization", () => {
    // 1/2 form a run; 5 is a near-miss that now normalizes into it and the
    // rollup renumbers the whole run by position.
    const markdown = "1. a\n2. b\n5. c\n1. d\n"
    expect(types(markdown)).toEqual(["ol:a", "ol:b", "ol:c", "ol:d"])
    const normalized = expectConverges(markdown)
    const contentLines = normalized.split("\n").filter((line) => !line.includes("id:: "))
    expect(contentLines).toEqual(["1. a", "2. b", "3. c", "4. d", ""])
  })

  it("normalizes leading-zero and zero ordered markers into the run", () => {
    expect(types("01. zero padded\n0. zero\n")).toEqual(["ol:zero padded", "ol:zero"])
    expectConverges("01. zero padded\n0. zero\n")
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

  it("round-trips the sample graph shipped to signed-out users", () => {
    const graph = sampleGraph()
    for (const node of graph.nodes.values()) {
      if (node.type !== "page") continue
      const markdown = rollup(node.id, graph)
      expect(markdown).not.toBeNull()
      expectEquivalent(markdown as string, node.id)
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

  it("handles whitespace-only notes and notes without a trailing newline", () => {
    expectEquivalent("   \n\t\n  \n")
    expectEquivalent("- no trailing newline")
    expect(canonical("   \n\t\n  \n")).toBe("\n")
  })

  it("normalizes CRLF line endings at ingest (no \\r reaches a row)", () => {
    expectEquivalent("- a\r\n[ ] b\r\n")
    const { nodes } = docToGraph("note", "- a\r\n[ ] b\r\n", 0)
    expect(nodes.some((node) => node.text.includes("\r"))).toBe(false)
    expect(nodes.map((node) => `${node.type}:${node.text}`)).toContain("todo:b")
  })

  /** Parent→child pairs by text, for asserting containment shape. */
  const shape = (markdown: string) => {
    const { nodes, links } = docToGraph("note", markdown, 0)
    const textOf = new Map(nodes.map((node) => [node.id, node.text]))
    return links.map((link) => `${textOf.get(link.source_id)}>${textOf.get(link.destination_id)}`)
  }

  it("reads tab-indented and 4-space outlines into the same containment", () => {
    expectEquivalent("- a\n\t- b\n\t\t- c\n")
    expectEquivalent("- a\n    - b\n        - c\n")
    const expected = ["note>a", "a>b", "b>c"]
    expect(shape("- a\n  - b\n    - c\n")).toEqual(expected)
    expect(shape("- a\n\t- b\n\t\t- c\n")).toEqual(expected)
    expect(shape("- a\n    - b\n        - c\n")).toEqual(expected)
  })

  it("preserves combining characters, RTL text, and zero-width characters", () => {
    const markdown = "- café combining\n- שלום rtl\n- a​b‌‍ zero-width\n"
    expectEquivalent(markdown)
    expect(types(markdown)).toEqual(["ul:café combining", "ul:שלום rtl", "ul:a​b‌‍ zero-width"])
  })

  it("supports unicode note ids (emoji, zero-width) as page-node keys", () => {
    for (const noteId of ["\u{1f9e0} thoughts", "café​"]) {
      expectEquivalent("- body\n", noteId)
      const { nodes } = docToGraph(noteId, canonical("- body\n"), 0)
      expect(nodes.find((node) => node.type === "page")).toMatchObject({ id: noteId, text: noteId })
    }
  })

  it("keeps reference-looking text and hostile wikilink targets verbatim", () => {
    const markdown =
      '- ((blk_target1234))\n- [[target|alias]]\n- [[a "quoted" [target]]]\n- [[pipe||double]] tail\n'
    expectEquivalent(markdown)
    expect(types(markdown)).toEqual([
      "ul:((blk_target1234))",
      "ul:[[target|alias]]",
      'ul:[[a "quoted" [target]]]',
      "ul:[[pipe||double]] tail",
    ])
  })

  it("re-mints a duplicate id:: within one note (no block is silently lost)", () => {
    const markdown = "- first copy\n  id:: blk_dup0000000\n- second copy\n  id:: blk_dup0000000\n"
    expectEquivalent(markdown)
    const { nodes, links } = docToGraph("note", markdown, 0)
    const blocks = nodes.filter((node) => node.type !== "page")
    expect(blocks).toHaveLength(2)
    expect(new Set(blocks.map((node) => node.id)).size).toBe(2)
    expect(blocks.map((node) => node.text)).toEqual(["first copy", "second copy"])
    expect(links.filter((link) => link.source_id === "note")).toHaveLength(2)
  })

  it("re-mints a block id that collides with the note id (page keeps rolling up)", () => {
    // Block ids and page ids share the nodes table: without the re-mint, the
    // block row clobbered the page row and the note stopped rolling up at all.
    const { nodes, links } = docToGraph("note", "- hello\n  id:: note\n", 0)
    expect(nodes.map((node) => node.type).sort()).toEqual(["page", "ul"])
    const block = nodes.find((node) => node.type === "ul")
    expect(block?.id).not.toBe("note")
    expect(links).toEqual([
      expect.objectContaining({ source_id: "note", destination_id: block?.id }),
    ])

    const rolled = viaGraph("- hello\n  id:: note\n") as string
    expect(rolled).toMatch(/^- hello\n {2}id:: blk_/)
    // The re-minted form is a clean fixpoint from then on.
    expect(viaGraph(rolled)).toBe(rolled)
  })

  it("ingests nesting far beyond the render depth cap without overflowing", () => {
    const DEPTH = 300
    const markdown =
      Array.from({ length: DEPTH }, (_, i) => `${"  ".repeat(i)}- n${i}`).join("\n") + "\n"
    const { nodes, links } = docToGraph("note", markdown, 0)
    expect(nodes).toHaveLength(DEPTH + 1)
    expect(links).toHaveLength(DEPTH)
    // The rollup terminates and renders exactly the capped 64 levels.
    const rolled = rollup("note", buildGraphSnapshot(nodes, links)) as string
    expect(rolled.match(/ {2}id:: /g)).toHaveLength(64)
    expect(rolled.endsWith("\n")).toBe(true)
  })
})

describe("the title's ride through a page's doc", () => {
  const body = "body\n  id:: blk_aaaaaaaaaa\n"

  it("lifts a title into the page node and walks it back out as doc props", () => {
    const { nodes, links } = docToGraph("blk_page00000", body, 0, { title: "Flow Engineering" })
    const page = nodes.find((node) => node.type === "page") as NodeRow
    // Stored once, in `text` — not duplicated into props.
    expect(page.text).toBe("Flow Engineering")
    expect(page.props).toBe(null)
    const snapshot = buildGraphSnapshot(nodes, links)
    expect(pageDoc("blk_page00000", snapshot)?.props).toEqual({ title: "Flow Engineering" })
    // The rollup is the blocks alone: metadata never touches markdown.
    expect(rollup("blk_page00000", snapshot)).toBe(body)
  })

  it("keeps the other props beside the title", () => {
    const { nodes, links } = docToGraph("blk_page00000", body, 0, { title: "Flow", pinned: true })
    const page = nodes.find((node) => node.type === "page") as NodeRow
    expect(page.props).toBe(JSON.stringify({ pinned: true }))
    expect(pageDoc("blk_page00000", buildGraphSnapshot(nodes, links))?.props).toEqual({
      title: "Flow",
      pinned: true,
    })
  })

  it("survives titles the filename charset used to forbid", () => {
    // The point of separating identity from name: a title is just text now.
    for (const title of ["Q3: the plan", "What? [draft]", "a|b", "100%", "-- dashes"]) {
      const { nodes, links } = docToGraph("blk_page00000", body, 0, { title })
      expect((nodes.find((node) => node.type === "page") as NodeRow).text).toBe(title)
      expect(pageDoc("blk_page00000", buildGraphSnapshot(nodes, links))?.props).toEqual({ title })
    }
  })

  it("carries no title for a date page, whose id IS its name", () => {
    const markdown = "today\n  id:: blk_aaaaaaaaaa\n"
    const { nodes, links } = docToGraph("2026-08-31", markdown, 0)
    const snapshot = buildGraphSnapshot(nodes, links)
    expect((nodes.find((node) => node.type === "page") as NodeRow).text).toBe("2026-08-31")
    expect(pageDoc("2026-08-31", snapshot)?.props).toBeNull()
    expect(rollup("2026-08-31", snapshot)).toBe(markdown)
  })

  it("carries no title for an untitled page", () => {
    const { nodes, links } = docToGraph("blk_page00000", body, 0)
    const snapshot = buildGraphSnapshot(nodes, links)
    expect(pageDoc("blk_page00000", snapshot)?.props).toBeNull()
    expect(rollup("blk_page00000", snapshot)).toBe(body)
  })
})

describe("rollup (graph-side behavior)", () => {
  it("renders a multi-parent node fully in every location", () => {
    const snapshot = buildGraphSnapshot(
      [
        row("page-a", "page", "page-a"),
        row("page-b", "page", "page-b"),
        row("blk_shared", "ul", "shared"),
        row("blk_child", "text", "under shared"),
      ],
      [
        edge("page-a", "blk_shared", "a0"),
        edge("page-b", "blk_shared", "a0"),
        edge("blk_shared", "blk_child", "a0"),
      ],
    )
    const expected = "- shared\n  id:: blk_shared\n  under shared\n    id:: blk_child\n"
    expect(rollup("page-a", snapshot)).toBe(expected)
    expect(rollup("page-b", snapshot)).toBe(expected)
  })

  it("breaks sort-key collisions deterministically by destination id", () => {
    const snapshot = buildGraphSnapshot(
      [row("p", "page", "p"), row("blk_b", "text", "b"), row("blk_a", "text", "a")],
      [edge("p", "blk_b", "a0"), edge("p", "blk_a", "a0")],
    )
    expect(rollup("p", snapshot)).toBe("a\n  id:: blk_a\nb\n  id:: blk_b\n")
  })

  it("rolls up a loop to where it closes, and nothing can hang on it", () => {
    const nodes = [row("p", "page", "p"), row("blk_x", "text", "x"), row("blk_y", "text", "y")]
    const links = [
      edge("p", "blk_x", "a0"),
      edge("blk_x", "blk_y", "a0"),
      edge("blk_y", "blk_x", "a0"),
    ]
    const markdown = rollup("p", buildGraphSnapshot(nodes, links)) as string
    // The walk keeps the loop (y holds x) and the serializer writes x once
    // more where the loop closes, as a leaf — then stops.
    expect(markdown).toBe("x\n  id:: blk_x\n  y\n    id:: blk_y\n    x\n      id:: blk_x\n")
    // And deterministically: row input order does not change the output.
    const shuffled = buildGraphSnapshot([...nodes].reverse(), [...links].reverse())
    expect(rollup("p", shuffled)).toBe(markdown)
  })

  it("renders code nodes as fenced blocks with the props language", () => {
    const snapshot = buildGraphSnapshot(
      [
        row("p", "page", "p"),
        row("blk_c", "code", "const x = 1\nconst y = 2", JSON.stringify({ language: "js" })),
      ],
      [edge("p", "blk_c", "a0")],
    )
    expect(rollup("p", snapshot)).toBe("```js\nconst x = 1\nconst y = 2\n```\n  id:: blk_c\n")
  })

  it("returns null for a missing or non-page node", () => {
    const snapshot = buildGraphSnapshot([row("blk_a", "text", "a")], [])
    expect(rollup("missing", snapshot)).toBeNull()
    expect(rollup("blk_a", snapshot)).toBeNull()
  })

  it("tolerates malformed page props (renders its blocks, of which there are none)", () => {
    const snapshot = buildGraphSnapshot([row("p", "page", "p", "{not json")], [])
    expect(rollup("p", snapshot)).toBe("\n")
  })
})

/**
 * Row sets `docToGraph` never produces — the shapes a bad sync merge, a
 * partial pull, or a buggy peer can leave behind. The rollup must never crash
 * or hang on these: its degraded output is pinned so it stays deterministic.
 */
describe("rollup from adversarial row sets (bad syncs)", () => {
  it("skips a dangling link (destination row missing) and keeps rendering", () => {
    const snapshot = buildGraphSnapshot(
      [row("p", "page", "p"), row("blk_a", "text", "a")],
      [edge("p", "blk_missing", "a0"), edge("p", "blk_a", "a1")],
    )
    expect(rollup("p", snapshot)).toBe("a\n  id:: blk_a\n")
  })

  it("a dangling link between ordered siblings resets the numbering run", () => {
    const snapshot = buildGraphSnapshot(
      [row("p", "page", "p"), row("blk_a", "ol", "a"), row("blk_b", "ol", "b")],
      [edge("p", "blk_a", "a0"), edge("p", "blk_ghost", "a1"), edge("p", "blk_b", "a2")],
    )
    // The ghost is dropped from the doc entirely, so the run it would have
    // broken simply continues — pinned so the degraded rendering stays
    // stable across versions.
    expect(rollup("p", snapshot)).toBe("1. a\n  id:: blk_a\n2. b\n  id:: blk_b\n")
  })

  it("excludes orphan node rows (no inbound link) without crashing", () => {
    const snapshot = buildGraphSnapshot(
      [row("p", "page", "p"), row("blk_orphan", "text", "orphan")],
      [],
    )
    expect(rollup("p", snapshot)).toBe("\n")
  })

  it("ignores a link whose source row is missing", () => {
    const snapshot = buildGraphSnapshot(
      [row("p", "page", "p"), row("blk_a", "text", "a")],
      [edge("ghost", "blk_a", "a0")],
    )
    // blk_a is only reachable through the ghost — not from the page.
    expect(rollup("p", snapshot)).toBe("\n")
  })

  it("ignores non-child link kinds for containment", () => {
    const snapshot = buildGraphSnapshot(
      [row("p", "page", "p"), row("blk_a", "text", "a")],
      [edge("p", "blk_a", "a0", "ref")],
    )
    expect(rollup("p", snapshot)).toBe("\n")
  })

  it("renders unknown node types marker-free (forward compatibility)", () => {
    // The type registry has no CHECK constraint by design: rows minted by a
    // NEWER app version must degrade to plain text here, never crash.
    const snapshot = buildGraphSnapshot(
      [row("p", "page", "p"), row("blk_f", "hologram", "future content")],
      [edge("p", "blk_f", "a0")],
    )
    expect(rollup("p", snapshot)).toBe("future content\n  id:: blk_f\n")
  })

  it("tolerates malformed code-node props (bare fence, no language)", () => {
    const snapshot = buildGraphSnapshot(
      [row("p", "page", "p"), row("blk_c", "code", "x = 1", "{not json")],
      [edge("p", "blk_c", "a0")],
    )
    expect(rollup("p", snapshot)).toBe("```\nx = 1\n```\n  id:: blk_c\n")
  })

  it("renders a node reachable twice from the SAME page in both places", () => {
    // Within one note this shape is a sync artifact (the store's ingest keeps
    // a page's reachable set a tree), but the walk must treat it exactly like
    // cross-page multi-parenting: render fully at each occurrence, terminate.
    const snapshot = buildGraphSnapshot(
      [
        row("p", "page", "p"),
        row("blk_a", "ul", "a"),
        row("blk_b", "ul", "b"),
        row("blk_s", "text", "shared"),
      ],
      [
        edge("p", "blk_a", "a0"),
        edge("p", "blk_b", "a1"),
        edge("blk_a", "blk_s", "a0"),
        edge("blk_b", "blk_s", "a0"),
      ],
    )
    expect(rollup("p", snapshot)).toBe(
      [
        "- a",
        "  id:: blk_a",
        "  shared",
        "    id:: blk_s",
        "- b",
        "  id:: blk_b",
        "  shared",
        "    id:: blk_s",
        "",
      ].join("\n"),
    )
  })

  it("terminates on a self-link (node listed as its own child)", () => {
    const snapshot = buildGraphSnapshot(
      [row("p", "page", "p"), row("blk_a", "text", "a")],
      [edge("p", "blk_a", "a0"), edge("blk_a", "blk_a", "a0")],
    )
    expect(rollup("p", snapshot)).toBe("a\n  id:: blk_a\n")
  })
})

/**
 * The walk itself (`docFromGraph`), which the rollup is one instance of —
 * what a view is built from, given any set of roots. Row-first, because
 * markdown cannot express these shapes.
 */
describe("docFromGraph (the walk, N roots)", () => {
  const graph = () =>
    buildGraphSnapshot(
      [
        row("home", "page", "Home"),
        row("other", "page", "Other"),
        row("blk_a", "ul", "a"),
        row("blk_b", "text", "b"),
        row("blk_c", "todo", "c"),
        row("blk_s", "ol", "shared"),
        row("blk_t", "text", "under shared"),
      ],
      [
        edge("home", "blk_a", "a0"),
        edge("home", "blk_c", "a1"),
        edge("blk_a", "blk_b", "a0"),
        edge("blk_a", "blk_s", "a1"),
        edge("other", "blk_s", "a0"),
        edge("blk_s", "blk_t", "a0"),
      ],
    )
  const shape = (doc: BlockDoc, id: string) => {
    const block = doc.blocks[id]
    return [block.type, block.text, block.children]
  }

  it("walks each root's subtree in sort order, typed and marker-free", () => {
    const doc = docFromGraph(["blk_a"], graph())
    expect(doc.props).toBeNull()
    expect(doc.rootBlockIds).toEqual(["blk_a"])
    expect(shape(doc, "blk_a")).toEqual(["ul", "a", ["blk_b", "blk_s"]])
    expect(shape(doc, "blk_s")).toEqual(["ol", "shared", ["blk_t"]])
    expect(Object.keys(doc.blocks).sort()).toEqual(["blk_a", "blk_b", "blk_s", "blk_t"])
  })

  it("takes several roots, in the order given; a root inside another root is walked once", () => {
    const doc = docFromGraph(["blk_c", "blk_a", "blk_s"], graph())
    expect(doc.rootBlockIds).toEqual(["blk_c", "blk_a", "blk_s"])
    // `blk_s` is both a root and a child of `blk_a`: one block, two mentions.
    expect(doc.blocks.blk_a.children).toContain("blk_s")
    expect(Object.keys(doc.blocks).sort()).toEqual(["blk_a", "blk_b", "blk_c", "blk_s", "blk_t"])
  })

  it("a page is a block like any other when it is a root", () => {
    const doc = docFromGraph(["other"], graph())
    expect(shape(doc, "other")).toEqual(["page", "Other", ["blk_s"]])
  })

  it("skips missing roots and dangling children", () => {
    const doc = docFromGraph(["nope", "blk_a"], graph())
    expect(doc.rootBlockIds).toEqual(["blk_a"])
    const dangling = buildGraphSnapshot([row("blk_a", "ul", "a")], [edge("blk_a", "ghost", "a0")])
    expect(docFromGraph(["blk_a"], dangling).blocks.blk_a.children).toEqual([])
  })

  it("holds a node reached by two paths once, and a loop as a loop", () => {
    const doc = docFromGraph(["home", "other"], graph())
    expect(doc.blocks.blk_s.children).toEqual(["blk_t"])
    expect(doc.blocks.other.children).toEqual(["blk_s"])
    const cyclic = buildGraphSnapshot(
      [row("blk_a", "text", "a"), row("blk_b", "text", "b")],
      [edge("blk_a", "blk_b", "a0"), edge("blk_b", "blk_a", "a0")],
    )
    // Each node once; b names a as its child — the loop is the doc's shape,
    // and every walk over the doc ends where it closes (view.test.ts).
    const looped = docFromGraph(["blk_a"], cyclic)
    expect(looped.blocks.blk_a.children).toEqual(["blk_b"])
    expect(looped.blocks.blk_b.children).toEqual(["blk_a"])
  })

  it("reads props into the block and unknown types as text", () => {
    const snapshot = buildGraphSnapshot(
      [
        row("blk_c", "code", "x = 1", JSON.stringify({ language: "py" })),
        row("blk_f", "hologram", "future", "{not json"),
      ],
      [],
    )
    const doc = docFromGraph(["blk_c", "blk_f"], snapshot)
    expect(doc.blocks.blk_c.props).toEqual({ language: "py" })
    expect(doc.blocks.blk_f.type).toBe("text")
    expect(doc.blocks.blk_f.props).toBeUndefined()
  })

  it("pageDoc is the page's children with its props, and rollup is its serialization", () => {
    const snapshot = buildGraphSnapshot(
      [row("p", "page", "Titled", JSON.stringify({ tags: ["x"] })), row("blk_a", "ul", "a")],
      [edge("p", "blk_a", "a0")],
    )
    const doc = pageDoc("p", snapshot)!
    expect(doc.rootBlockIds).toEqual(["blk_a"])
    expect(doc.props).toEqual({ title: "Titled", tags: ["x"] })
    expect(serialize(doc)).toBe(rollup("p", snapshot))
    expect(pageDoc("blk_a", snapshot)).toBeNull()
  })

  it("docToParts of a walked doc reproduces the rows it was walked from (no markdown between)", () => {
    const md = canonical("# Head\n  - [ ] child\n  - 1. one\n  - 2. two\nplain\n")
    const { nodes, links } = docToGraph("note", md, 1)
    const doc = pageDoc("note", buildGraphSnapshot(nodes, links))!
    const parts = docToParts("note", doc, 1)
    const rows = (list: typeof nodes) =>
      list
        .map((n) => [n.id, n.type, n.text, n.props])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
    expect(rows(parts.nodes)).toEqual(rows(nodes))
    for (const [parent, children] of parts.childrenOf) {
      expect(children).toEqual(
        links
          .filter((l) => l.source_id === parent)
          .sort((a, b) => (a.sort_key < b.sort_key ? -1 : 1))
          .map((l) => l.destination_id),
      )
    }
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

  it("one round trip normalizes; the normalized form is a strict fixpoint (200 documents)", () => {
    const rand = mulberry32(20260829)
    for (let i = 0; i < 200; i += 1) {
      const markdown = generateDocument(rand)
      const fixed = canonical(markdown)
      const normalized = viaGraph(fixed) as string
      expect(normalized, `seed doc ${i}:\n${markdown}`).not.toBeNull()
      // The deliberate normalization pass (near-miss markers, a dropped
      // frontmatter block) converges in one step — never a byte flip-flop.
      expect(viaGraph(normalized), `seed doc ${i}:\n${markdown}`).toBe(normalized)
    }
  })

  it("the walk hands the editor the same doc the parser would (200 documents)", () => {
    // Structural equality, ids included: what `parse` reads from the rollup
    // is exactly what the walk builds from the rows — so the editor can read
    // the graph directly and nothing on screen changes.
    const rand = mulberry32(20260910)
    for (let i = 0; i < 200; i += 1) {
      const fixed = canonical(generateDocument(rand))
      const { nodes, links } = docToGraph("note", fixed, 1)
      const walked = pageDoc("note", buildGraphSnapshot(nodes, links))
      const parsed = parse(rollup("note", buildGraphSnapshot(nodes, links)) as string)
      expect(walked, `seed doc ${i}`).toEqual(parsed)
    }
  })

  it("documents built from canonical markers only round-trip byte-for-byte", () => {
    const rand = mulberry32(20260831)
    const CANONICAL_MARKERS = ["", "# ", "## ", "[ ] ", "[x] ", "- ", "> "]
    for (let i = 0; i < 100; i += 1) {
      const lines: string[] = []
      const lineCount = 1 + Math.floor(rand() * 20)
      let depth = 0
      for (let j = 0; j < lineCount; j += 1) {
        depth = Math.max(0, Math.min(depth + Math.floor(rand() * 3) - 1, 5))
        const marker = CANONICAL_MARKERS[Math.floor(rand() * CANONICAL_MARKERS.length)]
        const words = Array.from(
          { length: Math.floor(rand() * 3) },
          () => WORDS[Math.floor(rand() * WORDS.length)],
        )
        lines.push("  ".repeat(depth) + marker + words.join(" "))
      }
      const fixed = canonical(lines.join("\n") + "\n")
      expect(viaGraph(fixed), `seed doc ${i}:\n${fixed}`).toBe(fixed)
    }
  })

  it("the rollup's output is always canonical for the editor (serialize∘parse fixpoint)", () => {
    const rand = mulberry32(42)
    for (let i = 0; i < 50; i += 1) {
      const fixed = canonical(generateDocument(rand))
      const rolled = viaGraph(fixed) as string
      expect(serialize(parse(rolled))).toBe(rolled)
    }
  })

  it("randomly mutated (valid, acyclic) row graphs roll up to a graph fixpoint", () => {
    // Start from real ingested rows, then mutate the LINK rows the way saves
    // and merges do — unlink subtrees, reorder siblings, re-attach unlinked
    // subtrees elsewhere — while keeping the page's reachable set a tree with
    // no cycles (the store's invariants). Whatever shape results, the rollup
    // must be canonical markdown: re-ingesting it must reproduce it exactly.
    const rand = mulberry32(9090)
    const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]

    for (let i = 0; i < 40; i += 1) {
      const fixed = canonical(generateDocument(rand))
      const { nodes, links } = docToGraph("note", fixed, 1)
      const nonPage = nodes.filter((node) => node.type !== "page").map((node) => node.id)

      const reachableFrom = (start: string): Set<string> => {
        const seen = new Set<string>()
        const queue = [start]
        while (queue.length > 0) {
          const id = queue.pop() as string
          if (seen.has(id)) continue
          seen.add(id)
          for (const link of links) if (link.source_id === id) queue.push(link.destination_id)
        }
        return seen
      }

      const mutations = 1 + Math.floor(rand() * 6)
      for (let m = 0; m < mutations; m += 1) {
        const op = rand()
        if (op < 0.35 && links.length > 0) {
          // Unlink: cuts a subtree loose (it simply stops rendering).
          links.splice(Math.floor(rand() * links.length), 1)
        } else if (op < 0.7 && links.length > 0) {
          // Reorder: move one link to the front of its siblings.
          const moved = pick(links)
          const siblingKeys = links
            .filter((link) => link.source_id === moved.source_id)
            .map((link) => link.sort_key)
            .sort()
          moved.sort_key = sortKeyBetween(null, siblingKeys[0])
        } else if (nonPage.length > 0) {
          // Re-attach: link a subtree that fell out of the page (its root has
          // no inbound link left) back under a reachable parent — never
          // creating a cycle or a second in-page path to any node.
          const reachable = reachableFrom("note")
          const loose = nonPage.filter(
            (id) => !reachable.has(id) && !links.some((link) => link.destination_id === id),
          )
          if (loose.length === 0) continue
          const destination = pick(loose)
          const parent = pick([...reachable])
          if (reachableFrom(destination).has(parent)) continue
          links.push({
            source_id: parent,
            destination_id: destination,
            kind: "child",
            sort_key: sortKeyBetween(null, null),
            updated_at: 2,
          })
        }
      }

      const rolled = rollup("note", buildGraphSnapshot(nodes, links))
      expect(rolled, `seed doc ${i}`).not.toBeNull()
      // Tree-shaped reachability ⇒ every id renders exactly once.
      const ids = (rolled as string).match(/ {2}id:: (\S+)/g) ?? []
      expect(new Set(ids).size, `seed doc ${i}`).toBe(ids.length)
      // The mutated graph's rollup is itself a fixpoint of ingest+rollup.
      expect(viaGraph(rolled as string), `seed doc ${i}:\n${rolled}`).toBe(rolled)
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
