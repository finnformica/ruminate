import { beforeEach, describe, expect, it } from "vitest"
import { blockView, loadSnapshot, scopedGraph } from "./graph-access"
import { grantFromRow, type Grant, type McpTokenRow } from "./grant"
import { callTool, TOOLS, type ToolDef } from "./tools"
import { createMcpTestEnv, type McpTestEnv } from "./test-support"

/**
 * The targeted reads, against the whole-corpus reads they replace.
 *
 * Two questions, and they need different corpora, so there are two.
 *
 * **Does a bounded view answer the same thing?** That is the one that matters,
 * and it is asked on a deliberately nasty little graph — a shared block, an
 * Unassigned subtree, an untitled note, a loop, a tombstone — by running every
 * read through `invoke` (which loads a slice) and through `invokeWith` over a
 * snapshot of the whole corpus, for every id in the graph, and demanding the
 * two results be identical. A view that under-loads cannot survive that: the
 * missing rows change an answer, and the snapshot says what the answer was.
 *
 * **Does it cost less?** Asked on a corpus the size of a real one, by counting
 * the rows each path reads. The numbers are asserted as ratios rather than
 * exact figures — the point is the SHAPE of the cost (bounded by the question
 * rather than by the corpus), and a test that pins exact row counts would
 * break on every fixture tweak while proving no more.
 */

const USER = 11

const grantOf = (overrides: Partial<McpTokenRow> = {}): Grant => {
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

const NOW = 1_800_000_000_000

const toolNamed = (name: string): ToolDef => {
  const tool = TOOLS.find((candidate) => candidate.name === name)
  if (!tool) throw new Error(`no such tool: ${name}`)
  return tool
}

/** Call a tool both ways: its own bounded load, and the whole-corpus snapshot. */
async function bothWays(
  harness: McpTestEnv,
  grant: Grant,
  name: string,
  args: Record<string, unknown>,
) {
  const tool = toolNamed(name)
  const tenant = harness.tenant(grant.userId)
  const targeted = await tool.invoke(args, { grant, tenant, now: NOW })
  const reference = await tool.invokeWith(args, {
    grant,
    tenant,
    now: NOW,
    graph: await scopedGraph(tenant, grant),
  })
  return { targeted, reference }
}

/** Every tool call the equivalence sweep makes for one id. Paged variants are
 * in it too: a page is a window on an order, and a targeted view that loaded a
 * different set of rows could order them differently. */
const CALLS = (id: string) => [
  { name: "get_block", args: { block_id: id } },
  { name: "list_parents", args: { block_id: id } },
  { name: "list_parents", args: { block_id: id, limit: 1 } },
  { name: "list_children", args: { block_id: id } },
  { name: "list_children", args: { block_id: id, depth: 2 } },
  { name: "list_children", args: { block_id: id, depth: 3 } },
  { name: "list_children", args: { block_id: id, depth: 3, limit: 1 } },
  { name: "list_children", args: { block_id: id, depth: 3, limit: 1, cursor: "1" } },
  { name: "read_note", args: { note_id: id } },
  { name: "read_note", args: { note_id: id, depth: 0 } },
  { name: "read_note", args: { note_id: id, depth: 1 } },
  { name: "read_note", args: { note_id: id, depth: 0, limit: 2 } },
  { name: "read_note", args: { note_id: id, depth: 0, limit: 2, cursor: "2" } },
]

/** The calls that take no id — the note list, in each of its shapes. */
const LIST_CALLS = [
  { name: "list_notes", args: {} },
  { name: "list_notes", args: { limit: 1 } },
  { name: "list_notes", args: { limit: 1, cursor: "1" } },
  { name: "list_notes", args: { limit: 2, cursor: "3" } },
  { name: "list_notes", args: { type: "note" } },
  { name: "list_notes", args: { tag: "deep" } },
  { name: "list_notes", args: { limit: 1000 } },
]

/** Run every read over every live node, both ways, and demand agreement. */
async function sweep(harness: McpTestEnv, grant: Grant) {
  const snapshot = await loadSnapshot(harness.tenant(USER))
  const ids = [...snapshot.nodes.keys()].sort()
  expect(ids.length).toBeGreaterThan(5)
  const calls = [...ids.flatMap(CALLS), ...LIST_CALLS]
  for (const call of calls) {
    const { targeted, reference } = await bothWays(harness, grant, call.name, call.args)
    expect(
      targeted,
      `${call.name}(${JSON.stringify(call.args)}) disagreed with the snapshot`,
    ).toEqual(reference)
  }
  return ids
}

let harness: McpTestEnv

// -----------------------------------------------------------------------------
// Equivalence, on a graph with every awkward shape in it
// -----------------------------------------------------------------------------

const ALPHA = "blk_alpha"
/** Untitled: its display name is derived from its outline, not from a title. */
const PLAIN = "blk_plain"
const SHARER = "blk_sharer"
const LOOPY = "blk_loopy"

describe("a targeted view answers what the whole corpus answers", () => {
  /** The ids of a note's blocks, deepest-first, from the reference path. */
  const blocksOf = async (noteId: string): Promise<any[]> => {
    const called = await callTool(grantOf(), harness.tenant(USER), "read_note", {
      note_id: noteId,
      depth: 0,
    })
    if (called.kind !== "result" || !called.outcome.ok) throw new Error("read_note failed")
    return (called.outcome.data as any).blocks
  }

  const call = async (name: string, args: Record<string, unknown>) => {
    const called = await callTool(grantOf(), harness.tenant(USER), name, args, NOW)
    if (called.kind !== "result") throw new Error(called.message)
    if (!called.outcome.ok) throw new Error(called.outcome.message)
    return called.outcome.data as any
  }

  beforeEach(async () => {
    harness = await createMcpTestEnv()
    await harness.addUser(USER)

    await harness.seedNote(USER, {
      id: ALPHA,
      title: "Alpha",
      markdown: "# Heading\n  - a bullet\n    - a leaf #deep\n  - [ ] a task #work\n",
      updatedAt: 2000,
    })
    // No title, so `noteFromNode` derives its name from its blocks — the read
    // that makes `list_parents` have to load a whole note rather than a row.
    await harness.seedNote(USER, {
      id: PLAIN,
      markdown: "- first words of an untitled note\n  - beneath it\n",
      updatedAt: 3000,
    })
    await harness.seedNote(USER, {
      id: SHARER,
      title: "Sharer",
      markdown: "- its own row\n",
      updatedAt: 4000,
    })
    await harness.seedNote(USER, {
      id: LOOPY,
      title: "Loopy",
      markdown: "- top\n  - middle\n    - bottom\n",
      updatedAt: 5000,
    })

    // The same block in two notes: `SHARER` also holds one of ALPHA's bullets,
    // so "which notes reach this block" has more than one answer.
    const bullet = (await blocksOf(ALPHA)).find((block: any) => block.text === "a bullet")
    await call("link_block", { parent_id: SHARER, block_id: bullet.id })

    // A loop: the bottom of LOOPY holds its own top.
    const loopBlocks = await blocksOf(LOOPY)
    const top = loopBlocks.find((block: any) => block.text === "top")
    const bottom = loopBlocks.find((block: any) => block.text === "bottom")
    await call("link_block", { parent_id: bottom.id, block_id: top.id })

    // An Unassigned section: PLAIN's only row falls out of its outline, with
    // everything beneath it.
    const plainRoot = (await blocksOf(PLAIN))[0]
    await call("unlink_block", { parent_id: PLAIN, block_id: plainRoot.id })

    // A tombstone in the middle of ALPHA: the leaf under "a bullet" is gone,
    // so no walk may cross it.
    const leaf = (await blocksOf(ALPHA)).find((block: any) => block.text === "a leaf #deep")
    await call("delete_block", { block_id: leaf.id })
  })

  it("agrees on every read, for every node, for an unrestricted grant", async () => {
    const ids = await sweep(harness, grantOf())
    // The sweep is only worth anything if it covered the awkward shapes.
    expect(ids).toEqual(expect.arrayContaining([ALPHA, PLAIN, SHARER, LOOPY]))
  })

  it("agrees on every read, for every node, for a note-scoped grant", async () => {
    await sweep(harness, grantOf({ note_ids: `["${ALPHA}","${PLAIN}"]` }))
  })

  it("derives the same note scope from the rows as from a loaded snapshot", async () => {
    // The set itself, not merely its effect on one answer: `scopeNodeIds`
    // (a walk seeded at the granted notes) against `visibleNodes` (the same
    // definition over the whole corpus in memory).
    const grant = grantOf({ note_ids: `["${ALPHA}","${PLAIN}"]` })
    const tenant = harness.tenant(USER)
    const full = await scopedGraph(tenant, grant)
    const view = await blockView(tenant, grant, ALPHA)
    expect(full.visible).not.toBeNull()
    expect([...(view.visible ?? [])].sort()).toEqual([...(full.visible ?? [])].sort())
  })

  it("gives a scope over nothing when the grant names no live note", async () => {
    const tenant = harness.tenant(USER)
    for (const noteIds of ['["blk_ghost"]', "not json at all", "[]"]) {
      const grant = grantOf({ note_ids: noteIds })
      const view = await blockView(tenant, grant, ALPHA)
      expect(view.visible).toEqual(new Set())
    }
  })

  it("refuses to cross a tombstone, exactly as the snapshot does", async () => {
    // Loading the rows without joining `nodes` at both ends of every link
    // would walk straight through the deleted block; the sweep above would
    // catch it, and this names the case so a failure reads as what it is.
    const bullet = (await blocksOf(ALPHA)).find((block: any) => block.text === "a bullet")
    const { targeted, reference } = await bothWays(harness, grantOf(), "list_children", {
      block_id: bullet.id,
      depth: 3,
    })
    expect(targeted).toEqual(reference)
    expect((targeted as any).data.children).toEqual([])
  })

  it("terminates on a loop rather than walking it forever", async () => {
    const data = await call("read_note", { note_id: LOOPY, depth: 0 })
    expect(data.blockCount).toBe(3)
  })
})

// -----------------------------------------------------------------------------
// Cost, on a corpus the size of a real one
// -----------------------------------------------------------------------------

describe("what a tool call costs", () => {
  /** 4 sections × (1 + 3 × (1 + 2)) = 40 blocks, three levels deep. */
  const outline = (note: number): string => {
    const lines: string[] = []
    for (let section = 1; section <= 4; section += 1) {
      lines.push(`# Note ${note} section ${section}`)
      for (let point = 1; point <= 3; point += 1) {
        lines.push(`  - point ${section}.${point}`)
        for (let detail = 1; detail <= 2; detail += 1) {
          lines.push(`    - detail ${section}.${point}.${detail} #note${note}`)
        }
      }
    }
    return lines.join("\n") + "\n"
  }

  const NOTES = 20
  let corpusRows = 0
  let deepBlock = ""

  beforeEach(async () => {
    harness = await createMcpTestEnv()
    await harness.addUser(USER)
    for (let note = 1; note <= NOTES; note += 1) {
      await harness.seedNote(USER, {
        id: `blk_note${note}`,
        title: `Note ${note}`,
        markdown: outline(note),
        updatedAt: 1_000_000 + note,
      })
    }
    const snapshot = await loadSnapshot(harness.tenant(USER))
    corpusRows = snapshot.nodes.size + [...snapshot.childLinks.values()].flat().length
    // A leaf in the middle of the corpus — the id an agent walking a graph
    // spends most of its calls on.
    const called = await callTool(grantOf(), harness.tenant(USER), "read_note", {
      note_id: "blk_note10",
      depth: 0,
    })
    if (called.kind !== "result" || !called.outcome.ok) throw new Error("read_note failed")
    deepBlock = (called.outcome.data as any).blocks.filter((block: any) => block.depth === 2)[0].id
  })

  /** Rows read by the tool's own bounded load, and by the whole-corpus path. */
  async function compare(grant: Grant, name: string, args: Record<string, unknown>) {
    const tool = toolNamed(name)
    const tenant = harness.tenant(grant.userId)
    const targeted = await harness.measure(() => tool.invoke(args, { grant, tenant, now: NOW }))
    const snapshot = await harness.measure(async () =>
      tool.invokeWith(args, { grant, tenant, now: NOW, graph: await scopedGraph(tenant, grant) }),
    )
    // Cheaper is only interesting if it is also the same answer.
    expect(targeted.value).toEqual(snapshot.value)
    return { targeted: targeted.rows, snapshot: snapshot.rows }
  }

  /** Rows one note of this fixture holds: its nodes and its links. */
  const perNote = () => corpusRows / NOTES

  it("reads a whole corpus on the snapshot path, by construction", async () => {
    expect(corpusRows).toBeGreaterThan(1_500)
    const cost = await compare(grantOf(), "get_block", { block_id: deepBlock })
    expect(cost.snapshot).toBe(corpusRows)
  })

  it("reads a handful of rows for `get_block`", async () => {
    // The block, its ancestry and its children — not a fraction of the corpus,
    // a fixed and small number of rows however big the corpus gets.
    const cost = await compare(grantOf(), "get_block", { block_id: deepBlock })
    expect(cost.targeted).toBeLessThan(20)
  })

  it("reads a branch, not a corpus, for `list_children`", async () => {
    const one = await compare(grantOf(), "list_children", { block_id: "blk_note10" })
    const two = await compare(grantOf(), "list_children", { block_id: "blk_note10", depth: 2 })
    expect(one.targeted).toBeLessThan(two.targeted)
    expect(two.targeted).toBeLessThan(perNote() * 2)
  })

  it("reads one note for `read_note`, whatever the depth", async () => {
    const shallow = await compare(grantOf(), "read_note", { note_id: "blk_note10" })
    const whole = await compare(grantOf(), "read_note", { note_id: "blk_note10", depth: 0 })
    // `blockCount` and a note's tags are whole-note facts, so `depth` bounds
    // what comes BACK rather than what is read. Both are one note of twenty.
    expect(shallow.targeted).toEqual(whole.targeted)
    expect(whole.targeted).toBeLessThan(perNote() * 2)
  })

  it("reads the notes holding a block for `list_parents`", async () => {
    // Its ancestry is a handful of rows; the notes it appears in have to be
    // named, and naming an untitled one means reading it.
    const cost = await compare(grantOf(), "list_parents", { block_id: deepBlock })
    expect(cost.targeted).toBeLessThan(perNote() * 2)
  })

  it("lists notes without reading the notes it does not list", async () => {
    // The page is decided by the note rows; only the notes ON it are read.
    const five = await compare(grantOf(), "list_notes", { limit: 5 })
    const all = await compare(grantOf(), "list_notes", { limit: 200 })
    expect(five.targeted).toBeLessThan(all.targeted)
    expect(five.targeted).toBeLessThan(perNote() * 8)
  })

  it("leaves the corpus-wide reads corpus-wide, and says so", async () => {
    // `search` looks at every block's text, `list_tags` at every note's tags,
    // and a `tag` filter on `list_notes` is the same question. None can be
    // answered from a slice, so none pretends to be.
    const wide: [string, Record<string, unknown>][] = [
      ["search", { query: "detail" }],
      ["list_tags", {}],
      ["list_notes", { tag: "note4" }],
    ]
    for (const [name, args] of wide) {
      const measured = await compare(grantOf(), name, args)
      expect(measured.targeted, name).toBe(measured.snapshot)
    }
  })

  it("costs a scoped grant its own notes, not the corpus", async () => {
    // The scope is a walk seeded at the granted note, so a note-scoped token
    // pays for its note — which is also the only part of the corpus it may
    // see. It is dearer than the same call on an unrestricted token, which
    // needs no scope at all.
    const grant = grantOf({ note_ids: '["blk_note10"]' })
    const measured = await compare(grant, "get_block", { block_id: deepBlock })
    expect(measured.targeted).toBeLessThan(perNote() * 2)
  })
})
