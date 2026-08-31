// tenant-guard: exempt — a spec that seeds and inspects raw storage on
// purpose, tombstones included; the discipline it verifies lives in the code
// under test, not in its fixtures.
import { describe, expect, it } from "vitest"
import migration0001 from "../../migrations/0001_init.sql?raw"
import migration0002 from "../../migrations/0002_nodes.sql?raw"
import { ensureCorpusSchema } from "./corpus-schema"
import {
  CURRENT_DATA_VERSION,
  DATA_VERSION_KEY,
  ensureDataVersion,
  singleTenantCorpus,
} from "./data-version"
import type { SqlDriver } from "./sql-driver"

/**
 * The data-version transform as an executable specification, run against a
 * real SQL engine behind the `SqlDriver` seam — the same
 * conformance-suite pattern as `note-store-conformance.ts`. Two spec files
 * drive it: `data-version.test.ts` on the app store's `node:sqlite` driver,
 * and `worker/handlers/data-version.test.ts` on the worker-side test driver —
 * so the transform is pinned on both sides of the sync. The tenant-scoped
 * `CorpusAccess` the Worker uses over the column-tenanted D1 shape has its own
 * suite in `worker/tenancy-db.test.ts`, where what matters is that the
 * transform stays inside one tenant.
 */
export function describeDataVersionConformance(name: string, makeDriver: () => SqlDriver) {
  const migrations = { init: migration0001, nodes: migration0002 }

  async function seededDriver() {
    const driver = makeDriver()
    await ensureCorpusSchema(driver, migrations)
    await driver.batch([
      {
        sql: "INSERT INTO nodes (id, type, text, props, updated_at) VALUES (?, ?, ?, ?, ?)",
        params: ["p", "page", "p", JSON.stringify({ frontmatter: "pinned: true" }), 100],
      },
      {
        sql: "INSERT INTO nodes (id, type, text, props, updated_at) VALUES (?, ?, ?, ?, ?)",
        params: ["blk_a", "text", "[] buy milk", null, 100],
      },
      {
        sql: "INSERT INTO nodes (id, type, text, props, updated_at) VALUES (?, ?, ?, ?, ?)",
        params: ["blk_b", "text", "plain", null, 100],
      },
      {
        sql:
          "INSERT INTO link (source_id, destination_id, kind, sort_key, updated_at) " +
          "VALUES (?, ?, 'child', ?, ?)",
        params: ["p", "blk_a", "a0", 100],
      },
      {
        sql:
          "INSERT INTO link (source_id, destination_id, kind, sort_key, updated_at) " +
          "VALUES (?, ?, 'child', ?, ?)",
        params: ["p", "blk_b", "a1", 100],
      },
    ])
    return driver
  }

  describe(`ensureDataVersion on ${name}`, () => {
    it("rewrites legacy rows once, stamps data_version, and refreshes updated_at (LWW-safe)", async () => {
      const driver = await seededDriver()
      const before = Date.now()
      await ensureDataVersion(singleTenantCorpus(driver))

      const rows = await driver.exec(
        "SELECT id, type, text, props, updated_at FROM nodes ORDER BY id",
      )
      expect(rows.map((row) => `${row.id}|${row.type}|${row.text}`)).toEqual([
        "blk_a|todo|buy milk",
        "blk_b|text|plain",
        "p|page|p",
      ])
      expect(rows.find((row) => row.id === "p")?.props).toBe(JSON.stringify({ pinned: true }))
      // Rewritten rows get a fresh updated_at so they replicate; untouched
      // rows keep theirs.
      expect(Number(rows.find((row) => row.id === "blk_a")?.updated_at)).toBeGreaterThanOrEqual(
        before,
      )
      expect(Number(rows.find((row) => row.id === "blk_b")?.updated_at)).toBe(100)

      const meta = await driver.exec("SELECT value FROM meta WHERE key = ?", [DATA_VERSION_KEY])
      expect(meta).toEqual([{ value: String(CURRENT_DATA_VERSION) }])
    })

    it("is idempotent: a second run changes nothing", async () => {
      const driver = await seededDriver()
      await ensureDataVersion(singleTenantCorpus(driver))
      const first = await driver.exec("SELECT * FROM nodes ORDER BY id")
      await ensureDataVersion(singleTenantCorpus(driver))
      expect(await driver.exec("SELECT * FROM nodes ORDER BY id")).toEqual(first)
    })

    it("runs via the shared schema path (ensureCorpusSchema) on reopen", async () => {
      const driver = await seededDriver()
      await ensureCorpusSchema(driver, migrations) // what every engine's open calls
      const rows = await driver.exec("SELECT type FROM nodes WHERE id = 'blk_a'")
      expect(rows).toEqual([{ type: "todo" }])
    })

    it("does not stamp the version on an empty corpus, so late-arriving rows still transform", async () => {
      const driver = makeDriver()
      await ensureCorpusSchema(driver, migrations)
      expect(await driver.exec("SELECT value FROM meta WHERE key = ?", [DATA_VERSION_KEY])).toEqual(
        [],
      )
      // Rows arrive after first open (the tenant-#1 D1 import / a first pull).
      await driver.batch([
        {
          sql: "INSERT INTO nodes (id, type, text, props, updated_at) VALUES (?, ?, ?, ?, ?)",
          params: ["p", "page", "p", null, 100],
        },
        {
          sql: "INSERT INTO nodes (id, type, text, props, updated_at) VALUES (?, ?, ?, ?, ?)",
          params: ["blk_a", "text", "[X] late arrival", null, 100],
        },
        {
          sql:
            "INSERT INTO link (source_id, destination_id, kind, sort_key, updated_at) " +
            "VALUES (?, ?, 'child', ?, ?)",
          params: ["p", "blk_a", "a0", 100],
        },
      ])
      await ensureCorpusSchema(driver, migrations) // the next open
      expect(await driver.exec("SELECT type, text FROM nodes WHERE id = 'blk_a'")).toEqual([
        { type: "done", text: "late arrival" },
      ])
      expect(await driver.exec("SELECT value FROM meta WHERE key = ?", [DATA_VERSION_KEY])).toEqual(
        [{ value: String(CURRENT_DATA_VERSION) }],
      )
    })

    it("leaves tombstoned rows alone (a deleted row has nothing to normalize)", async () => {
      const driver = await seededDriver()
      await driver.batch([
        { sql: "UPDATE nodes SET deleted_at = 500 WHERE id = 'blk_a'", params: [] },
      ])
      await ensureDataVersion(singleTenantCorpus(driver))
      expect(
        await driver.exec("SELECT type, text, updated_at FROM nodes WHERE id = 'blk_a'"),
      ).toEqual([{ type: "text", text: "[] buy milk", updated_at: 100 }])
    })

    it("is transactional: a failed batch leaves rows and version untouched", async () => {
      const driver = await seededDriver()
      const failing: SqlDriver = {
        ...driver,
        batch: () => Promise.reject(new Error("boom")),
      }
      await expect(ensureDataVersion(singleTenantCorpus(failing))).rejects.toThrow("boom")
      expect(await driver.exec("SELECT type FROM nodes WHERE id = 'blk_a'")).toEqual([
        { type: "text" },
      ])
      expect(await driver.exec("SELECT value FROM meta WHERE key = ?", [DATA_VERSION_KEY])).toEqual(
        [],
      )
      // The real (atomic) batch then completes the transform in one piece.
      await ensureDataVersion(singleTenantCorpus(driver))
      expect(await driver.exec("SELECT type FROM nodes WHERE id = 'blk_a'")).toEqual([
        { type: "todo" },
      ])
    })
  })
}
