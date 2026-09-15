// The MCP search engine over the real scoped graph: the app's query language,
// applied to what a grant can see.
import { describe, expect, test } from "vitest"
import { scopedGraph } from "../mcp/graph-access"
import type { Grant } from "../mcp/grant"
import { createMcpTestEnv, type McpTestEnv } from "../mcp/test-support"
import { searchCorpus } from "./engine"

const USER = 42536816
const md = (...lines: string[]) => lines.join("\n") + "\n"

const RUMINATE = md(
  "- # Sync",
  "  id:: blk_sync",
  "  - Row diffs push through the Worker",
  "    id:: blk_diffs",
  "  - [ ] Drop the overlap window on pulls",
  "    id:: blk_todo",
  "- # Editor",
  "  id:: blk_editor",
  "  - Every edit is a batch of ops",
  "    id:: blk_ops",
)
const SOURDOUGH = md(
  "- # Bake",
  "  id:: blk_bake",
  "  - Cold retard overnight gives the open crumb",
  "    id:: blk_retard",
  "  - [ ] Try a longer bulk",
  "    id:: blk_bulk",
)

async function fixture(): Promise<McpTestEnv> {
  const env = await createMcpTestEnv()
  await env.seedNote(USER, { id: "note_rum", title: "Ruminate", markdown: RUMINATE })
  await env.seedNote(USER, { id: "note_dough", title: "Sourdough", markdown: SOURDOUGH })
  return env
}

const grantFor = (noteIds: string[] | null): Grant => ({
  tokenId: "mcp_test",
  userId: USER,
  name: "test",
  permissions: new Set(["read"] as const),
  noteIds: noteIds === null ? null : new Set(noteIds),
  expiresAt: null,
})

async function run(
  env: McpTestEnv,
  query: string,
  options: { notes?: string[] | null; limit?: number; offset?: number } = {},
) {
  const graph = await scopedGraph(env.tenant(USER), grantFor(options.notes ?? null))
  return searchCorpus({ graph, query, limit: options.limit ?? 20, offset: options.offset })
}

const ids = (result: { hits: { id: string }[] }) => result.hits.map((hit) => hit.id)

describe("searchCorpus — the query language", () => {
  test("a query with no free text is an enumeration of what the filters admit", async () => {
    const env = await fixture()
    expect(ids(await run(env, "type:todo")).sort()).toEqual(["blk_bulk", "blk_todo"])
  })

  test("free text is the app's fuzzy match over block text", async () => {
    const env = await fixture()
    expect(ids(await run(env, "batch of ops"))).toContain("blk_ops")
    expect(ids(await run(env, "overnight"))).toEqual(["blk_retard"])
  })

  test("`in:` scopes to a note by name, and to a block's subtree by id", async () => {
    const env = await fixture()
    const byName = await run(env, 'in:"Sourdough" crumb')
    expect(ids(byName)).toContain("blk_retard")
    expect(ids(byName)).not.toContain("blk_diffs")
    // Under the Sync heading: its blocks, and not the Editor's.
    expect(ids(await run(env, "in:blk_sync")).sort()).toEqual(["blk_diffs", "blk_todo"])
  })

  test("qualifiers stack as AND; a comma list is OR; `-` excludes", async () => {
    const env = await fixture()
    expect(ids(await run(env, "type:todo,heading in:blk_sync")).sort()).toEqual(["blk_todo"])
    expect(ids(await run(env, "type:todo type:heading"))).toEqual([])
    expect(ids(await run(env, "type:task -type:done")).sort()).toEqual(["blk_bulk", "blk_todo"])
  })

  test("`sort:` orders the hits", async () => {
    const env = await fixture()
    const texts = (await run(env, "sort:text type:todo,heading")).hits.map((hit) => hit.text)
    expect([...texts].sort((a, b) => a.localeCompare(b))).toEqual(texts)
  })
})

describe("searchCorpus — scope", () => {
  test("a note-scoped grant never sees a block from another note", async () => {
    const env = await fixture()
    const found = await run(env, "crumb overnight bake", { notes: ["note_rum"] })
    expect(found.hits.every((hit) => hit.noteId === "note_rum")).toBe(true)
    expect(ids(found)).not.toContain("blk_retard")
    // An enumeration is scoped the same way.
    expect(ids(await run(env, "type:todo", { notes: ["note_rum"] }))).toEqual(["blk_todo"])
  })
})

describe("searchCorpus — hits", () => {
  test("a hit names its note and the heading it sits under", async () => {
    const env = await fixture()
    const hit = (await run(env, "overnight")).hits[0]
    expect(hit.id).toBe("blk_retard")
    expect(hit.noteTitle).toBe("Sourdough")
    expect(hit.section).toBe("Bake")
    expect(hit.type).toBe("ul")
  })

  test("a block at the top of a note has no section", async () => {
    const env = await fixture()
    const hit = (await run(env, "type:heading in:note_rum")).hits[0]
    expect(hit.section).toBe("")
  })
})

describe("searchCorpus — paging", () => {
  test("pages with an offset cursor, and stops", async () => {
    const env = await fixture()
    const first = await run(env, "type:todo", { limit: 1 })
    expect(first.hits).toHaveLength(1)
    expect(first.total).toBe(2)
    expect(first.nextCursor).toBe("1")
    const second = await run(env, "type:todo", { limit: 1, offset: 1 })
    expect(second.hits).toHaveLength(1)
    expect(second.nextCursor).toBeNull()
    expect(ids(second)).not.toEqual(ids(first))
  })
})
