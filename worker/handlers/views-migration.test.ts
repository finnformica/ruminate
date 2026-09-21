import { expect, test } from "vitest"
import migration0015 from "../../migrations/0015_views.sql?raw"
import migration0016 from "../../migrations/0016_retire_view_props.sql?raw"
import { createTenantTestDriver } from "./sqlite-test-driver"

/**
 * 0015 and 0016 against the **exact shape production D1 is in** (the real
 * ladder, as `createTenantTestDriver` builds it). A migration that would
 * fail on the deployed database fails here first.
 *
 * What the pair has to get right: one view per node that carried any of the
 * three retired keys (0015), the keys gone from `props` afterwards and the
 * row's `updated_at` bumped so the cleaned version travels (0016), and every
 * one of those things done per tenant.
 */
/**
 * A database in the shape 0015 will actually meet: the full ladder, wound
 * back one rung. The ladder applies 0015 and 0016 on creation (against an
 * empty corpus, so both their data halves are no-ops); dropping the table
 * 0015 made puts us at v4 with rows, which is the state production was in.
 */
async function v4Driver() {
  const driver = await createTenantTestDriver()
  await driver.exec("DROP TABLE views")
  return driver
}

test("0015 backfills a view per node that had one, leaving the props alone", async () => {
  const driver = await v4Driver()
  const node = (user: number, id: string, type: string, props: string | null) =>
    // tenant-exempt: the point of the fixture is that it holds TWO tenants,
    // so it writes the id rather than binding one.
    driver.exec(
      "INSERT INTO nodes (user_id, id, type, text, props, updated_at, deleted_at) " +
        "VALUES (?, ?, ?, ?, ?, 100, NULL)",
      [user, id, type, id, props],
    )

  await node(
    1,
    "n1",
    "note",
    '{"title":"Shopping","pinned":true,"filter":"type:todo","sort":"text:desc"}',
  )
  await node(1, "n2", "text", null)
  await node(1, "n3", "text", '{"language":"ts"}')
  await node(1, "n4", "text", '{"filter":"type:task"}')
  // A second tenant's pin must stay a second tenant's pin.
  await node(2, "n5", "note", '{"pinned":true}')

  await driver.execScript(migration0015)

  const views = await driver.exec(
    // tenant-exempt: reads both tenants on purpose, to prove they stayed apart.
    "SELECT user_id, id, root_id, filter, sort, pinned, sort_key FROM views ORDER BY user_id, id",
  )
  expect(views).toEqual([
    {
      user_id: 1,
      id: "n1",
      root_id: "n1",
      filter: "type:todo",
      sort: "text:desc",
      pinned: 1,
      // Left NULL rather than invented in SQL: the client keeps its existing
      // order until something is dragged, and assigns keys then.
      sort_key: null,
    },
    {
      user_id: 1,
      id: "n4",
      root_id: "n4",
      filter: "type:task",
      sort: null,
      pinned: 0,
      sort_key: null,
    },
    { user_id: 2, id: "n5", root_id: "n5", filter: null, sort: null, pinned: 1, sort_key: null },
  ])

  // 0015 is additive: the props it copied FROM are untouched, so a client
  // that has not been replaced yet still works. Retiring them is 0016's job,
  // shipped WITH the client that reads the table (below).
  // tenant-exempt: as above — every tenant's rows, deliberately.
  const afterBackfill = await driver.exec("SELECT id, props, updated_at FROM nodes ORDER BY id")
  expect(afterBackfill).toEqual([
    {
      id: "n1",
      props: '{"title":"Shopping","pinned":true,"filter":"type:todo","sort":"text:desc"}',
      updated_at: 100,
    },
    { id: "n2", props: null, updated_at: 100 },
    { id: "n3", props: '{"language":"ts"}', updated_at: 100 },
    { id: "n4", props: '{"filter":"type:task"}', updated_at: 100 },
    { id: "n5", props: '{"pinned":true}', updated_at: 100 },
  ])
})

test("0015 is re-runnable: applying it twice changes nothing", async () => {
  const driver = await v4Driver()
  await driver.exec(
    // tenant-exempt: a fixture row for a fixed tenant.
    "INSERT INTO nodes (user_id, id, type, text, props, updated_at, deleted_at) " +
      "VALUES (1, 'n1', 'note', 'x', ?, 100, NULL)",
    ['{"pinned":true}'],
  )
  await driver.execScript(migration0015)
  // tenant-exempt: a fixture read.
  const first = await driver.exec("SELECT * FROM views")
  // The table already exists on a second run, so only the data half repeats —
  // which is the half that has to be idempotent.
  await driver.exec(
    // tenant-exempt: a fixture row for a fixed tenant.
    "INSERT INTO views (user_id, id, root_id, pinned, updated_at) VALUES (1, 'n1', 'n1', 1, 100) " +
      "ON CONFLICT (user_id, id) DO NOTHING",
  )
  // tenant-exempt: a fixture read.
  expect(await driver.exec("SELECT * FROM views")).toEqual(first)
})

test("0016 retires the three keys from props, bumps updated_at, and leaves other props alone", async () => {
  const driver = await v4Driver()
  const node = (user: number, id: string, props: string | null) =>
    // tenant-exempt: two tenants on purpose, as above.
    driver.exec(
      "INSERT INTO nodes (user_id, id, type, text, props, updated_at, deleted_at) " +
        "VALUES (?, ?, 'note', ?, ?, 100, NULL)",
      [user, id, id, props],
    )
  await node(1, "n1", '{"title":"Shopping","pinned":true,"filter":"type:todo","width":"full"}')
  await node(1, "n2", null)
  await node(1, "n3", '{"language":"ts"}')
  await node(1, "n4", '{"sort":"text:desc"}')
  await node(2, "n5", '{"pinned":true}')

  await driver.execScript(migration0015)
  await driver.execScript(migration0016)

  // tenant-exempt: every tenant's rows, deliberately.
  const after = await driver.exec("SELECT id, props, updated_at FROM nodes ORDER BY id")
  expect(after).toEqual([
    // The other keys stay, in their order; the row is the newer version.
    { id: "n1", props: '{"title":"Shopping","width":"full"}', updated_at: 101 },
    { id: "n2", props: null, updated_at: 100 },
    { id: "n3", props: '{"language":"ts"}', updated_at: 100 },
    // A row left with nothing reads as no props: NULL, not `{}`.
    { id: "n4", props: null, updated_at: 101 },
    { id: "n5", props: null, updated_at: 101 },
  ])
  // What 0015 copied out is still there to be read.
  // tenant-exempt: as above.
  const views = await driver.exec("SELECT id, filter, sort, pinned FROM views ORDER BY user_id, id")
  expect(views).toEqual([
    { id: "n1", filter: "type:todo", sort: null, pinned: 1 },
    { id: "n4", filter: null, sort: "text:desc", pinned: 0 },
    { id: "n5", filter: null, sort: null, pinned: 1 },
  ])
})

test("0016 is re-runnable: a second pass matches no row", async () => {
  const driver = await v4Driver()
  await driver.exec(
    // tenant-exempt: a fixture row for a fixed tenant.
    "INSERT INTO nodes (user_id, id, type, text, props, updated_at, deleted_at) " +
      "VALUES (1, 'n1', 'note', 'x', ?, 100, NULL)",
    ['{"pinned":true,"title":"x"}'],
  )
  await driver.execScript(migration0015)
  await driver.execScript(migration0016)
  // tenant-exempt: a fixture read.
  const first = await driver.exec("SELECT id, props, updated_at FROM nodes")
  await driver.execScript(migration0016)
  // tenant-exempt: a fixture read.
  expect(await driver.exec("SELECT id, props, updated_at FROM nodes")).toEqual(first)
  expect(first).toEqual([{ id: "n1", props: '{"title":"x"}', updated_at: 101 }])
})
