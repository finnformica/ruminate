// The one ranker, over the real scoped graph (docs/semantic-search.md).
//
// What these pin, in the order they matter:
//
// 1. the structured half of the query language means the SAME thing over
//    either matcher — a filter is a filter, not a re-ranking;
// 2. a semantic candidate is resolved through the SCOPED accessors, so a
//    note-scoped grant cannot be handed a block it may not see, whatever the
//    index returns;
// 3. the two halves fuse rather than one dominating;
// 4. no bindings is lexical-only, not broken.
//
// The embedder is a bag of words (worker/search/test-support.ts), which makes
// these tests about plumbing. Whether the real model retrieves a paraphrase is
// a question about the model, and `scripts/chunking-experiment.ts` is where it
// is answered.

import { describe, expect, test } from "vitest"
import { scopedGraph } from "../mcp/graph-access"
import type { Grant } from "../mcp/grant"
import { createMcpTestEnv, type McpTestEnv } from "../mcp/test-support"
import { hybridSearch, type Semantic } from "./engine"
import { syncVectors } from "./sync"
import { fakeSemantic } from "./test-support"

const USER = 42536816

const md = (...lines: string[]) => lines.join("\n") + "\n"

const RUMINATE = md(
  "- # Sync",
  "  id:: blk_sync",
  "  - Row diffs push through the Worker #eng",
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
  "  - Cold retard overnight gives the open crumb #food",
  "    id:: blk_retard",
  "  - [ ] Try a longer bulk",
  "    id:: blk_bulk",
)

async function fixture(): Promise<{
  env: McpTestEnv
  semantic: Semantic
}> {
  const env = await createMcpTestEnv()
  await env.seedNote(USER, { id: "note_rum", title: "Ruminate", markdown: RUMINATE })
  await env.seedNote(USER, { id: "note_dough", title: "Sourdough", markdown: SOURDOUGH })
  const semantic = fakeSemantic()
  await syncVectors(env.tenant(USER), semantic)
  return { env, semantic }
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
  options: {
    semantic?: Semantic | null
    notes?: string[] | null
    limit?: number
    offset?: number
  } = {},
) {
  const grant = grantFor(options.notes ?? null)
  const graph = await scopedGraph(env.tenant(USER), grant)
  return hybridSearch({
    graph,
    query,
    limit: options.limit ?? 20,
    offset: options.offset,
    semantic: options.semantic === undefined ? null : options.semantic,
  })
}

const ids = (result: { hits: { id: string }[] }) => result.hits.map((hit) => hit.id)

describe("hybridSearch — the query language", () => {
  test("a query with no free text is an enumeration of what the filters admit", async () => {
    const { env } = await fixture()

    const found = await run(env, "type:todo")

    expect(ids(found).sort()).toEqual(["blk_bulk", "blk_todo"])
    expect(found.semanticUsed).toBe(false)
  })

  test("a tag filter narrows the corpus whichever half found the block", async () => {
    const { env, semantic } = await fixture()

    const lexicalOnly = await run(env, "tag:food crumb")
    const hybrid = await run(env, "tag:food crumb", { semantic })

    for (const found of [lexicalOnly, hybrid]) {
      expect(ids(found)).toContain("blk_retard")
      expect(ids(found)).not.toContain("blk_diffs")
    }
  })

  test("`in:` scopes to a note by name, semantic candidates included", async () => {
    const { env, semantic } = await fixture()

    const found = await run(env, 'in:"Sourdough" overnight', { semantic })

    expect(ids(found).length).toBeGreaterThan(0)
    expect(found.hits.every((hit) => hit.noteId === "note_dough")).toBe(true)
  })

  test("a block-type filter applies to the semantic half too", async () => {
    const { env, semantic } = await fixture()

    const found = await run(env, "type:heading bake", { semantic })

    expect(found.hits.every((hit) => hit.type.startsWith("h"))).toBe(true)
  })

  test("`-` exclusion still excludes", async () => {
    const { env, semantic } = await fixture()

    const found = await run(env, "-tag:food ops", { semantic })

    expect(ids(found)).not.toContain("blk_retard")
  })

  test("`sort:` orders the fused ranking, not just the lexical one", async () => {
    const { env, semantic } = await fixture()

    const found = await run(env, "sort:text bake overnight", { semantic })
    const texts = found.hits.map((hit) => hit.text)

    expect([...texts].sort((a, b) => a.localeCompare(b))).toEqual(texts)
  })
})

describe("hybridSearch — scope", () => {
  test("a note-scoped grant never sees a block from another note", async () => {
    const { env, semantic } = await fixture()

    // The index holds Sourdough's chunks; the grant does not name it.
    const found = await run(env, "crumb overnight bake", {
      semantic,
      notes: ["note_rum"],
    })

    expect(found.hits.every((hit) => hit.noteId === "note_rum")).toBe(true)
    expect(ids(found)).not.toContain("blk_retard")
  })

  test("the index still offers the out-of-scope chunk; resolution drops it", async () => {
    const { env, semantic } = await fixture()

    // The wall is not "the vector index knows about the scope" — it does not,
    // and deliberately so (it holds no metadata to filter on). It is that
    // every candidate is resolved through the scoped accessors, and a note the
    // grant does not name resolves to nothing.
    const [vector] = await semantic.embedder.embed(["crumb"])
    const offered = await semantic.store.search(vector, 100)
    expect(offered.map((match) => match.id)).toContain("note_dough#0")

    const found = await run(env, "crumb", { semantic, notes: ["note_rum"] })

    expect(found.hits.every((hit) => hit.noteId === "note_rum")).toBe(true)
  })
})

describe("hybridSearch — the two halves", () => {
  test("without bindings it is lexical only, and says so", async () => {
    const { env } = await fixture()

    const found = await run(env, "batch of ops")

    expect(found.semanticUsed).toBe(false)
    expect(found.counts.semantic).toBe(0)
    expect(ids(found)).toContain("blk_ops")
  })

  test("the semantic half brings in a block the fuzzy matcher misses", async () => {
    const { env, semantic } = await fixture()

    // "retard" and "crumb" live in one section with the heading "Bake"; a
    // query naming the section's other words reaches the whole section.
    const lexical = await run(env, "cold gives")
    const hybrid = await run(env, "cold gives", { semantic })

    expect(hybrid.counts.semantic).toBeGreaterThan(0)
    expect(hybrid.total).toBeGreaterThanOrEqual(lexical.total)
  })

  test("every hit says which half proposed it", async () => {
    const { env, semantic } = await fixture()

    const found = await run(env, "crumb", { semantic })

    for (const hit of found.hits) {
      expect(["lexical", "semantic", "both"]).toContain(hit.matchedBy)
    }
  })

  test("a hit names its note and the heading it sits under", async () => {
    const { env, semantic } = await fixture()

    const found = await run(env, "overnight", { semantic })
    const hit = found.hits.find((candidate) => candidate.id === "blk_retard")

    expect(hit?.noteTitle).toBe("Sourdough")
    expect(hit?.section).toBe("Bake")
  })
})

describe("hybridSearch — paging", () => {
  test("pages with an offset cursor, and stops", async () => {
    const { env, semantic } = await fixture()

    const first = await run(env, "type:todo", { semantic, limit: 1 })
    expect(first.hits).toHaveLength(1)
    expect(first.nextCursor).toBe("1")

    const second = await run(env, "type:todo", { semantic, limit: 1, offset: 1 })
    expect(second.hits).toHaveLength(1)
    expect(second.nextCursor).toBeNull()
    expect(ids(second)).not.toEqual(ids(first))
  })
})
