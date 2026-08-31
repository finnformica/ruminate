import { describe, expect, it } from "vitest"
import migration0001 from "../../migrations/0001_init.sql?raw"
import migration0002 from "../../migrations/0002_nodes.sql?raw"
import { ensureCorpusSchema } from "../../src/data/corpus-schema"
import type { SqlDriver } from "../../src/data/sql-driver"
import { migrateCorpusFromD1, type CorpusTarget } from "./corpus-migration"
import { corpusPut, corpusStatus, corpusPullFull } from "./replica-corpus"
import { createTestSqlDriver } from "./sqlite-test-driver"

/**
 * The tenant-#1 migration, run for real on two `node:sqlite` corpora built by
 * the real migration ladder: one plays the legacy D1 corpus (the source), one
 * plays the owner's Durable Object (the target, driven through the same
 * `CorpusTarget` surface the DO stub exposes).
 */

async function corpus(): Promise<{ driver: SqlDriver; target: CorpusTarget }> {
  const driver = createTestSqlDriver()
  await ensureCorpusSchema(driver, { init: migration0001, nodes: migration0002 })
  return {
    driver,
    target: {
      status: () => corpusStatus(driver),
      put: (payload) => corpusPut(driver, payload),
    },
  }
}

const rows = {
  nodes: [
    { id: "note-a", type: "page", text: "note-a", props: null, updated_at: 100 },
    { id: "blk_a000000000", type: "text", text: "A", props: null, updated_at: 100 },
  ],
  links: [
    {
      source_id: "note-a",
      destination_id: "blk_a000000000",
      kind: "child",
      sort_key: "a0",
      updated_at: 100,
    },
  ],
}

describe("migrateCorpusFromD1", () => {
  it("imports the full D1 corpus (rows + cursor) into an empty target", async () => {
    const source = await corpus()
    await corpusPut(source.driver, { ...rows, cursor: "cursor-42" })
    const targetCorpus = await corpus()

    const result = await migrateCorpusFromD1(source.driver, targetCorpus.target)
    expect(result).toEqual({ migrated: true, reason: "imported", nodes: 2, links: 1 })

    const imported = await corpusPullFull(targetCorpus.driver)
    expect(imported.nodes).toEqual(rows.nodes)
    expect(imported.links).toEqual(rows.links)
    expect(imported.cursor).toBe("cursor-42")
    // Read-only on the source: D1 rows are untouched.
    expect((await corpusStatus(source.driver)).counts).toEqual({ nodes: 2, links: 1, pages: 1 })
  })

  it("refuses to touch a non-empty target (re-runs are safe)", async () => {
    const source = await corpus()
    await corpusPut(source.driver, rows)
    const targetCorpus = await corpus()
    const existing = {
      nodes: [{ id: "note-b", type: "page", text: "note-b", props: null, updated_at: 999 }],
      links: [],
    }
    await corpusPut(targetCorpus.driver, existing)

    const result = await migrateCorpusFromD1(source.driver, targetCorpus.target)
    expect(result).toEqual({ migrated: false, reason: "corpus_not_empty", nodes: 0, links: 0 })
    expect(await corpusPullFull(targetCorpus.driver)).toMatchObject(existing)
  })

  it("reports an empty source without writing", async () => {
    const source = await corpus()
    const targetCorpus = await corpus()
    const result = await migrateCorpusFromD1(source.driver, targetCorpus.target)
    expect(result).toEqual({ migrated: false, reason: "d1_empty", nodes: 0, links: 0 })
    expect((await corpusStatus(targetCorpus.driver)).counts.nodes).toBe(0)
  })

  it("tolerates a source without corpus tables (post-§6-step-6 D1)", async () => {
    const bareSource = createTestSqlDriver()
    const targetCorpus = await corpus()
    const result = await migrateCorpusFromD1(bareSource, targetCorpus.target)
    expect(result).toEqual({ migrated: false, reason: "d1_unavailable", nodes: 0, links: 0 })
  })
})
