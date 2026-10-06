import { expect, test } from "vitest"
import migration0020 from "../../migrations/0020_board_type.sql?raw"
import { createTenantTestDriver } from "./sqlite-test-driver"

/**
 * 0020 against the **exact shape production D1 is in** (the real ladder, as
 * `createTenantTestDriver` builds it — which applies 0020 on creation,
 * against an empty corpus, so running the file here is its second pass over
 * the schema and its first over rows).
 *
 * What it has to get right: a board's root retyped from `note` with the old
 * `board: true` prop to `board`, the prop gone from `props` and the row's
 * `updated_at` bumped so the retyped version travels; a plain note, a block
 * and a board already retyped left exactly as they are; and all of it per
 * tenant.
 */

const node = (
  driver: Awaited<ReturnType<typeof createTenantTestDriver>>,
  user: number,
  id: string,
  type: string,
  props: string | null,
) =>
  // tenant-exempt: the fixture holds TWO tenants on purpose, so it writes
  // the id rather than binding one.
  driver.exec(
    "INSERT INTO nodes (user_id, id, type, text, props, updated_at, deleted_at) " +
      "VALUES (?, ?, ?, ?, ?, 100, NULL)",
    [user, id, type, id, props],
  )

test("0020 retypes a legacy board, strips the prop and bumps updated_at; everything else is untouched", async () => {
  const driver = await createTenantTestDriver()
  await node(driver, 1, "n1", "note", '{"board":true,"width":"full"}')
  await node(driver, 1, "n2", "note", '{"board":true}')
  await node(driver, 1, "n3", "note", '{"title":"Plain"}')
  await node(driver, 1, "n4", "note", null)
  // Only `true` ever made a board.
  await node(driver, 1, "n5", "note", '{"board":"yes"}')
  // A block carrying the key is a block; a board already retyped is done.
  await node(driver, 1, "n6", "text", '{"board":true}')
  await node(driver, 1, "n7", "board", '{"width":"full"}')
  // A second tenant's board must stay a second tenant's board.
  await node(driver, 2, "n8", "note", '{"board":true}')

  await driver.execScript(migration0020)

  // tenant-exempt: every tenant's rows, deliberately.
  const after = await driver.exec("SELECT id, type, props, updated_at FROM nodes ORDER BY id")
  expect(after).toEqual([
    { id: "n1", type: "board", props: '{"width":"full"}', updated_at: 101 },
    // A row left with nothing reads as no props: NULL, not `{}`.
    { id: "n2", type: "board", props: null, updated_at: 101 },
    { id: "n3", type: "note", props: '{"title":"Plain"}', updated_at: 100 },
    { id: "n4", type: "note", props: null, updated_at: 100 },
    { id: "n5", type: "note", props: '{"board":"yes"}', updated_at: 100 },
    { id: "n6", type: "text", props: '{"board":true}', updated_at: 100 },
    { id: "n7", type: "board", props: '{"width":"full"}', updated_at: 100 },
    { id: "n8", type: "board", props: null, updated_at: 101 },
  ])
})

test("0020 is re-runnable: a second pass matches no row", async () => {
  const driver = await createTenantTestDriver()
  await node(driver, 1, "n1", "note", '{"board":true,"title":"Wall"}')
  await node(driver, 1, "n2", "note", '{"title":"Plain"}')
  await driver.execScript(migration0020)
  // tenant-exempt: a fixture read.
  const first = await driver.exec("SELECT id, type, props, updated_at FROM nodes ORDER BY id")
  await driver.execScript(migration0020)
  // tenant-exempt: a fixture read.
  expect(await driver.exec("SELECT id, type, props, updated_at FROM nodes ORDER BY id")).toEqual(
    first,
  )
  expect(first).toEqual([
    { id: "n1", type: "board", props: '{"title":"Wall"}', updated_at: 101 },
    { id: "n2", type: "note", props: '{"title":"Plain"}', updated_at: 100 },
  ])
})
