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
function expectEquivalent(markdown: string, noteId = "note") {
  const fixed = canonical(markdown)
  expect(viaGraph(fixed, noteId)).toBe(fixed)
  // And the canonical form is a fixpoint of the graph round-trip itself.
  expect(viaGraph(viaGraph(fixed, noteId) as string, noteId)).toBe(fixed)
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

  it("does not type fake markers inside code fences (every marker kind)", () => {
    const markdown =
      "```js\n- [ ] not a todo\n[x] not done\n# not a heading\n1. not a list\n> not a quote\n- not a bullet\n```\nafter\n"
    expectEquivalent(markdown)
    // (parse itself rewrites the GFM `- [ ]` spelling to the bare `[ ]` marker
    // before ingest sees it; the fence guard keeps it a text node either way.)
    expect(types(markdown)).toEqual([
      "text:```js",
      "text:[ ] not a todo",
      "text:[x] not done",
      "text:# not a heading",
      "text:1. not a list",
      "text:> not a quote",
      "text:- not a bullet",
      "text:```",
      "text:after",
    ])
  })

  it("an unclosed code fence keeps the rest of the note verbatim", () => {
    const markdown = "before\n```\n# still code\n[ ] still code\n1. still code\n"
    expectEquivalent(markdown)
    expect(types(markdown)).toEqual([
      "text:before",
      "text:```",
      "text:# still code",
      "text:[ ] still code",
      "text:1. still code",
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

  it("keeps transclusion text and hostile wikilink targets verbatim", () => {
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

  it("caps the walk depth so a corrupted (cyclic) graph cannot hang it", () => {
    const nodes = [row("p", "page", "p"), row("blk_x", "text", "x"), row("blk_y", "text", "y")]
    const links = [
      edge("p", "blk_x", "a0"),
      edge("blk_x", "blk_y", "a0"),
      edge("blk_y", "blk_x", "a0"),
    ]
    const markdown = rollup("p", buildGraphSnapshot(nodes, links)) as string
    expect(markdown).not.toBeNull()
    // The cycle unrolls to exactly the depth cap (64 levels), no further.
    expect(markdown.match(/ {2}id:: /g)).toHaveLength(64)
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

  it("tolerates malformed page props (renders without frontmatter)", () => {
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
    // The gap is invisible in the output, but the run restarts after it —
    // pinned so the degraded rendering stays stable across versions.
    expect(rollup("p", snapshot)).toBe("1. a\n  id:: blk_a\n1. b\n  id:: blk_b\n")
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
    const markdown = rollup("p", snapshot) as string
    expect(markdown.match(/ {2}id:: /g)).toHaveLength(64)
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
