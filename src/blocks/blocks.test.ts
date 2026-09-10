import { describe, expect, it } from "vitest"
import { parse } from "./parse"
import { serialize } from "./serialize"

// Content is written verbatim: a heading keeps `# `, a bullet its single `- `,
// a paragraph has no marker. Nesting is two-space indentation; each block's id
// sits on the line below, indented two more.
const CANONICAL = `---
title: My note
---
# A heading
  id:: blk_aaa
  - A nested bullet
    id:: blk_bbb
[ ] a todo
  id:: blk_ccc
References ((blk_aaa))
  id:: blk_ddd
`

describe("block round-trip", () => {
  it("serialize(parse(x)) === x for canonical markdown", () => {
    expect(serialize(parse(CANONICAL))).toBe(CANONICAL)
  })

  it("parses the structure and ids", () => {
    const doc = parse(CANONICAL)
    expect(doc.props).toEqual({ title: "My note" })
    expect(doc.rootBlockIds).toEqual(["blk_aaa", "blk_ccc", "blk_ddd"])
    expect(doc.blocks["blk_aaa"].type).toBe("h1")
    expect(doc.blocks["blk_aaa"].text).toBe("A heading")
    expect(doc.blocks["blk_aaa"].children).toEqual(["blk_bbb"])
    expect(doc.blocks["blk_bbb"].type).toBe("ul")
    expect(doc.blocks["blk_bbb"].text).toBe("A nested bullet")
    expect(doc.blocks["blk_ccc"].type).toBe("todo")
    expect(doc.blocks["blk_ccc"].text).toBe("a todo")
  })

  it("normalizes a multi-# heading to a single # on serialize", () => {
    // Heading size comes from outline depth, so the marker is always one `#`.
    const doc = parse(`### Deep heading\n  id:: blk_x\n`)
    expect(doc.blocks["blk_x"].type).toBe("h1")
    expect(doc.blocks["blk_x"].text).toBe("Deep heading")
    expect(serialize(doc)).toBe(`# Deep heading\n  id:: blk_x\n`)
  })

  it("does not double a bullet's marker", () => {
    // A block whose content is a bullet keeps exactly one `- ` on disk.
    const doc = parse(`- item\n  id:: blk_x\n`)
    expect(doc.blocks["blk_x"].type).toBe("ul")
    expect(doc.blocks["blk_x"].text).toBe("item")
    expect(serialize(doc)).toBe(`- item\n  id:: blk_x\n`)
  })

  it("preserves block references verbatim in content", () => {
    const doc = parse(CANONICAL)
    expect(doc.blocks["blk_ddd"].text).toBe("References ((blk_aaa))")
  })

  it("round-trips an empty block", () => {
    const md = `\n  id:: blk_x\n`
    const doc = parse(md)
    expect(doc.blocks["blk_x"].text).toBe("")
    expect(serialize(doc)).toBe(md)
  })

  it("mints ids for id-less markdown, then is stable across a round-trip", () => {
    const doc1 = parse(`first\nsecond\n`)
    expect(doc1.rootBlockIds).toHaveLength(2)
    for (const id of doc1.rootBlockIds) expect(id).toMatch(/^blk_[0-9a-z]{10}$/)
    const serialized = serialize(doc1)
    const doc2 = parse(serialized)
    expect(doc2.rootBlockIds).toEqual(doc1.rootBlockIds)
    expect(serialize(doc2)).toBe(serialized)
  })

  it("keeps the glyph of a bullet-wrapped marker (outliner and task-list shapes)", () => {
    const doc = parse(
      [
        "- # Heading",
        "- [ ] task",
        "* [x] done",
        "+ > quote",
        "- plain bullet",
        "- - a dash in text",
        "- ```js",
        "x = 1",
        "```",
      ].join("\n"),
    )
    const typed = doc.rootBlockIds.map((id) => [doc.blocks[id].type, doc.blocks[id].text])
    expect(typed).toEqual([
      ["h1", "Heading"],
      ["todo", "task"],
      ["done", "done"],
      ["quote", "quote"],
      ["ul", "plain bullet"],
      ["ul", "- a dash in text"],
      // A fence keeps its backticks as text (fences are not typed on import);
      // the bullet that wrapped it is dropped like any other.
      ["text", "```js"],
      ["text", "x = 1"],
      ["text", "```"],
    ])
  })

  it("imports plain markdown lines as blocks", () => {
    const doc = parse(`# A heading\nA loose paragraph\n`)
    expect(doc.rootBlockIds).toHaveLength(2)
    const blocks = doc.rootBlockIds.map((id) => [doc.blocks[id].type, doc.blocks[id].text])
    expect(blocks).toEqual([
      ["h1", "A heading"],
      ["text", "A loose paragraph"],
    ])
  })
})

describe("duplicate ids", () => {
  it("keeps both blocks when an id:: is duplicated (no clobber)", () => {
    // Two top-level blocks share `id:: blk_dup` — e.g. a block copy-pasted with
    // its id line in an external editor. Both must survive as distinct blocks.
    const doc = parse(`first\n  id:: blk_dup\nsecond\n  id:: blk_dup\n`)
    expect(doc.rootBlockIds).toHaveLength(2)
    expect(Object.keys(doc.blocks)).toHaveLength(2)
    const [firstId, secondId] = doc.rootBlockIds
    expect(firstId).not.toBe(secondId)
    expect(doc.rootBlockIds.map((id) => doc.blocks[id].text)).toEqual(["first", "second"])
    // The first occurrence keeps the on-disk id; the duplicate is regenerated.
    expect(firstId).toBe("blk_dup")
    expect(secondId).toMatch(/^blk_[0-9a-z]{10}$/)
  })

  it("regenerates duplicate ids among siblings under one parent", () => {
    const doc = parse(`parent\n  id:: blk_p\n  a\n    id:: blk_c\n  b\n    id:: blk_c\n`)
    const children = doc.blocks["blk_p"].children
    expect(children).toHaveLength(2)
    expect(children[0]).not.toBe(children[1])
    expect(doc.blocks[children[0]].text).toBe("a")
    expect(doc.blocks[children[1]].text).toBe("b")
  })
})

describe("frontmatter handling (the markdown edge)", () => {
  it("returns null props when there is no frontmatter", () => {
    const doc = parse(`just a block\n  id:: blk_x\n`)
    expect(doc.props).toBeNull()
    expect(serialize(doc)).toBe(`just a block\n  id:: blk_x\n`)
  })

  it("imports multi-line YAML as entries (lines that look like blocks included) and converges", () => {
    const md = `---
title: My note
tags:
  - foo
  - bar
date: 2026-08-20
---
A block
  id:: blk_x
`
    const doc = parse(md)
    expect(doc.props).toEqual({
      title: "My note",
      tags: ["foo", "bar"],
      date: "2026-08-20T00:00:00.000Z",
    })
    expect(doc.rootBlockIds).toEqual(["blk_x"])
    // Non-canonical YAML converges to the canonical form in one step.
    const once = serialize(doc)
    expect(once).toBe(
      "---\ntitle: My note\ntags: [foo, bar]\ndate: 2026-08-20T00:00:00.000Z\n---\nA block\n  id:: blk_x\n",
    )
    expect(serialize(parse(once))).toBe(once)
  })

  it("keeps an empty frontmatter block distinct from none", () => {
    const md = `---\n\n---\nA block\n  id:: blk_x\n`
    const doc = parse(md)
    expect(doc.props).toEqual({})
    expect(serialize(doc)).toBe(md)
  })
})

describe("nesting", () => {
  it("round-trips three levels of nesting", () => {
    const md = `one
  id:: blk_1
  two
    id:: blk_2
    three
      id:: blk_3
`
    const doc = parse(md)
    expect(doc.rootBlockIds).toEqual(["blk_1"])
    expect(doc.blocks["blk_1"].children).toEqual(["blk_2"])
    expect(doc.blocks["blk_2"].children).toEqual(["blk_3"])
    expect(doc.blocks["blk_3"].children).toEqual([])
    expect(serialize(doc)).toBe(md)
  })

  it("pops back to a shallower level correctly", () => {
    const doc = parse(`a\n  a1\nb\n`)
    expect(doc.rootBlockIds).toHaveLength(2)
    const [aId, bId] = doc.rootBlockIds
    expect(doc.blocks[aId].text).toBe("a")
    expect(doc.blocks[aId].children).toHaveLength(1)
    expect(doc.blocks[bId].text).toBe("b")
    expect(doc.blocks[bId].children).toEqual([])
  })
})

describe("indent normalization (pasted outlines)", () => {
  const childrenOf = (doc: ReturnType<typeof parse>, id: string) =>
    doc.blocks[id].children.map((cid) => doc.blocks[cid].text)

  it("treats each leading tab as one nesting level", () => {
    const doc = parse("- a\n\t- b\n\t\t- c\n- d")
    expect(doc.rootBlockIds).toHaveLength(2)
    const [aId, dId] = doc.rootBlockIds
    expect(doc.blocks[aId].type).toBe("ul")
    expect(doc.blocks[aId].text).toBe("a")
    expect(childrenOf(doc, aId)).toEqual(["b"])
    expect(childrenOf(doc, doc.blocks[aId].children[0])).toEqual(["c"])
    expect(doc.blocks[dId].type).toBe("ul")
    expect(doc.blocks[dId].text).toBe("d")
  })

  it("infers a 4-space indent unit when every indent is a multiple of 4", () => {
    const doc = parse("- a\n    - b\n        - c\n    - d")
    expect(doc.rootBlockIds).toHaveLength(1)
    const aId = doc.rootBlockIds[0]
    expect(childrenOf(doc, aId)).toEqual(["b", "d"])
    expect(childrenOf(doc, doc.blocks[aId].children[0])).toEqual(["c"])
  })

  it("keeps 2-space content at 2-space levels (a 4-space line means depth 2)", () => {
    const doc = parse("- a\n  - b\n    - c")
    const aId = doc.rootBlockIds[0]
    expect(childrenOf(doc, aId)).toEqual(["b"])
    expect(childrenOf(doc, doc.blocks[aId].children[0])).toEqual(["c"])
  })

  it("keeps serialized 2-space content byte-identical through a round-trip", () => {
    // A nested fixture whose serialized indents include multiples of 4 — the
    // root `id::` lines at two spaces must keep the inferred unit at 2.
    const doc = parse("- a\n  - b\n    - c\n      - d\nplain")
    const serialized = serialize(doc)
    expect(serialize(parse(serialized))).toBe(serialized)
  })
})

describe("content preservation", () => {
  it("keeps markdown syntax untouched in block content", () => {
    const md = `# A heading
  id:: blk_a
**bold** and _italic_ and \`code\`
  id:: blk_b
[ ] unchecked
  id:: blk_c
[x] checked
  id:: blk_d
> a quote
  id:: blk_e
[a link](https://example.com)
  id:: blk_f
`
    const doc = parse(md)
    expect(doc.blocks["blk_a"].type).toBe("h1")
    expect(doc.blocks["blk_a"].text).toBe("A heading")
    expect(doc.blocks["blk_b"].text).toBe("**bold** and _italic_ and `code`")
    expect(doc.blocks["blk_c"].type).toBe("todo")
    expect(doc.blocks["blk_c"].text).toBe("unchecked")
    expect(doc.blocks["blk_d"].type).toBe("done")
    expect(doc.blocks["blk_d"].text).toBe("checked")
    expect(doc.blocks["blk_e"].type).toBe("quote")
    expect(doc.blocks["blk_e"].text).toBe("a quote")
    expect(doc.blocks["blk_f"].text).toBe("[a link](https://example.com)")
    expect(serialize(doc)).toBe(md)
  })
})

describe("whitespace and line endings", () => {
  it("normalizes CRLF so ids and content never carry a stray \\r", () => {
    const md = `---\r\ntitle: t\r\n---\r\na block\r\n  id:: blk_a\r\n  child\r\n    id:: blk_b\r\n`
    const doc = parse(md)
    expect(doc.props).toEqual({ title: "t" })
    expect(doc.blocks["blk_a"].text).toBe("a block")
    expect(doc.blocks["blk_a"].children).toEqual(["blk_b"])
    expect(doc.blocks["blk_b"].text).toBe("child")
    expect(serialize(doc)).toBe(
      `---\ntitle: t\n---\na block\n  id:: blk_a\n  child\n    id:: blk_b\n`,
    )
  })

  it("parses an empty document to an empty doc", () => {
    const doc = parse("")
    expect(doc.props).toBeNull()
    expect(doc.rootBlockIds).toEqual([])
    expect(doc.blocks).toEqual({})
  })

  it("parses a whitespace-only document to an empty doc", () => {
    const doc = parse("   \n\n  \n")
    expect(doc.rootBlockIds).toEqual([])
    expect(doc.blocks).toEqual({})
  })
})
