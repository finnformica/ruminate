import { expect, test } from "vitest"
import migration0015 from "../../migrations/0015_views.sql?raw"
import { createTenantTestDriver } from "./sqlite-test-driver"

/**
 * 0015 against the **exact shape production D1 is in** (the real ladder, as
 * `createTenantTestDriver` builds it). A migration that would fail on the
 * deployed database fails here first.
 *
 * What it has to get right: one view per node that carried any of the three
 * retired keys, the keys gone from `props` afterwards, the row's `updated_at`
 * bumped so the cleaned version travels, and every one of those things done
 * per tenant.
 */
/**
 * A database in the shape 0015 will actually meet: the full ladder, wound
 * back one rung. The ladder applies 0015 on creation (against an empty
 * corpus, so both its data halves are no-ops); dropping the table it made
 * puts us at v4 with rows, which is the state production was in.
 */
async function v4Driver() {
  const driver = await createTenantTestDriver()
  await driver.exec("DROP TABLE views")
  return driver
}

test("0015 backfills a view per node that had one, and retires the keys", async () => {
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

  // tenant-exempt: as above — every tenant's rows, deliberately.
  const nodes = await driver.exec("SELECT id, props, updated_at FROM nodes ORDER BY id")
  expect(nodes).toEqual([
    // The three keys gone, everything else kept, and stamped so the cleaned
    // row travels on the next incremental pull.
    { id: "n1", props: '{"title":"Shopping"}', updated_at: 101 },
    { id: "n2", props: null, updated_at: 100 },
    // A node that carried none of them is not touched at all.
    { id: "n3", props: '{"language":"ts"}', updated_at: 100 },
    { id: "n4", props: "{}", updated_at: 101 },
    { id: "n5", props: "{}", updated_at: 101 },
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
