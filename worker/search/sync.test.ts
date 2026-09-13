// The indexer, driven off `seq` — over the real migration schema, through the
// real push path (docs/semantic-search.md).
//
// Nothing here writes a corpus row by hand: every change goes in through
// `corpusPut`/`planReplicaPut`, the same two steps a browser save and an
// agent's edit take, so the `seq` these tests read is the `seq` production
// assigns.

import { describe, expect, test } from "vitest"
import { docToGraph } from "../../src/data/graph"
import { corpusPut } from "../handlers/replica-corpus"
import { createMcpTestEnv, type McpTestEnv } from "../mcp/test-support"
import { resetCursor, syncVectors } from "./sync"
import { fakeSemantic } from "./test-support"

const USER = 42536816

const md = (...lines: string[]) => lines.join("\n") + "\n"

/** Later than `seedNote`'s default stamp — per-row last-writer-wins is on
 * `updated_at`, so an "edit" with an older stamp is correctly ignored. */
const LATER = 1_800_000_000_000

const NOTE_A = md(
  "- # Sync",
  "  id:: blk_a1",
  "  - Row diffs push through the Worker",
  "    id:: blk_a2",
  "- # Editor",
  "  id:: blk_a3",
  "  - Every edit is a batch of ops",
  "    id:: blk_a4",
)

const NOTE_B = md("- # Bake", "  id:: blk_b1", "  - Cold retard overnight", "    id:: blk_b2")

/** Re-push one note's markdown, which is what an edit looks like on the wire. */
async function rewrite(env: McpTestEnv, noteId: string, markdown: string, at: number) {
  const { nodes, links } = docToGraph(noteId, markdown, at, {
    updated_at: new Date(at).toISOString(),
  })
  const stamped = nodes.map((row) => (row.id === noteId ? row : { ...row, notes_id: noteId }))
  await corpusPut(env.tenant(USER), { nodes: stamped, links }, at)
}

/** Tombstone nodes the way the app does — rows with `deleted_at` set, which
 * take a fresh `seq` like any other write, and so arrive at the indexer as
 * ordinary changes. */
async function tombstone(env: McpTestEnv, ids: string[], type: string, at: number) {
  await corpusPut(
    env.tenant(USER),
    {
      nodes: ids.map((id) => ({
        id,
        type,
        text: "",
        props: null,
        updated_at: at,
        deleted_at: at,
      })),
      links: [],
    },
    at,
  )
}

describe("syncVectors", () => {
  test("the first pass indexes every note, one vector per section", async () => {
    const env = await createMcpTestEnv()
    await env.seedNote(USER, { id: "note_a", title: "Ruminate", markdown: NOTE_A })
    await env.seedNote(USER, { id: "note_b", title: "Sourdough", markdown: NOTE_B })
    const semantic = fakeSemantic()

    const report = await syncVectors(env.tenant(USER), semantic)

    expect(report.from).toBe(0)
    expect(report.to).toBeGreaterThan(0)
    expect(report.notesIndexed).toBe(2)
    // Two headings in A, one in B.
    expect(semantic.store.ids()).toEqual(["note_a#0", "note_a#1", "note_b#0"])
  })

  test("a second pass with nothing changed reads no rows and calls nothing", async () => {
    const env = await createMcpTestEnv()
    await env.seedNote(USER, { id: "note_a", title: "Ruminate", markdown: NOTE_A })
    const semantic = fakeSemantic()
    await syncVectors(env.tenant(USER), semantic)
    const before = { ...semantic.store.calls }

    const report = await syncVectors(env.tenant(USER), semantic)

    expect(report.changedRows).toBe(0)
    expect(report.from).toBe(report.to)
    expect(semantic.store.calls.upsert).toBe(before.upsert)
    expect(semantic.store.calls.remove).toBe(before.remove)
  })

  test("an edit re-indexes only the note it touched", async () => {
    const env = await createMcpTestEnv()
    await env.seedNote(USER, { id: "note_a", title: "Ruminate", markdown: NOTE_A })
    await env.seedNote(USER, { id: "note_b", title: "Sourdough", markdown: NOTE_B })
    const semantic = fakeSemantic()
    await syncVectors(env.tenant(USER), semantic)

    await rewrite(
      env,
      "note_b",
      md("- # Bake", "  id:: blk_b1", "  - Bake covered at 250", "    id:: blk_b2"),
      LATER,
    )
    const report = await syncVectors(env.tenant(USER), semantic)

    expect(report.notesIndexed).toBe(1)
    expect(report.notesRemoved).toBe(0)
  })

  test("a shrinking note leaves no stale vectors behind", async () => {
    const env = await createMcpTestEnv()
    await env.seedNote(USER, { id: "note_a", title: "Ruminate", markdown: NOTE_A })
    const semantic = fakeSemantic()
    await syncVectors(env.tenant(USER), semantic)
    expect(semantic.store.ids()).toEqual(["note_a#0", "note_a#1"])

    // The second section deleted: the note is one section now.
    await tombstone(env, ["blk_a3", "blk_a4"], "h1", LATER)
    await syncVectors(env.tenant(USER), semantic)

    expect(semantic.store.ids()).toEqual(["note_a#0"])
  })

  test("a deleted note leaves the index — the tombstone carries it out", async () => {
    const env = await createMcpTestEnv()
    await env.seedNote(USER, { id: "note_a", title: "Ruminate", markdown: NOTE_A })
    await env.seedNote(USER, { id: "note_b", title: "Sourdough", markdown: NOTE_B })
    const semantic = fakeSemantic()
    await syncVectors(env.tenant(USER), semantic)

    await tombstone(env, ["note_a"], "note", LATER)
    const report = await syncVectors(env.tenant(USER), semantic)

    expect(report.notesRemoved).toBe(1)
    expect(semantic.store.ids()).toEqual(["note_b#0"])
  })

  test("the pass is restartable: running it twice is running it once", async () => {
    const env = await createMcpTestEnv()
    await env.seedNote(USER, { id: "note_a", title: "Ruminate", markdown: NOTE_A })
    const semantic = fakeSemantic()

    await syncVectors(env.tenant(USER), semantic)
    const once = semantic.store.ids()
    await syncVectors(env.tenant(USER), semantic)

    expect(semantic.store.ids()).toEqual(once)
  })

  test("resetCursor rebuilds from the beginning", async () => {
    const env = await createMcpTestEnv()
    await env.seedNote(USER, { id: "note_a", title: "Ruminate", markdown: NOTE_A })
    const semantic = fakeSemantic()
    await syncVectors(env.tenant(USER), semantic)

    await resetCursor(env.tenant(USER))
    const report = await syncVectors(env.tenant(USER), semantic)

    expect(report.from).toBe(0)
    expect(report.notesIndexed).toBe(1)
  })

  test("one tenant's pass never touches another tenant's rows", async () => {
    const env = await createMcpTestEnv()
    await env.seedNote(USER, { id: "note_a", title: "Ruminate", markdown: NOTE_A })
    await env.seedNote(999, { id: "note_other", title: "Theirs", markdown: NOTE_B })
    const semantic = fakeSemantic()

    await syncVectors(env.tenant(USER), semantic)

    expect(semantic.store.ids()).toEqual(["note_a#0", "note_a#1"])
  })
})
