// The read tripwire (`d1-sql-driver.ts`). An alarm nobody tests is an alarm
// that silently stops ringing, and this one exists because a single query
// shape once consumed 97% of a day's D1 read budget — the regression it
// watches for is invisible until a quota email arrives.

import { beforeEach, describe, expect, it, vi } from "vitest"
import { createD1SqlDriver } from "./d1-sql-driver"

interface FakeMeta {
  rows_read?: number
  rows_written?: number
  duration?: number
}

/** The slice of D1 this driver touches: prepare → bind → all, plus batch. */
function fakeD1(meta: FakeMeta | undefined, results: unknown[] = []) {
  const statement = {
    bind: () => statement,
    all: () => Promise.resolve({ results, meta }),
  }
  return {
    prepare: () => statement,
    batch: (prepared: unknown[]) => Promise.resolve(prepared.map(() => ({ results, meta }))),
    exec: () => Promise.resolve(),
  } as unknown as D1Database
}

describe("d1 read tripwire", () => {
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  })

  it("stays silent for a statement that reads a corpus-sized page", async () => {
    // The full pull — the largest healthy read there is — measured ~540 rows.
    const driver = createD1SqlDriver(fakeD1({ rows_read: 540 }))
    await driver.exec("SELECT id FROM nodes WHERE user_id = ?1", [42])
    expect(warn).not.toHaveBeenCalled()
  })

  it("logs a statement whose cost scales with the corpus", async () => {
    // The shape that caused the incident: 76k rows to count ~520 links.
    const driver = createD1SqlDriver(fakeD1({ rows_read: 76_247, rows_written: 0, duration: 21 }))
    await driver.exec("SELECT (SELECT COUNT(*) FROM link WHERE source_id IN (…)) AS links")

    expect(warn).toHaveBeenCalledTimes(1)
    const logged = JSON.parse(warn.mock.calls[0][0] as string)
    expect(logged).toMatchObject({ event: "d1_expensive_query", rows_read: 76_247 })
    // The SQL rides along — knowing a query was expensive is useless without
    // knowing which one.
    expect(logged.sql).toContain("COUNT(*) FROM link")
  })

  it("reports each statement of a batch", async () => {
    const driver = createD1SqlDriver(fakeD1({ rows_read: 9_000 }))
    await driver.batch([
      { sql: "UPDATE nodes SET text = ?1" },
      { sql: "UPDATE link SET kind = ?1" },
    ])
    expect(warn).toHaveBeenCalledTimes(2)
  })

  it("survives a driver that reports no meta at all", async () => {
    const driver = createD1SqlDriver(fakeD1(undefined))
    await expect(driver.exec("SELECT 1")).resolves.toEqual([])
    expect(warn).not.toHaveBeenCalled()
  })
})
