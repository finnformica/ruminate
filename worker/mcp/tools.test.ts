import { beforeEach, describe, expect, it } from "vitest"
import { loadSnapshot } from "./graph-access"
import { grantFromRow, type Grant, type McpTokenRow } from "./grant"
import { callTool, toolsFor, TOOLS } from "./tools"
import { createMcpTestEnv, type McpTestEnv } from "./test-support"

/**
 * The tools against a REAL engine and the REAL schema, with two tenants and
 * several grants in play.
 *
 * Two things are pinned here. The first is that the tools do what they say —
 * traverse, read, write. The second, and the reason most of these tests
 * exist, is that a grant is a WALL: a scoped token cannot see, name, search,
 * traverse into, edit or delete anything outside its notes, and no argument
 * it can send changes that. Each of those is a separate test because each is
 * a separate way the wall could have a hole in it.
 */

const USER = 7
const OTHER_USER = 8

const grantOf = (overrides: Partial<McpTokenRow>): Grant => {
  const decision = grantFromRow({
    id: "mcp_test",
    user_id: USER,
    name: "Test",
    permissions: "read,write,delete",
    note_ids: null,
    expires_at: null,
    revoked_at: null,
    ...overrides,
  })
  if (!decision.ok) throw new Error("expected a grant")
  return decision.grant
}

/** Run a tool and expect it to succeed, returning its structured data. */
async function run(
  harness: McpTestEnv,
  grant: Grant,
  name: string,
  args: Record<string, unknown> = {},
): Promise<any> {
  const called = await callTool(grant, harness.tenant(grant.userId), name, args)
  if (called.kind !== "result") throw new Error(`unexpected: ${called.message}`)
  if (!called.outcome.ok) throw new Error(`tool failed: ${called.outcome.message}`)
  return called.outcome.data
}

/** Run a tool and expect a tool-execution error, returning the message. */
async function refuse(
  harness: McpTestEnv,
  grant: Grant,
  name: string,
  args: Record<string, unknown> = {},
): Promise<string> {
  const called = await callTool(grant, harness.tenant(grant.userId), name, args)
  if (called.kind === "unknown_tool") return called.message
  if (called.outcome.ok) throw new Error(`expected a refusal, got a result`)
  return called.outcome.message
}

/** The texts of a note's outline blocks, in order. */
async function textsOf(grant: Grant, noteId: string): Promise<string[]> {
  const data = await run(harness, grant, "read_note", { note_id: noteId })
  return data.blocks.map((block: any) => block.text)
}

/** Put ALPHA's outline into its Unassigned section. */
async function orphanAlphaOutline() {
  const heading = (await run(harness, grantOf({}), "list_children", { block_id: ALPHA }))
    .children[0]
  await run(harness, grantOf({}), "unlink_block", { parent_id: ALPHA, block_id: heading.id })
}

let harness: McpTestEnv
const ALPHA = "blk_alpha"
const BETA = "blk_beta"
/** Seeded per-test where a three-level outline is needed. */
const DEEP = "blk_deep"

beforeEach(async () => {
  harness = await createMcpTestEnv()
  await harness.addUser(USER)
  await harness.addUser(OTHER_USER)
  await harness.seedNote(USER, {
    id: ALPHA,
    title: "Alpha",
    markdown: "# Heading\n  - a bullet\n  - [ ] a task #work\n",
    updatedAt: 2000,
  })
  await harness.seedNote(USER, {
    id: BETA,
    title: "Beta",
    markdown: "- beta content #home\n",
    updatedAt: 3000,
  })
})

// -----------------------------------------------------------------------------
// The tool list
// -----------------------------------------------------------------------------

describe("toolsFor", () => {
  it("lists only what the grant permits", () => {
    const names = (grant: Grant) => toolsFor(grant).map((tool) => tool.name)

    expect(names(grantOf({ permissions: "read" }))).not.toContain("create_blocks")
    expect(names(grantOf({ permissions: "read" }))).not.toContain("delete_note")
    expect(names(grantOf({ permissions: "read" }))).toContain("read_note")
    expect(names(grantOf({ permissions: "read,write" }))).toContain("create_blocks")
    expect(names(grantOf({ permissions: "read,write" }))).not.toContain("delete_note")
    expect(names(grantOf({ permissions: "read,write,delete" }))).toContain("delete_note")
  })

  it("lists nothing for a grant with no permissions", () => {
    expect(toolsFor(grantOf({ permissions: "" }))).toEqual([])
  })

  it("keeps a stable order, as the spec asks", () => {
    const grant = grantOf({})
    expect(toolsFor(grant).map((t) => t.name)).toEqual(TOOLS.map((t) => t.name))
  })
})

// -----------------------------------------------------------------------------
// Reads and traversal
// -----------------------------------------------------------------------------

describe("list_notes", () => {
  it("lists the tenant's notes, most recently updated first", async () => {
    const data = await run(harness, grantOf({}), "list_notes")
    expect(data.notes.map((note: any) => note.id)).toEqual([BETA, ALPHA])
    expect(data.notes[1].title).toBe("Alpha")
  })

  it("surfaces tags read off the blocks, as the app does", async () => {
    const data = await run(harness, grantOf({}), "list_notes")
    const alpha = data.notes.find((note: any) => note.id === ALPHA)
    expect(alpha.tags).toContain("work")
    expect(alpha.openTaskCount).toBe(1)
  })

  it("filters by tag, with or without the leading hash", async () => {
    const grant = grantOf({})
    expect((await run(harness, grant, "list_notes", { tag: "home" })).notes).toHaveLength(1)
    expect((await run(harness, grant, "list_notes", { tag: "#home" })).notes).toHaveLength(1)
    expect((await run(harness, grant, "list_notes", { tag: "nope" })).notes).toHaveLength(0)
  })

  it("filters by note type", async () => {
    const grant = grantOf({})
    expect((await run(harness, grant, "list_notes", { type: "note" })).notes).toHaveLength(2)
    expect((await run(harness, grant, "list_notes", { type: "daily" })).notes).toHaveLength(0)
  })

  it("does not take a text query — that is `search`'s job", async () => {
    // `query` used to match only a note's title and its first 20 words, so a
    // term further down the note silently returned nothing. Better to have no
    // filter than a filter that lies.
    const tool = TOOLS.find((entry) => entry.name === "list_notes")
    const props = (tool?.inputSchema as { properties: Record<string, unknown> }).properties
    expect(Object.keys(props)).not.toContain("query")
  })

  it("pages with a cursor", async () => {
    const first = await run(harness, grantOf({}), "list_notes", { limit: 1 })
    expect(first.notes).toHaveLength(1)
    expect(first.nextCursor).toBe("1")

    const second = await run(harness, grantOf({}), "list_notes", {
      limit: 1,
      cursor: first.nextCursor,
    })
    expect(second.notes[0].id).toBe(ALPHA)
    expect(second.nextCursor).toBeNull()
  })

  it("refuses a cursor it did not issue", async () => {
    expect(await refuse(harness, grantOf({}), "list_notes", { cursor: "../../etc" })).toMatch(
      /cursor/,
    )
  })
})

describe("read_note", () => {
  it("returns the note's blocks as stored rows, not markdown", async () => {
    const data = await run(harness, grantOf({}), "read_note", {
      note_id: ALPHA,
      include: ["counts"],
    })

    expect(data).not.toHaveProperty("markdown")
    expect(data.title).toBe("Alpha")
    expect(data.blockCount).toBe(3)

    const heading = data.blocks.find((block: any) => block.type === "h1")
    expect(heading.text).toBe("Heading")
    expect(heading.depth).toBe(0)
    expect(heading.childIds).toHaveLength(2)
    expect(heading.updatedAt).toBeGreaterThan(0)
  })

  it("carries each block's stored type and metadata", async () => {
    const data = await run(harness, grantOf({}), "read_note", { note_id: ALPHA })
    const types = data.blocks.map((block: any) => block.type)

    // The stored types, not rendered markers.
    expect(types).toContain("h1")
    expect(types).toContain("ul")
    expect(types).toContain("todo")
  })

  it("omits empty fields rather than sending null", async () => {
    const data = await run(harness, grantOf({}), "read_note", { note_id: BETA })
    const block = data.blocks[0]

    expect(block).not.toHaveProperty("props")
    expect(block).not.toHaveProperty("childIds")
    expect(block.writtenInNoteId).toBe(BETA)
  })

  it("reads only the top levels when asked, and says where it stopped", async () => {
    const shallow = await run(harness, grantOf({}), "read_note", {
      note_id: ALPHA,
      depth: 1,
      include: ["counts"],
    })

    expect(shallow.blocks).toHaveLength(1)
    expect(shallow.blocks[0].hasMoreChildren).toBe(true)
    expect(shallow.truncated).toBe(true)
    // Asked for, so still reported: the agent knows what it has not seen.
    expect(shallow.blockCount).toBe(3)
  })

  it("defaults to the top levels, not the whole note", async () => {
    // A note three levels deep, which the default depth cannot cover.
    await harness.seedNote(USER, { id: DEEP, markdown: "# One\n  - two\n    - three\n" })

    const shallow = await run(harness, grantOf({}), "read_note", {
      note_id: DEEP,
      include: ["counts"],
    })
    expect(shallow.blocks).toHaveLength(2)
    expect(shallow.truncated).toBe(true)
    expect(shallow.blockCount).toBe(3)
    // And it says exactly where the rest is.
    expect(shallow.blocks[1].hasMoreChildren).toBe(true)
  })

  it("reads the whole note when asked with depth 0", async () => {
    await harness.seedNote(USER, { id: DEEP, markdown: "# One\n  - two\n    - three\n" })

    const full = await run(harness, grantOf({}), "read_note", { note_id: DEEP, depth: 0 })
    expect(full.blocks).toHaveLength(3)
    expect(full.truncated).toBe(false)
  })

  it("is not truncated when the depth covers the whole note", async () => {
    const full = await run(harness, grantOf({}), "read_note", { note_id: ALPHA, depth: 5 })
    expect(full.truncated).toBe(false)
    expect(full.blocks).toHaveLength(3)
  })

  it("refuses a note that does not exist", async () => {
    expect(await refuse(harness, grantOf({}), "read_note", { note_id: "nope" })).toMatch(
      /No such note/,
    )
  })

  it("refuses a note id that is really a block id", async () => {
    const children = await run(harness, grantOf({}), "list_children", { block_id: ALPHA })
    expect(
      await refuse(harness, grantOf({}), "read_note", { note_id: children.children[0].id }),
    ).toMatch(/No such note/)
  })
})

describe("traversal", () => {
  it("walks down from a note through list_children", async () => {
    const grant = grantOf({})
    const roots = await run(harness, grant, "list_children", { block_id: ALPHA })
    expect(roots.children.map((child: any) => child.type)).toEqual(["h1"])

    const heading = roots.children[0]
    const beneath = await run(harness, grant, "list_children", { block_id: heading.id })
    expect(beneath.children.map((child: any) => child.text)).toEqual(["a bullet", "a task #work"])
  })

  it("pulls several levels at once with depth, tagging each block's level", async () => {
    const data = await run(harness, grantOf({}), "list_children", { block_id: ALPHA, depth: 2 })

    expect(data.children).toHaveLength(3)
    expect(data.children[0].depth).toBe(0)
    expect(data.children[1].depth).toBe(1)
    expect(data.directChildCount).toBe(1)
    expect(data.truncated).toBe(false)
  })

  it("walks up from a block through list_parents, back to its note", async () => {
    const grant = grantOf({})
    const heading = (await run(harness, grant, "list_children", { block_id: ALPHA })).children[0]
    const bullet = (await run(harness, grant, "list_children", { block_id: heading.id }))
      .children[0]

    const parents = await run(harness, grant, "list_parents", { block_id: bullet.id })
    expect(parents.parents.map((parent: any) => parent.id)).toEqual([heading.id])
    expect(parents.noteIds).toEqual([ALPHA])
    expect(parents.notes[0].title).toBe("Alpha")
  })

  it("describes a single block with get_block", async () => {
    const grant = grantOf({})
    const heading = (await run(harness, grant, "list_children", { block_id: ALPHA })).children[0]

    const block = await run(harness, grant, "get_block", { block_id: heading.id })
    expect(block.type).toBe("h1")
    expect(block.text).toBe("Heading")
    expect(block.childIds).toHaveLength(2)
    expect(block.parentIds).toEqual([ALPHA])
    expect(block.noteIds).toEqual([ALPHA])
    expect(block.writtenInNoteId).toBe(ALPHA)
    // `type` says what it is; there is no second flag saying the same thing.
    expect(block.type).not.toBe("note")
  })

  it("treats a note as a block too", async () => {
    const block = await run(harness, grantOf({}), "get_block", { block_id: ALPHA })
    expect(block.type).toBe("note")
    expect(block.text).toBe("Alpha")
  })
})

describe("search and tags", () => {
  it("finds a block by substring and names the note it is in", async () => {
    const data = await run(harness, grantOf({}), "search", { query: "bullet" })
    expect(data.hits).toHaveLength(1)
    expect(data.hits[0].noteIds).toEqual([ALPHA])
    expect(data.hits[0].noteTitles).toEqual(["Alpha"])
  })

  it("is case-insensitive and never matches a note node", async () => {
    expect((await run(harness, grantOf({}), "search", { query: "BULLET" })).hits).toHaveLength(1)
    // "Alpha" is the note's own text, and a note is not a block hit.
    expect((await run(harness, grantOf({}), "search", { query: "Alpha" })).hits).toHaveLength(0)
  })

  it("counts tags across the notes it can reach", async () => {
    const data = await run(harness, grantOf({}), "list_tags")
    expect(data.tags.map((entry: any) => entry.tag).sort()).toEqual(["home", "work"])
  })
})

// -----------------------------------------------------------------------------
// Bounds
// -----------------------------------------------------------------------------

/**
 * Nothing this server returns is unbounded, and nothing it cuts is cut
 * silently: every collection has a `limit`, and every one an agent could
 * legitimately want the rest of has a `cursor` — the same opaque digit-string
 * offset on every tool, refused if it was not issued by a previous call. The
 * one place a cursor would make no sense (a point read's embedded id lists)
 * says which tool to call instead.
 */
describe("every collection is bounded", () => {
  /** A block with more children than any one response will embed. */
  async function wideBlock(count: number): Promise<string> {
    const blocks = Array.from({ length: count }, (_, at) => ({ text: `row ${at}` }))
    await run(harness, grantOf({}), "create_blocks", { parent_id: BETA, blocks })
    return BETA
  }

  it("pages `search` with a cursor", async () => {
    const grant = grantOf({})
    const first = await run(harness, grant, "search", { query: "a", limit: 1 })
    expect(first.hits).toHaveLength(1)
    expect(first.truncated).toBe(true)
    expect(first.nextCursor).toBe("1")

    const second = await run(harness, grant, "search", {
      query: "a",
      limit: 1,
      cursor: first.nextCursor,
    })
    expect(second.hits[0].id).not.toBe(first.hits[0].id)
  })

  it("pages `list_children` with a cursor rather than cutting with no recourse", async () => {
    const grant = grantOf({})
    const first = await run(harness, grant, "list_children", {
      block_id: ALPHA,
      depth: 2,
      limit: 1,
    })
    expect(first.children).toHaveLength(1)
    expect(first.total).toBe(3)
    expect(first.truncated).toBe(true)
    expect(first.nextCursor).toBe("1")

    const rest = await run(harness, grant, "list_children", {
      block_id: ALPHA,
      depth: 2,
      limit: 50,
      cursor: first.nextCursor,
    })
    expect(rest.children).toHaveLength(2)
    expect(rest.nextCursor).toBeNull()
  })

  it("bounds and pages `list_parents`", async () => {
    const grant = grantOf({})
    const heading = (await run(harness, grant, "list_children", { block_id: ALPHA })).children[0]
    const data = await run(harness, grant, "list_parents", { block_id: heading.id, limit: 1 })
    expect(data.parents).toHaveLength(1)
    expect(data.parentCount).toBe(1)
    expect(data.noteCount).toBe(1)
    expect(data.nextCursor).toBeNull()
  })

  it("bounds and pages `list_tags`", async () => {
    const grant = grantOf({})
    const first = await run(harness, grant, "list_tags", { limit: 1 })
    expect(first.tags).toHaveLength(1)
    expect(first.total).toBe(2)
    expect(first.nextCursor).toBe("1")

    const second = await run(harness, grant, "list_tags", { limit: 1, cursor: first.nextCursor })
    expect(second.tags[0].tag).not.toBe(first.tags[0].tag)
    expect(second.nextCursor).toBeNull()
  })

  it("caps the ids a `get_block` embeds, and says where the rest are", async () => {
    // A point read has no cursor, so it must steer instead of cutting
    // silently: the counts are true and the text names the tool that pages.
    const id = await wideBlock(60)
    const called = await callTool(grantOf({}), harness.tenant(USER), "get_block", { block_id: id })
    if (called.kind !== "result" || !called.outcome.ok) throw new Error("get_block failed")
    const data = called.outcome.data as any

    expect(data.childIds).toHaveLength(50)
    expect(data.childCount).toBe(61)
    expect(data.hasMoreChildren).toBe(true)
    expect(called.outcome.text).toMatch(/list_children/)

    // And the tool it points at really does return the rest.
    const rest = await run(harness, grantOf({}), "list_children", {
      block_id: id,
      limit: 200,
      cursor: "50",
    })
    expect(rest.children).toHaveLength(11)
  })

  it("bounds `read_note` by count as well as by depth", async () => {
    // `depth` is a structural bound: a note 500 rows WIDE is still enormous
    // one level down, so there is a cardinal bound too — and `blockCount`
    // keeps reporting the note's true size through both.
    const id = await wideBlock(60)
    const first = await run(harness, grantOf({}), "read_note", {
      note_id: id,
      depth: 0,
      limit: 10,
      include: ["counts"],
    })
    expect(first.blocks).toHaveLength(10)
    expect(first.blockCount).toBe(61)
    expect(first.truncated).toBe(true)
    expect(first.nextCursor).toBe("10")

    const later = await run(harness, grantOf({}), "read_note", {
      note_id: id,
      depth: 0,
      limit: 200,
      cursor: first.nextCursor,
    })
    expect(later.blocks).toHaveLength(51)
    expect(later.nextCursor).toBeNull()
  })

  it("pages a note's Unassigned section in the same sequence as its outline", async () => {
    await orphanAlphaOutline()
    const basket = { include: ["unassigned"] }
    const whole = await run(harness, grantOf({}), "read_note", {
      note_id: ALPHA,
      depth: 0,
      ...basket,
    })
    expect(whole.blocks).toEqual([])
    expect(whole.unassignedCount).toBe(3)

    const first = await run(harness, grantOf({}), "read_note", {
      note_id: ALPHA,
      depth: 0,
      limit: 1,
      ...basket,
    })
    expect(first.unassigned).toHaveLength(1)
    expect(first.nextCursor).toBe("1")

    const rest = await run(harness, grantOf({}), "read_note", {
      note_id: ALPHA,
      depth: 0,
      limit: 50,
      cursor: first.nextCursor,
      ...basket,
    })
    expect(rest.unassigned).toHaveLength(2)
    expect(rest.nextCursor).toBeNull()
  })

  it("refuses a cursor it did not issue, on every tool that takes one", async () => {
    const grant = grantOf({})
    const calls: [string, Record<string, unknown>][] = [
      ["list_notes", { cursor: "../../etc" }],
      ["search", { query: "a", cursor: "../../etc" }],
      ["list_children", { block_id: ALPHA, cursor: "../../etc" }],
      ["list_parents", { block_id: ALPHA, cursor: "../../etc" }],
      ["list_tags", { cursor: "../../etc" }],
      ["read_note", { note_id: ALPHA, cursor: "../../etc" }],
    ]
    for (const [name, args] of calls) {
      expect(await refuse(harness, grant, name, args), name).toMatch(/cursor/)
    }
  })

  it("caps `depth` rather than walking however deep it is asked to", async () => {
    // A depth-bounded read is a recursive walk, and the graph can hold a loop.
    const tool = TOOLS.find((entry) => entry.name === "list_children")
    const schema = tool?.inputSchema as { properties: { depth: { maximum: number } } }
    expect(schema.properties.depth.maximum).toBe(32)
  })
})

// -----------------------------------------------------------------------------
// The Unassigned basket
// -----------------------------------------------------------------------------

describe("unassigned blocks", () => {
  /** Unlink ALPHA's only top-level row, which parks the heading and its
   * children in the note's Unassigned section — the app's never-lose-work
   * rule: nothing is deleted, it just falls out of reach. */
  async function orphanAlpha() {
    const heading = (await run(harness, grantOf({}), "list_children", { block_id: ALPHA }))
      .children[0]
    await run(harness, grantOf({}), "unlink_block", { parent_id: ALPHA, block_id: heading.id })
    return heading
  }

  /** The basket is not free — it is a question about every block WRITTEN in
   * the note, not about the blocks the outline returned — so it is asked for.
   * Every read below asks. */
  const basket = { include: ["unassigned"] }

  it("is not returned unless it is asked for", async () => {
    // It is the one opt-in part that LOOKS like it should be free: usually
    // empty, always small. But learning that it is empty means looking at
    // every block written in the note.
    const data = await run(harness, grantOf({}), "read_note", { note_id: ALPHA })
    expect(data).not.toHaveProperty("unassigned")
    expect(data).not.toHaveProperty("unassignedCount")
  })

  it("is empty for a note whose blocks are all in its outline", async () => {
    const data = await run(harness, grantOf({}), "read_note", { note_id: ALPHA, ...basket })
    expect(data.unassigned).toEqual([])
  })

  it("reports a block that fell out of the outline, as a row", async () => {
    const heading = await orphanAlpha()
    const data = await run(harness, grantOf({}), "read_note", { note_id: ALPHA, ...basket })

    expect(data.unassigned.map((block: any) => block.id)).toContain(heading.id)
    expect(data.unassigned[0].text).toBe("Heading")
  })

  it("carries what the orphaned block still holds", async () => {
    await orphanAlpha()
    const data = await run(harness, grantOf({}), "read_note", { note_id: ALPHA, ...basket })
    const texts = data.unassigned.map((block: any) => block.text)

    expect(texts).toContain("a bullet")
    expect(texts).toContain("a task #work")
  })

  it("keeps them out of the note's outline", async () => {
    await orphanAlpha()
    const data = await run(harness, grantOf({}), "read_note", { note_id: ALPHA, ...basket })

    expect(data.blocks).toEqual([])
  })

  it("reports nothing for another note", async () => {
    await orphanAlpha()
    expect(
      (await run(harness, grantOf({}), "read_note", { note_id: BETA, ...basket })).unassigned,
    ).toEqual([])
  })

  it("stops reporting a block once it is linked back into the outline", async () => {
    const heading = await orphanAlpha()
    await run(harness, grantOf({}), "link_block", { parent_id: ALPHA, block_id: heading.id })

    const data = await run(harness, grantOf({}), "read_note", { note_id: ALPHA, ...basket })
    expect(data.unassigned).toEqual([])
    expect(data.blocks.map((block: any) => block.id)).toContain(heading.id)
  })
})

describe("note scope", () => {
  const scoped = () => grantOf({ note_ids: `["${ALPHA}"]` })

  it("lists only the notes it names", async () => {
    const data = await run(harness, scoped(), "list_notes")
    expect(data.notes.map((note: any) => note.id)).toEqual([ALPHA])
  })

  it("cannot read a note outside the scope, even by naming it exactly", async () => {
    expect(await refuse(harness, scoped(), "read_note", { note_id: BETA })).toMatch(/No such note/)
  })

  it("cannot search into a note outside the scope", async () => {
    const data = await run(harness, scoped(), "search", { query: "beta" })
    expect(data.hits).toEqual([])
  })

  it("cannot see a tag that only exists outside the scope", async () => {
    const data = await run(harness, scoped(), "list_tags")
    expect(data.tags.map((entry: any) => entry.tag)).toEqual(["work"])
  })

  it("cannot traverse into a block of a note outside the scope", async () => {
    // Find a real block id from the unrestricted view, then present it to the
    // scoped grant — the exact move a prompt-injected agent would make.
    const outside = (await run(harness, grantOf({}), "list_children", { block_id: BETA }))
      .children[0]

    expect(await refuse(harness, scoped(), "get_block", { block_id: outside.id })).toMatch(
      /No such block/,
    )
    expect(await refuse(harness, scoped(), "list_children", { block_id: outside.id })).toMatch(
      /No such block/,
    )
    expect(await refuse(harness, scoped(), "list_parents", { block_id: outside.id })).toMatch(
      /No such block/,
    )
  })

  it("cannot add to, retitle or delete a note outside the scope", async () => {
    expect(
      await refuse(harness, scoped(), "create_blocks", {
        parent_id: BETA,
        blocks: [{ text: "hijacked" }],
      }),
    ).toMatch(/No such block/)
    expect(
      await refuse(harness, scoped(), "set_note_title", { note_id: BETA, title: "hijacked" }),
    ).toMatch(/No such note/)
    expect(await refuse(harness, scoped(), "delete_note", { note_id: BETA })).toMatch(
      /No such note/,
    )

    // And the note is genuinely untouched.
    expect(await textsOf(grantOf({}), BETA)).toContain("beta content #home")
  })

  it("sees an Unassigned block of its note, AND what hangs beneath it", async () => {
    // Make one: unlink the heading, which leaves it and its
    // children out of reach but still written in ALPHA — the note's basket,
    // which the person still sees at the foot of the note.
    const heading = (await run(harness, grantOf({}), "list_children", { block_id: ALPHA }))
      .children[0]
    const beneath = (await run(harness, grantOf({}), "list_children", { block_id: heading.id }))
      .children[0]
    await run(harness, grantOf({}), "unlink_block", { parent_id: ALPHA, block_id: heading.id })

    // The basket root, and the block under it, are both still reachable.
    expect((await run(harness, scoped(), "get_block", { block_id: heading.id })).text).toBe(
      "Heading",
    )
    expect((await run(harness, scoped(), "get_block", { block_id: beneath.id })).id).toBe(
      beneath.id,
    )
  })

  it("does not let the basket widen the scope to another note", async () => {
    const outside = (await run(harness, grantOf({}), "list_children", { block_id: BETA }))
      .children[0]
    await orphanAlphaOutline()

    expect(await refuse(harness, scoped(), "get_block", { block_id: outside.id })).toMatch(
      /No such block/,
    )
  })

  it("is a grant over NOTHING when its scope names a note that does not exist", async () => {
    const ghost = grantOf({ note_ids: '["blk_ghost"]' })
    expect((await run(harness, ghost, "list_notes")).notes).toEqual([])
    expect(await refuse(harness, ghost, "read_note", { note_id: ALPHA })).toMatch(/No such note/)
  })

  it("is a grant over NOTHING when its stored scope was malformed", async () => {
    const broken = grantOf({ note_ids: "not json at all" })
    expect((await run(harness, broken, "list_notes")).notes).toEqual([])
  })
})

// -----------------------------------------------------------------------------
// The wall: permissions
// -----------------------------------------------------------------------------

describe("permissions", () => {
  it("refuses a write tool to a read-only grant, as a protocol error", async () => {
    const called = await callTool(
      grantOf({ permissions: "read" }),
      harness.tenant(USER),
      "create_blocks",
      { parent_id: ALPHA, blocks: [{ text: "rewritten" }] },
    )
    expect(called.kind).toBe("unknown_tool")
    if (called.kind === "unknown_tool") expect(called.message).toMatch(/'write' permission/)
  })

  it("refuses delete_note to a read+write grant", async () => {
    const called = await callTool(
      grantOf({ permissions: "read,write" }),
      harness.tenant(USER),
      "delete_note",
      { note_id: ALPHA },
    )
    expect(called.kind).toBe("unknown_tool")
    if (called.kind === "unknown_tool") expect(called.message).toMatch(/'delete' permission/)
  })

  it("leaves the note untouched when a write is refused", async () => {
    await callTool(grantOf({ permissions: "read" }), harness.tenant(USER), "create_blocks", {
      parent_id: ALPHA,
      blocks: [{ text: "rewritten" }],
    })
    expect(await textsOf(grantOf({}), ALPHA)).not.toContain("rewritten")
  })

  it("refuses even reads to a grant with no permissions", async () => {
    const called = await callTool(
      grantOf({ permissions: "" }),
      harness.tenant(USER),
      "list_notes",
      {},
    )
    expect(called.kind).toBe("unknown_tool")
  })
})

// -----------------------------------------------------------------------------
// The wall: tenancy
// -----------------------------------------------------------------------------

describe("tenancy", () => {
  it("never shows one user's notes to another's grant", async () => {
    await harness.seedNote(OTHER_USER, { id: "blk_secret", title: "Secret", markdown: "- private" })

    const mine = await run(harness, grantOf({}), "list_notes")
    expect(mine.notes.map((note: any) => note.id)).not.toContain("blk_secret")

    expect(await refuse(harness, grantOf({}), "read_note", { note_id: "blk_secret" })).toMatch(
      /No such note/,
    )
    expect((await run(harness, grantOf({}), "search", { query: "private" })).hits).toEqual([])
  })
})

// -----------------------------------------------------------------------------
// Writes
// -----------------------------------------------------------------------------

describe("create_blocks", () => {
  it("adds a block to the end of a note", async () => {
    await run(harness, grantOf({}), "create_blocks", {
      parent_id: BETA,
      blocks: [{ text: "appended" }],
    })
    expect(await textsOf(grantOf({}), BETA)).toEqual(["beta content #home", "appended"])
  })

  it("keeps every existing block id — it only adds", async () => {
    const before = await run(harness, grantOf({}), "read_note", { note_id: BETA })
    await run(harness, grantOf({}), "create_blocks", {
      parent_id: BETA,
      blocks: [{ text: "more" }],
    })
    const after = await run(harness, grantOf({}), "read_note", {
      note_id: BETA,
      include: ["unassigned"],
    })

    for (const id of before.rootBlockIds) expect(after.rootBlockIds).toContain(id)
    expect(after.unassigned).toEqual([])
  })

  it("honours index, and appends when it is omitted", async () => {
    await run(harness, grantOf({}), "create_blocks", {
      parent_id: BETA,
      blocks: [{ text: "first" }],
      index: 0,
    })
    expect(await textsOf(grantOf({}), BETA)).toEqual(["first", "beta content #home"])
  })

  it("adds several in the order given", async () => {
    await run(harness, grantOf({}), "create_blocks", {
      parent_id: BETA,
      blocks: [{ text: "one" }, { text: "two" }, { text: "three" }],
    })
    expect(await textsOf(grantOf({}), BETA)).toEqual(["beta content #home", "one", "two", "three"])
  })

  it("nests children in one call", async () => {
    const data = await run(harness, grantOf({}), "create_blocks", {
      parent_id: BETA,
      blocks: [{ type: "h1", text: "Heading", children: [{ type: "ul", text: "under it" }] }],
    })
    expect(data.created).toBe(2)

    const note = await run(harness, grantOf({}), "read_note", { note_id: BETA, depth: 0 })
    const heading = note.blocks.find((block: any) => block.text === "Heading")
    expect(heading.type).toBe("h1")
    expect(heading.childIds).toHaveLength(1)
    expect(note.blocks.find((block: any) => block.text === "under it").depth).toBe(1)
  })

  it("stores the block's type and metadata as given", async () => {
    await run(harness, grantOf({}), "create_blocks", {
      parent_id: BETA,
      blocks: [{ type: "todo", text: "a task", props: { flagged: true } }],
    })
    const note = await run(harness, grantOf({}), "read_note", { note_id: BETA })
    const task = note.blocks.find((block: any) => block.text === "a task")
    expect(task.type).toBe("todo")
    expect(task.props).toEqual({ flagged: true })
  })

  it("gives a new block the note it was written in", async () => {
    const data = await run(harness, grantOf({}), "create_blocks", {
      parent_id: BETA,
      blocks: [{ text: "fresh" }],
    })
    const block = await run(harness, grantOf({}), "get_block", { block_id: data.blockIds[0] })
    expect(block.writtenInNoteId).toBe(BETA)
  })

  it("inherits the note from the parent BLOCK, not just from a note", async () => {
    const bullet = (await run(harness, grantOf({}), "read_note", { note_id: BETA })).blocks[0]
    const data = await run(harness, grantOf({}), "create_blocks", {
      parent_id: bullet.id,
      blocks: [{ text: "nested" }],
    })
    const block = await run(harness, grantOf({}), "get_block", { block_id: data.blockIds[0] })
    expect(block.writtenInNoteId).toBe(BETA)
  })

  it("refuses a malformed block, naming the one that is wrong", async () => {
    expect(
      await refuse(harness, grantOf({}), "create_blocks", { parent_id: BETA, blocks: [] }),
    ).toMatch(/non-empty array/)
    expect(
      await refuse(harness, grantOf({}), "create_blocks", {
        parent_id: BETA,
        blocks: [{ text: "ok" }, { type: "ul" }],
      }),
    ).toMatch(/blocks\[1\]\.text/)
    expect(
      await refuse(harness, grantOf({}), "create_blocks", {
        parent_id: BETA,
        blocks: [{ text: "ok", type: "banana" }],
      }),
    ).toMatch(/unknown block type/)
  })

  it("refuses to create a note-typed block", async () => {
    expect(
      await refuse(harness, grantOf({}), "create_blocks", {
        parent_id: BETA,
        blocks: [{ text: "sneaky", type: "note" }],
      }),
    ).toMatch(/unknown block type/)
  })

  it("refuses more blocks than the per-call limit", async () => {
    const many = Array.from({ length: 201 }, (_, i) => ({ text: `b${i}` }))
    expect(
      await refuse(harness, grantOf({}), "create_blocks", { parent_id: BETA, blocks: many }),
    ).toMatch(/More than 200/)
  })
})

describe("set_note_title", () => {
  it("retitles a note", async () => {
    await run(harness, grantOf({}), "set_note_title", { note_id: BETA, title: "Renamed" })
    expect((await run(harness, grantOf({}), "read_note", { note_id: BETA })).title).toBe("Renamed")
  })

  it("clears a title back to untitled", async () => {
    await run(harness, grantOf({}), "set_note_title", { note_id: BETA, title: "" })
    const note = await run(harness, grantOf({}), "read_note", { note_id: BETA })
    // Untitled: the app falls back to the note's first words.
    expect(note.title).not.toBe("Beta")
  })

  it("writes nothing when the title already matches", async () => {
    const data = await run(harness, grantOf({}), "set_note_title", { note_id: BETA, title: "Beta" })
    expect(data.changed).toBe(0)
    expect(data.rowsWritten).toBe(0)
  })

  it("leaves the note's blocks alone", async () => {
    await run(harness, grantOf({}), "set_note_title", { note_id: BETA, title: "Renamed" })
    expect(await textsOf(grantOf({}), BETA)).toEqual(["beta content #home"])
  })

  it("refuses a block id", async () => {
    const bullet = (await run(harness, grantOf({}), "read_note", { note_id: BETA })).blocks[0]
    expect(
      await refuse(harness, grantOf({}), "set_note_title", {
        block_id: bullet.id,
        note_id: bullet.id,
        title: "x",
      }),
    ).toMatch(/No such note/)
  })
})

describe("delete_note", () => {
  it("removes the note from every read path", async () => {
    await run(harness, grantOf({}), "delete_note", { note_id: BETA })

    const list = await run(harness, grantOf({}), "list_notes")
    expect(list.notes.map((note: any) => note.id)).toEqual([ALPHA])
    expect(await refuse(harness, grantOf({}), "read_note", { note_id: BETA })).toMatch(
      /No such note/,
    )
    expect((await run(harness, grantOf({}), "search", { query: "beta content" })).hits).toEqual([])
  })

  it("tombstones rather than erasing, so the delete can replicate", async () => {
    await run(harness, grantOf({}), "delete_note", { note_id: BETA })

    const rows = await harness
      .tenant(USER)
      .includingDeleted()
      .exec(
        "SELECT id, deleted_at, seq FROM nodes WHERE user_id = :tenant AND id = ?1 " +
          "/* includes-deleted: the tombstone IS what this test is about */",
        [BETA],
      )
    expect(rows).toHaveLength(1)
    expect(rows[0].deleted_at).not.toBeNull()
    // A fresh sequence value is what carries the delete to the browser.
    expect(Number(rows[0].seq)).toBeGreaterThan(0)
  })

  it("leaves the other note alone", async () => {
    await run(harness, grantOf({}), "delete_note", { note_id: BETA })
    expect(await textsOf(grantOf({}), ALPHA)).toContain("a bullet")
  })
})

// -----------------------------------------------------------------------------
// The write path's contract with replication
// -----------------------------------------------------------------------------

describe("replication", () => {
  it("assigns a fresh server `seq` to every row an agent writes", async () => {
    const before = await loadSnapshot(harness.tenant(USER))
    await run(harness, grantOf({}), "create_blocks", {
      parent_id: ALPHA,
      blocks: [{ text: "new" }],
    })

    const rows = await harness
      .tenant(USER)
      .includingDeleted()
      .exec(
        "SELECT seq FROM nodes WHERE user_id = :tenant " +
          "/* includes-deleted: reading the sequence, not the graph */",
      )
    const maximum = Math.max(...rows.map((row) => Number(row.seq)))
    expect(maximum).toBeGreaterThan(before.nodes.size)
  })

  it("does not move the client's replica cursor", async () => {
    const tenant = harness.tenant(USER)
    await tenant.batch([
      {
        sql:
          "INSERT INTO meta (user_id, key, value) VALUES (:tenant, 'replica_cursor', '99') " +
          "ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value",
        params: [],
      },
    ])
    await run(harness, grantOf({}), "create_blocks", {
      parent_id: ALPHA,
      blocks: [{ text: "new" }],
    })

    const rows = await tenant.exec(
      "SELECT value FROM meta WHERE user_id = :tenant AND key = 'replica_cursor'",
    )
    expect(rows[0].value).toBe("99")
  })
})

// -----------------------------------------------------------------------------
// Argument handling
// -----------------------------------------------------------------------------

describe("the published schemas", () => {
  it("gives every tool an object schema, generated from the tool's own zod schema", () => {
    for (const tool of TOOLS) {
      expect(tool.inputSchema.type).toBe("object")
      // Generated, not hand-written: the dialect line zod emits is stripped,
      // and nothing declares properties it does not parse.
      expect(tool.inputSchema).not.toHaveProperty("$schema")
    }
  })

  it("keeps `create_blocks` recursive: a block's children are blocks", () => {
    const schema = TOOLS.find((tool) => tool.name === "create_blocks")!.inputSchema as any

    expect(schema.properties.blocks.items.$ref).toBe("#/$defs/newBlock")
    expect(schema.$defs.newBlock.properties.children.items.$ref).toBe("#/$defs/newBlock")
    // And an agent is never offered the one type it may not create.
    expect(schema.$defs.newBlock.properties.type.enum).not.toContain("note")
  })
})

describe("arguments", () => {
  it("refuses a missing required argument as a tool error, so a model can retry", async () => {
    expect(await refuse(harness, grantOf({}), "read_note", {})).toMatch(/`note_id` is required/)
    expect(await refuse(harness, grantOf({}), "search", {})).toMatch(/`query` is required/)
  })

  it("refuses a wrongly-typed argument", async () => {
    expect(await refuse(harness, grantOf({}), "list_notes", { limit: -1 })).toMatch(/positive/)
    expect(await refuse(harness, grantOf({}), "list_notes", { tag: 5 })).toMatch(/must be a string/)
  })

  it("caps an over-large limit rather than refusing it", async () => {
    const data = await run(harness, grantOf({}), "list_notes", { limit: 10_000 })
    expect(data.notes.length).toBeLessThanOrEqual(200)
  })

  it("refuses a block type the published schema does not list", async () => {
    // The enum an agent reads and the values a tool accepts are the same
    // list, so `note` — which the schema has never offered — cannot be set
    // on a block either.
    const bullet = (await run(harness, grantOf({}), "read_note", { note_id: BETA })).blocks[0]
    expect(
      await refuse(harness, grantOf({}), "update_block", { block_id: bullet.id, type: "note" }),
    ).toMatch(/unknown block type/)
  })

  it("reports an unknown tool name", async () => {
    const called = await callTool(grantOf({}), harness.tenant(USER), "rm_rf", {})
    expect(called.kind).toBe("unknown_tool")
  })
})
