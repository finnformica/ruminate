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

let harness: McpTestEnv
const ALPHA = "blk_alpha"
const BETA = "blk_beta"

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

    expect(names(grantOf({ permissions: "read" }))).not.toContain("update_note")
    expect(names(grantOf({ permissions: "read" }))).not.toContain("delete_note")
    expect(names(grantOf({ permissions: "read" }))).toContain("read_note")
    expect(names(grantOf({ permissions: "read,write" }))).toContain("update_note")
    expect(names(grantOf({ permissions: "read,write" }))).not.toContain("delete_note")
    expect(names(grantOf({ permissions: "read,write,delete" }))).toContain("delete_note")
  })

  it("hides create_note from a note-scoped grant that may otherwise write", () => {
    const scoped = grantOf({ permissions: "read,write", note_ids: `["${ALPHA}"]` })
    expect(toolsFor(scoped).map((tool) => tool.name)).not.toContain("create_note")
    expect(toolsFor(scoped).map((tool) => tool.name)).toContain("update_note")
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

  it("filters by tag and by query", async () => {
    const grant = grantOf({})
    expect((await run(harness, grant, "list_notes", { tag: "home" })).notes).toHaveLength(1)
    expect((await run(harness, grant, "list_notes", { tag: "#home" })).notes).toHaveLength(1)
    expect((await run(harness, grant, "list_notes", { query: "Alpha" })).notes).toHaveLength(1)
    expect((await run(harness, grant, "list_notes", { query: "nothing" })).notes).toHaveLength(0)
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
    const data = await run(harness, grantOf({}), "read_note", { note_id: ALPHA })

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
    const shallow = await run(harness, grantOf({}), "read_note", { note_id: ALPHA, depth: 1 })

    expect(shallow.blocks).toHaveLength(1)
    expect(shallow.blocks[0].hasMoreChildren).toBe(true)
    expect(shallow.truncated).toBe(true)
    // The full size is still reported, so the agent knows what it has not seen.
    expect(shallow.blockCount).toBe(3)
  })

  it("defaults to the top levels, not the whole note", async () => {
    // A note three levels deep, which the default depth cannot cover.
    await run(harness, grantOf({}), "create_note", {
      note_id: "2026-09-30",
      markdown: "# One\n  - two\n    - three\n",
    })

    const shallow = await run(harness, grantOf({}), "read_note", { note_id: "2026-09-30" })
    expect(shallow.blocks).toHaveLength(2)
    expect(shallow.truncated).toBe(true)
    expect(shallow.blockCount).toBe(3)
    // And it says exactly where the rest is.
    expect(shallow.blocks[1].hasMoreChildren).toBe(true)
  })

  it("reads the whole note when asked with depth 0", async () => {
    await run(harness, grantOf({}), "create_note", {
      note_id: "2026-09-30",
      markdown: "# One\n  - two\n    - three\n",
    })

    const full = await run(harness, grantOf({}), "read_note", { note_id: "2026-09-30", depth: 0 })
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
    expect(block.isNote).toBe(false)
  })

  it("treats a note as a block too", async () => {
    const block = await run(harness, grantOf({}), "get_block", { block_id: ALPHA })
    expect(block.isNote).toBe(true)
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

  it("is case-insensitive and never matches a page node", async () => {
    expect((await run(harness, grantOf({}), "search", { query: "BULLET" })).hits).toHaveLength(1)
    // "Alpha" is the page's text, and pages are not blocks.
    expect((await run(harness, grantOf({}), "search", { query: "Alpha" })).hits).toHaveLength(0)
  })

  it("counts tags across the notes it can reach", async () => {
    const data = await run(harness, grantOf({}), "list_tags")
    expect(data.tags.map((entry: any) => entry.tag).sort()).toEqual(["home", "work"])
  })
})

// -----------------------------------------------------------------------------
// The Unassigned basket
// -----------------------------------------------------------------------------

describe("unassigned blocks", () => {
  /** Drop ALPHA's outline, which parks the heading and its children in the
   * note's Unassigned section — the app's own never-lose-work rule. */
  async function orphanAlpha() {
    const heading = (await run(harness, grantOf({}), "list_children", { block_id: ALPHA }))
      .children[0]
    await run(harness, grantOf({}), "update_note", {
      note_id: ALPHA,
      markdown: "- something else\n",
    })
    return heading
  }

  it("is empty for a note whose blocks are all in its outline", async () => {
    const data = await run(harness, grantOf({}), "read_note", { note_id: ALPHA })
    expect(data.unassigned).toEqual([])
  })

  it("reports a block that fell out of the outline, as a row", async () => {
    const heading = await orphanAlpha()
    const data = await run(harness, grantOf({}), "read_note", { note_id: ALPHA })

    expect(data.unassigned.map((block: any) => block.id)).toContain(heading.id)
    expect(data.unassigned[0].text).toBe("Heading")
  })

  it("carries what the orphaned block still holds", async () => {
    await orphanAlpha()
    const data = await run(harness, grantOf({}), "read_note", { note_id: ALPHA })
    const texts = data.unassigned.map((block: any) => block.text)

    expect(texts).toContain("a bullet")
    expect(texts).toContain("a task #work")
  })

  it("keeps them out of the note's outline", async () => {
    await orphanAlpha()
    const data = await run(harness, grantOf({}), "read_note", { note_id: ALPHA })

    expect(data.blocks.map((block: any) => block.text)).toEqual(["something else"])
  })

  it("reports nothing for another note", async () => {
    await orphanAlpha()
    expect((await run(harness, grantOf({}), "read_note", { note_id: BETA })).unassigned).toEqual([])
  })

  it("stops reporting a block once it is linked back into the outline", async () => {
    const heading = await orphanAlpha()
    await run(harness, grantOf({}), "link_block", { parent_id: ALPHA, block_id: heading.id })

    const data = await run(harness, grantOf({}), "read_note", { note_id: ALPHA })
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

  it("cannot edit or delete a note outside the scope", async () => {
    expect(
      await refuse(harness, scoped(), "update_note", { note_id: BETA, markdown: "- hijacked" }),
    ).toMatch(/No such note/)
    expect(
      await refuse(harness, scoped(), "append_to_note", { note_id: BETA, markdown: "- hijacked" }),
    ).toMatch(/No such note/)
    expect(await refuse(harness, scoped(), "delete_note", { note_id: BETA })).toMatch(
      /No such note/,
    )

    // And the note is genuinely untouched.
    expect(await textsOf(grantOf({}), BETA)).toContain("beta content #home")
  })

  it("sees an Unassigned block of its note, AND what hangs beneath it", async () => {
    // Make one: remove the heading from the outline, which leaves it and its
    // children out of reach but still written in ALPHA — the note's basket,
    // which the person still sees at the foot of the note.
    const heading = (await run(harness, grantOf({}), "list_children", { block_id: ALPHA }))
      .children[0]
    const beneath = (await run(harness, grantOf({}), "list_children", { block_id: heading.id }))
      .children[0]
    await run(harness, grantOf({}), "update_note", {
      note_id: ALPHA,
      markdown: "- something else\n",
    })

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
    await run(harness, grantOf({}), "update_note", { note_id: ALPHA, markdown: "- x\n" })

    expect(await refuse(harness, scoped(), "get_block", { block_id: outside.id })).toMatch(
      /No such block/,
    )
  })

  it("cannot create a note to escape its own scope", async () => {
    const called = await callTool(scoped(), harness.tenant(USER), "create_note", { title: "New" })
    expect(called.kind).toBe("unknown_tool")
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
      "update_note",
      { note_id: ALPHA, markdown: "- rewritten" },
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
    await callTool(grantOf({ permissions: "read" }), harness.tenant(USER), "update_note", {
      note_id: ALPHA,
      markdown: "- rewritten",
    })
    expect(await textsOf(grantOf({}), ALPHA)).toContain("a bullet")
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

describe("create_note", () => {
  it("creates a note that then reads back", async () => {
    const created = await run(harness, grantOf({}), "create_note", {
      title: "Fresh",
      markdown: "- one\n- two\n",
    })
    const read = await run(harness, grantOf({}), "read_note", { note_id: created.noteId })
    expect(read.title).toBe("Fresh")
    expect(read.blocks.map((block: any) => block.text)).toEqual(["one", "two"])
  })

  it("accepts a date id for a daily note", async () => {
    const created = await run(harness, grantOf({}), "create_note", {
      note_id: "2026-09-12",
      markdown: "- today\n",
    })
    expect(created.noteId).toBe("2026-09-12")
    expect((await run(harness, grantOf({}), "read_note", { note_id: "2026-09-12" })).type).toBe(
      "daily",
    )
  })

  it("refuses an arbitrary id, so ids stay minted or dated", async () => {
    expect(await refuse(harness, grantOf({}), "create_note", { note_id: "my-note" })).toMatch(
      /daily .* or weekly/,
    )
  })

  it("refuses to create over a note that already exists", async () => {
    await run(harness, grantOf({}), "create_note", { note_id: "2026-W37" })
    expect(await refuse(harness, grantOf({}), "create_note", { note_id: "2026-W37" })).toMatch(
      /already exists/,
    )
  })
})

describe("append_to_note", () => {
  it("adds to the end and leaves what was there alone", async () => {
    await run(harness, grantOf({}), "append_to_note", { note_id: BETA, markdown: "- appended\n" })
    expect(await textsOf(grantOf({}), BETA)).toEqual(["beta content #home", "appended"])
  })

  it("keeps every existing block id", async () => {
    const before = await run(harness, grantOf({}), "read_note", { note_id: BETA })
    await run(harness, grantOf({}), "append_to_note", { note_id: BETA, markdown: "- more\n" })
    const after = await run(harness, grantOf({}), "read_note", { note_id: BETA })

    for (const id of before.rootBlockIds) expect(after.rootBlockIds).toContain(id)
  })

  it("refuses an empty append rather than writing nothing quietly", async () => {
    expect(
      await refuse(harness, grantOf({}), "append_to_note", { note_id: BETA, markdown: "   " }),
    ).toMatch(/nothing to append/)
  })
})

describe("update_note", () => {
  it("replaces the body", async () => {
    await run(harness, grantOf({}), "update_note", { note_id: BETA, markdown: "- replaced\n" })
    expect(await textsOf(grantOf({}), BETA)).toEqual(["replaced"])
  })

  it("moves every block it does not recreate into Unassigned", async () => {
    const before = await run(harness, grantOf({}), "read_note", { note_id: BETA })
    await run(harness, grantOf({}), "update_note", { note_id: BETA, markdown: "- brand new\n" })

    const after = await run(harness, grantOf({}), "read_note", { note_id: BETA })
    expect(after.blocks.map((block: any) => block.text)).toEqual(["brand new"])
    // Nothing is lost: the old block is in the note's Unassigned section.
    expect(after.unassigned.map((block: any) => block.id)).toEqual(before.rootBlockIds)
  })

  it("retitles when asked, and keeps the title when not", async () => {
    await run(harness, grantOf({}), "update_note", {
      note_id: BETA,
      markdown: "- x\n",
      title: "Renamed",
    })
    expect((await run(harness, grantOf({}), "read_note", { note_id: BETA })).title).toBe("Renamed")

    await run(harness, grantOf({}), "update_note", { note_id: BETA, markdown: "- y\n" })
    expect((await run(harness, grantOf({}), "read_note", { note_id: BETA })).title).toBe("Renamed")
  })

  it("refuses a markdown body past the size limit", async () => {
    const huge = "- x\n".repeat(100_000)
    expect(
      await refuse(harness, grantOf({}), "update_note", { note_id: BETA, markdown: huge }),
    ).toMatch(/limit/)
  })
})

// -----------------------------------------------------------------------------
// Block-level writes
// -----------------------------------------------------------------------------

/** ALPHA's heading, and the bullet and task beneath it. */
async function alphaBlocks() {
  const data = await run(harness, grantOf({}), "read_note", { note_id: ALPHA })
  const heading = data.blocks.find((block: any) => block.type === "h1")
  const bullet = data.blocks.find((block: any) => block.type === "ul")
  const task = data.blocks.find((block: any) => block.type === "todo")
  return { heading, bullet, task }
}

describe("update_block", () => {
  it("changes a block's text in place, keeping its id", async () => {
    const { bullet } = await alphaBlocks()
    await run(harness, grantOf({}), "update_block", { block_id: bullet.id, text: "edited" })

    const after = await run(harness, grantOf({}), "get_block", { block_id: bullet.id })
    expect(after.text).toBe("edited")
    expect(after.id).toBe(bullet.id)
  })

  it("changes a block's type — ticking a to-do", async () => {
    const { task } = await alphaBlocks()
    await run(harness, grantOf({}), "update_block", { block_id: task.id, type: "done" })

    expect((await run(harness, grantOf({}), "get_block", { block_id: task.id })).type).toBe("done")
  })

  it("replaces a block's metadata", async () => {
    const { bullet } = await alphaBlocks()
    await run(harness, grantOf({}), "update_block", {
      block_id: bullet.id,
      props: { language: "ts" },
    })

    expect((await run(harness, grantOf({}), "get_block", { block_id: bullet.id })).props).toEqual({
      language: "ts",
    })
  })

  it("leaves the rest of the note completely alone", async () => {
    const { bullet } = await alphaBlocks()
    const before = await run(harness, grantOf({}), "read_note", { note_id: ALPHA })
    await run(harness, grantOf({}), "update_block", { block_id: bullet.id, text: "edited" })
    const after = await run(harness, grantOf({}), "read_note", { note_id: ALPHA })

    expect(after.blocks.map((b: any) => b.id)).toEqual(before.blocks.map((b: any) => b.id))
    expect(after.unassigned).toEqual([])
  })

  it("writes nothing when the value already matches", async () => {
    const { bullet } = await alphaBlocks()
    const data = await run(harness, grantOf({}), "update_block", {
      block_id: bullet.id,
      text: "a bullet",
    })
    expect(data.changed).toBe(0)
    expect(data.rowsWritten).toBe(0)
  })

  it("refuses an unknown type, an empty change, and a note", async () => {
    const { bullet } = await alphaBlocks()
    expect(
      await refuse(harness, grantOf({}), "update_block", { block_id: bullet.id, type: "banana" }),
    ).toMatch(/Unknown block type/)
    expect(await refuse(harness, grantOf({}), "update_block", { block_id: bullet.id })).toMatch(
      /at least one/,
    )
    expect(
      await refuse(harness, grantOf({}), "update_block", { block_id: ALPHA, text: "x" }),
    ).toMatch(/is a note/)
  })
})

describe("link_block and unlink_block", () => {
  it("links an existing block under another parent, in both places at once", async () => {
    const { bullet } = await alphaBlocks()
    await run(harness, grantOf({}), "link_block", { parent_id: BETA, block_id: bullet.id })

    const block = await run(harness, grantOf({}), "get_block", { block_id: bullet.id })
    expect(block.noteIds.sort()).toEqual([ALPHA, BETA].sort())
    expect(await textsOf(grantOf({}), BETA)).toContain("a bullet")
    // Still in ALPHA too — a link is not a move.
    expect(await textsOf(grantOf({}), ALPHA)).toContain("a bullet")
  })

  it("respects index, and appends when it is omitted", async () => {
    const { bullet } = await alphaBlocks()
    await run(harness, grantOf({}), "link_block", {
      parent_id: BETA,
      block_id: bullet.id,
      index: 0,
    })
    expect(await textsOf(grantOf({}), BETA)).toEqual(["a bullet", "beta content #home"])
  })

  it("unlinks without deleting, sending an orphan to Unassigned", async () => {
    const { bullet } = await alphaBlocks()
    const { heading } = await alphaBlocks()
    const data = await run(harness, grantOf({}), "unlink_block", {
      parent_id: heading.id,
      block_id: bullet.id,
    })

    expect(data.orphaned).toBe(true)
    const note = await run(harness, grantOf({}), "read_note", { note_id: ALPHA })
    expect(note.blocks.map((b: any) => b.text)).not.toContain("a bullet")
    expect(note.unassigned.map((b: any) => b.text)).toContain("a bullet")
  })

  it("unlinking one occurrence leaves the other standing", async () => {
    const { bullet, heading } = await alphaBlocks()
    await run(harness, grantOf({}), "link_block", { parent_id: BETA, block_id: bullet.id })

    const data = await run(harness, grantOf({}), "unlink_block", {
      parent_id: heading.id,
      block_id: bullet.id,
    })
    expect(data.orphaned).toBe(false)
    expect(await textsOf(grantOf({}), BETA)).toContain("a bullet")
  })

  it("refuses a self-link and a link that is not there", async () => {
    const { bullet, heading } = await alphaBlocks()
    expect(
      await refuse(harness, grantOf({}), "link_block", {
        parent_id: bullet.id,
        block_id: bullet.id,
      }),
    ).toMatch(/under itself/)
    expect(
      await refuse(harness, grantOf({}), "unlink_block", { parent_id: BETA, block_id: heading.id }),
    ).toMatch(/not directly under/)
  })
})

describe("move_block", () => {
  it("moves a block to another parent in one step", async () => {
    const { bullet } = await alphaBlocks()
    await run(harness, grantOf({}), "move_block", { block_id: bullet.id, to_parent_id: BETA })

    expect(await textsOf(grantOf({}), BETA)).toContain("a bullet")
    expect(await textsOf(grantOf({}), ALPHA)).not.toContain("a bullet")
    // A move is not a delete: nothing lands in Unassigned.
    const alpha = await run(harness, grantOf({}), "read_note", { note_id: ALPHA })
    expect(alpha.unassigned).toEqual([])
  })

  it("reorders under the same parent", async () => {
    const { heading, task } = await alphaBlocks()
    await run(harness, grantOf({}), "move_block", {
      block_id: task.id,
      to_parent_id: heading.id,
      index: 0,
    })

    const children = await run(harness, grantOf({}), "list_children", { block_id: heading.id })
    expect(children.children.map((c: any) => c.text)).toEqual(["a task #work", "a bullet"])
  })

  it("asks which occurrence when the block has several parents", async () => {
    const { bullet } = await alphaBlocks()
    await run(harness, grantOf({}), "link_block", { parent_id: BETA, block_id: bullet.id })

    expect(
      await refuse(harness, grantOf({}), "move_block", {
        block_id: bullet.id,
        to_parent_id: ALPHA,
      }),
    ).toMatch(/from_parent_id/)
  })
})

describe("delete_block", () => {
  it("deletes a block and leaves what it held in Unassigned", async () => {
    const { heading } = await alphaBlocks()
    await run(harness, grantOf({}), "delete_block", { block_id: heading.id })

    const note = await run(harness, grantOf({}), "read_note", { note_id: ALPHA })
    expect(note.blocks).toEqual([])
    expect(note.unassigned.map((b: any) => b.text).sort()).toEqual(["a bullet", "a task #work"])
  })

  it("takes the contents too when asked", async () => {
    const { heading } = await alphaBlocks()
    await run(harness, grantOf({}), "delete_block", { block_id: heading.id, with_contents: true })

    const note = await run(harness, grantOf({}), "read_note", { note_id: ALPHA })
    expect(note.blocks).toEqual([])
    expect(note.unassigned).toEqual([])
  })

  it("needs the delete permission, and refuses a note", async () => {
    const { bullet } = await alphaBlocks()
    const called = await callTool(
      grantOf({ permissions: "read,write" }),
      harness.tenant(USER),
      "delete_block",
      { block_id: bullet.id },
    )
    expect(called.kind).toBe("unknown_tool")
    expect(await refuse(harness, grantOf({}), "delete_block", { block_id: ALPHA })).toMatch(
      /is a note/,
    )
  })
})

describe("block writes and note scope", () => {
  it("refuses to edit a block a note outside the scope also holds", async () => {
    // Put ALPHA's bullet into BETA as well, then scope a token to ALPHA only.
    const { bullet } = await alphaBlocks()
    await run(harness, grantOf({}), "link_block", { parent_id: BETA, block_id: bullet.id })
    const scoped = grantOf({ note_ids: `["${ALPHA}"]` })

    const message = await refuse(harness, scoped, "update_block", {
      block_id: bullet.id,
      text: "reached out of scope",
    })
    expect(message).toMatch(/not scoped to/)
    // And it does not name the note it could not see.
    expect(message).not.toContain(BETA)

    expect(await textsOf(grantOf({}), BETA)).toContain("a bullet")
  })

  it("refuses to unlink, move or delete such a block too", async () => {
    const { bullet, heading } = await alphaBlocks()
    await run(harness, grantOf({}), "link_block", { parent_id: BETA, block_id: bullet.id })
    const scoped = grantOf({ note_ids: `["${ALPHA}"]` })

    for (const [name, args] of [
      ["unlink_block", { parent_id: heading.id, block_id: bullet.id }],
      ["move_block", { block_id: bullet.id, to_parent_id: ALPHA }],
      ["delete_block", { block_id: bullet.id }],
    ] as const) {
      expect(await refuse(harness, scoped, name, args)).toMatch(/not scoped to/)
    }
  })

  it("allows editing a block only its own notes hold", async () => {
    const { bullet } = await alphaBlocks()
    const scoped = grantOf({ note_ids: `["${ALPHA}"]` })

    await run(harness, scoped, "update_block", { block_id: bullet.id, text: "fine" })
    expect(await textsOf(grantOf({}), ALPHA)).toContain("fine")
  })

  it("never restricts an unrestricted grant this way", async () => {
    const { bullet } = await alphaBlocks()
    await run(harness, grantOf({}), "link_block", { parent_id: BETA, block_id: bullet.id })

    await run(harness, grantOf({}), "update_block", { block_id: bullet.id, text: "allowed" })
    expect(await textsOf(grantOf({}), BETA)).toContain("allowed")
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
    await run(harness, grantOf({}), "append_to_note", { note_id: ALPHA, markdown: "- new\n" })

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
    await run(harness, grantOf({}), "append_to_note", { note_id: ALPHA, markdown: "- new\n" })

    const rows = await tenant.exec(
      "SELECT value FROM meta WHERE user_id = :tenant AND key = 'replica_cursor'",
    )
    expect(rows[0].value).toBe("99")
  })
})

// -----------------------------------------------------------------------------
// Argument handling
// -----------------------------------------------------------------------------

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

  it("reports an unknown tool name", async () => {
    const called = await callTool(grantOf({}), harness.tenant(USER), "rm_rf", {})
    expect(called.kind).toBe("unknown_tool")
  })
})
