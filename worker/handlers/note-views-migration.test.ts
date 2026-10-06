import { expect, test } from "vitest"
import migration0021 from "../../migrations/0021_note_views.sql?raw"
import { createTenantTestDriver } from "./sqlite-test-driver"

/**
 * 0021 against the **exact shape production D1 is in** (the real ladder, as
 * `createTenantTestDriver` builds it — which applies 0021 on creation,
 * against an empty corpus, so running the file here is its second pass over
 * the schema and its first over rows).
 *
 * What it has to get right: a pinned view row for every live note and board
 * that has none, a note's unpinned row pinned with its `updated_at` moved so
 * the pinned version travels, a block's row and a tombstoned note left
 * exactly as they are, every row it writes or rewrites given a `seq` above
 * the tenant's — so the since-pull delivers it — and all of it per tenant.
 */

type Driver = Awaited<ReturnType<typeof createTenantTestDriver>>

const node = (driver: Driver, user: number, id: string, type: string, deletedAt: number | null) =>
  // tenant-exempt: the fixture holds TWO tenants on purpose, so it writes
  // the id rather than binding one.
  driver.exec(
    "INSERT INTO nodes (user_id, id, type, text, props, updated_at, deleted_at, seq) " +
      "VALUES (?, ?, ?, ?, NULL, 100, ?, ?)",
    [user, id, type, id, deletedAt, seqOf(id)],
  )

/** A fixed sequence per fixture row, so the tenant's maximum is known. */
const SEQS: Record<string, number> = {
  n1: 1,
  v1: 8,
  n2: 2,
  n3: 3,
  n4: 4,
  n5: 5,
  n6: 6,
  n7: 7,
  n8: 20,
  v3: 8,
  v4: 9,
  v5: 10,
  v7: 11,
  v8: 21,
}
const seqOf = (id: string) => SEQS[id] ?? 0

const view = (
  driver: Driver,
  user: number,
  rootId: string,
  fields: { filter?: string | null; pinned: number; sort_key?: string | null; deletedAt?: number },
) =>
  // tenant-exempt: two tenants on purpose, as above.
  driver.exec(
    "INSERT INTO views (user_id, id, root_id, filter, sort, pinned, sort_key, updated_at, deleted_at, seq) " +
      "VALUES (?, ?, ?, ?, NULL, ?, ?, 100, ?, ?)",
    [
      user,
      rootId,
      rootId,
      fields.filter ?? null,
      fields.pinned,
      fields.sort_key ?? null,
      fields.deletedAt ?? null,
      seqOf(`v${rootId.slice(1)}`),
    ],
  )

const VIEW_COLUMNS =
  "SELECT user_id, id, root_id, filter, sort, pinned, sort_key, updated_at, deleted_at, seq " +
  "FROM views ORDER BY user_id, id"

test("0021 gives every live note and board a pinned row, pins a note's unpinned row, and leaves the rest alone", async () => {
  const driver = await createTenantTestDriver()
  // A note with no row, and a board with none: each gets one.
  await node(driver, 1, "n1", "note", null)
  await node(driver, 1, "n2", "board", null)
  // A note whose row carries only a filter (0015's backfill): pinned.
  await node(driver, 1, "n3", "note", null)
  await view(driver, 1, "n3", { filter: "type:todo", pinned: 0 })
  // A block's row, pinned or not, is not a note's: untouched.
  await node(driver, 1, "n4", "text", null)
  await view(driver, 1, "n4", { filter: "type:todo", pinned: 0 })
  await node(driver, 1, "n5", "text", null)
  await view(driver, 1, "n5", { pinned: 1 })
  // A tombstoned note gets none.
  await node(driver, 1, "n6", "note", 150)
  // A note already pinned is done.
  await node(driver, 1, "n7", "note", null)
  await view(driver, 1, "n7", { pinned: 1, sort_key: "a0" })
  // A second tenant's note must get a second tenant's row, numbered in that
  // tenant's own sequence.
  await node(driver, 2, "n8", "note", null)
  await view(driver, 2, "n8", { filter: "type:todo", pinned: 0 })

  await driver.execScript(migration0021)

  // tenant-exempt: every tenant's rows, deliberately.
  const after = await driver.exec(VIEW_COLUMNS)
  expect(after).toEqual([
    // Tenant 1's maximum was 11 (its rows) before step 1. Step 1 rewrote n3's
    // row (rowid 1): 11 + 1 = 12. Step 2 then inserted above the new maximum,
    // 12, each new row adding its node's rowid: n1 (rowid 1) → 13, n2
    // (rowid 2) → 14.
    {
      user_id: 1,
      id: "n1",
      root_id: "n1",
      filter: null,
      sort: null,
      pinned: 1,
      sort_key: null,
      // Stamped with the node's, as 0015's backfill was: no claim of intent.
      updated_at: 100,
      deleted_at: null,
      seq: 13,
    },
    {
      user_id: 1,
      id: "n2",
      root_id: "n2",
      filter: null,
      sort: null,
      pinned: 1,
      sort_key: null,
      updated_at: 100,
      deleted_at: null,
      seq: 14,
    },
    // The filter is kept: the note still opens with it. The row is the
    // newer version.
    {
      user_id: 1,
      id: "n3",
      root_id: "n3",
      filter: "type:todo",
      sort: null,
      pinned: 1,
      sort_key: null,
      updated_at: 101,
      deleted_at: null,
      seq: 12,
    },
    {
      user_id: 1,
      id: "n4",
      root_id: "n4",
      filter: "type:todo",
      sort: null,
      pinned: 0,
      sort_key: null,
      updated_at: 100,
      deleted_at: null,
      seq: 9,
    },
    {
      user_id: 1,
      id: "n5",
      root_id: "n5",
      filter: null,
      sort: null,
      pinned: 1,
      sort_key: null,
      updated_at: 100,
      deleted_at: null,
      seq: 10,
    },
    {
      user_id: 1,
      id: "n7",
      root_id: "n7",
      filter: null,
      sort: null,
      pinned: 1,
      sort_key: "a0",
      updated_at: 100,
      deleted_at: null,
      seq: 11,
    },
    // Tenant 2's maximum was 21; its one rewritten row (the table's fifth,
    // rowid 5) lands at 26, above everything tenant 2 holds.
    {
      user_id: 2,
      id: "n8",
      root_id: "n8",
      filter: "type:todo",
      sort: null,
      pinned: 1,
      sort_key: null,
      updated_at: 101,
      deleted_at: null,
      seq: 26,
    },
  ])

  // What delivery needs: every row written or rewritten sits above the
  // sequence a client of that tenant could have pulled up to, so
  // `seq > cursor` finds it — and above every other row's, so the cursor
  // the pull answers with is past them all.
  for (const [user, before] of [
    [1, 11],
    [2, 21],
  ]) {
    const touched = after.filter(
      (row) => row.user_id === user && ["n1", "n2", "n3", "n8"].includes(row.id as string),
    )
    for (const row of touched) expect(row.seq as number).toBeGreaterThan(before)
    const seqs = touched.map((row) => row.seq)
    expect(new Set(seqs).size).toBe(seqs.length)
  }
  // The nodes are not what changed: no node row moved.
  // tenant-exempt: a fixture read.
  expect(
    await driver.exec("SELECT id, updated_at, seq FROM nodes WHERE id IN ('n1', 'n3')"),
  ).toEqual([
    { id: "n1", updated_at: 100, seq: 1 },
    { id: "n3", updated_at: 100, seq: 3 },
  ])
})

test("0021 revives a note's tombstoned row in place rather than conflicting with it", async () => {
  const driver = await createTenantTestDriver()
  // A note whose row was cleared (a saved filter, then cleared: the row is
  // tombstoned, under the note's own id).
  await node(driver, 1, "n1", "note", null)
  await view(driver, 1, "n1", { filter: "type:todo", sort_key: "a0", pinned: 0, deletedAt: 120 })

  await driver.execScript(migration0021)

  // tenant-exempt: a fixture read.
  expect(await driver.exec(VIEW_COLUMNS)).toEqual([
    {
      user_id: 1,
      id: "n1",
      root_id: "n1",
      // As a fresh row would be: what the tombstone held is not brought back.
      filter: null,
      sort: null,
      pinned: 1,
      sort_key: null,
      // Past the tombstone's stamp, so the revived row is the newer version.
      updated_at: 101,
      deleted_at: null,
      // Tenant 1's maximum was 8 (the tombstone); step 1 matched nothing,
      // step 2 inserted n1 (rowid 1) at 8 + 1.
      seq: 9,
    },
  ])
})

test("0021 is re-runnable: a second pass changes nothing", async () => {
  const driver = await createTenantTestDriver()
  await node(driver, 1, "n1", "note", null)
  await node(driver, 1, "n2", "board", null)
  await node(driver, 1, "n3", "note", null)
  await view(driver, 1, "n3", { filter: "type:todo", pinned: 0 })
  await node(driver, 1, "n4", "text", null)
  await view(driver, 1, "n4", { pinned: 1 })
  await node(driver, 2, "n8", "note", null)

  await driver.execScript(migration0021)
  // tenant-exempt: a fixture read.
  const first = await driver.exec(VIEW_COLUMNS)
  await driver.execScript(migration0021)
  // tenant-exempt: a fixture read.
  expect(await driver.exec(VIEW_COLUMNS)).toEqual(first)
  expect(first.map((row) => [row.user_id, row.id, row.pinned])).toEqual([
    [1, "n1", 1],
    [1, "n2", 1],
    [1, "n3", 1],
    [1, "n4", 1],
    [2, "n8", 1],
  ])
  // The scratch table does not outlive the run.
  // tenant-exempt: a schema read.
  expect(
    await driver.exec(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'note_views_seq_base'",
    ),
  ).toEqual([])
})
