// tenant-guard: exempt — this suite reads query PLANS, and the one statement
// it writes by hand is the bad shape it exists to recognise.
import { beforeAll, describe, expect, it } from "vitest"
import type { SqlDriver, SqlValue } from "../src/data/sql-driver"
import { corpusPullSince } from "./handlers/replica-corpus"
import {
  linksAbove,
  linksBelow,
  linksFrom,
  nodesByIds,
  nodesWrittenIn,
  noteNodes,
  scopeNodeIds,
} from "./mcp/graph-load"
import { createMcpTestEnv, type McpTestEnv } from "./mcp/test-support"
import { shareFromRow } from "./shares/grant"
import { sliceRows } from "./shares/slice"
import { forTenant, type TenantDb } from "./tenancy-db"

/**
 * Every statement a bounded read issues must reach `nodes` and `link` through
 * an index that narrows on something MORE than the tenant.
 *
 * This is the guard the row-count tests cannot be. `harness.measure` counts
 * the rows a statement RETURNS, and D1 bills the rows it SCANS; for a walk
 * those are the same only if the planner seeks. On 2026-09-15 it did not: the
 * recursive step of the share slice was planned as "for each node reached,
 * scan every link the tenant has" — `link_tenant_seq (user_id=?)` rather than
 * `link_tenant_source (user_id=? AND source_id=?)` — so pulling a 285-block
 * share read 329k rows, and a morning of tab switches spent 92% of the day's
 * D1 read budget. Rows returned: 569. Nothing counting those could see it.
 *
 * So this suite asks SQLite for the plan of every statement the loaders run
 * and fails on any step that scans a corpus table or seeks it by `user_id`
 * alone. A fresh `node:sqlite` database has no `sqlite_stat1`, exactly as D1
 * has none, so the plans here are the plans production runs.
 *
 * Fixing a flagged statement means making the closure the OUTER loop —
 * `FROM visible v CROSS JOIN link l ON l.source_id = v.id`, which SQLite
 * honours as a join-order hint — not adding an index; the index was there.
 */

const USER = 21
const OWNER = 22

/** The corpus tables the rule applies to, and how their aliases are declared. */
const CORPUS_TABLE = /\b(?:FROM|JOIN)\s+(nodes|link)\b(?:\s+(?:AS\s+)?([A-Za-z_]\w*))?/gi
const NOT_AN_ALIAS = new Set(["WHERE", "ON", "JOIN", "CROSS", "LEFT", "INNER", "SET", "USING"])

/** Which names in `sql` (table or alias) stand for `nodes` or `link`. */
function corpusNames(sql: string): Set<string> {
  const names = new Set<string>()
  for (const match of sql.matchAll(CORPUS_TABLE)) {
    names.add(match[1].toLowerCase())
    const alias = match[2]
    if (alias !== undefined && !NOT_AN_ALIAS.has(alias.toUpperCase())) names.add(alias)
  }
  return names
}

/**
 * The plan steps of `sql` that read a corpus table without narrowing past
 * the tenant: a full `SCAN`, or a `SEARCH` whose only constraint is
 * `user_id=?`. Empty for a statement whose cost is bounded by its question.
 */
async function partitionScans(driver: SqlDriver, sql: string, params: SqlValue[]) {
  const names = corpusNames(sql)
  const plan = await driver.exec(`EXPLAIN QUERY PLAN ${sql}`, params)
  const scans: string[] = []
  for (const row of plan) {
    const detail = String(row.detail)
    const scan = /^SCAN (\w+)/.exec(detail)
    if (scan && names.has(scan[1])) scans.push(detail)
    const search = /^SEARCH (\w+) USING (?:COVERING )?INDEX \w+ \((.*)\)$/.exec(detail)
    if (search && names.has(search[1]) && search[2] === "user_id=?") scans.push(detail)
  }
  return scans
}

interface Recorded {
  sql: string
  params: SqlValue[]
}

let harness: McpTestEnv
let recorded: Recorded[] = []

/** A tenant handle whose every statement is remembered, bound form and all. */
function recordingTenant(userId: number): TenantDb {
  const driver = harness.control
  return forTenant(
    {
      exec: (sql, params = []) => {
        recorded.push({ sql, params })
        return driver.exec(sql, params)
      },
      batch: driver.batch,
      execScript: driver.execScript,
      close: driver.close,
    },
    { id: userId, login: `user-${userId}`, name: null },
  )
}

/** Run a read and return the partition scans in every statement it issued. */
async function scansOf(read: () => Promise<unknown>): Promise<string[]> {
  recorded = []
  await read()
  expect(recorded.length, "the read issued no statement").toBeGreaterThan(0)
  const found: string[] = []
  for (const { sql, params } of recorded) {
    for (const scan of await partitionScans(harness.control, sql, params)) {
      found.push(`${scan}\n  in: ${sql}`)
    }
  }
  return found
}

const OUTLINE = [
  "- one",
  "  - one a",
  "    - one a i",
  "    - one a ii",
  "  - one b",
  "- two",
  "  - two a",
].join("\n")

beforeAll(async () => {
  harness = await createMcpTestEnv()
  await harness.addUser(USER)
  await harness.addUser(OWNER)
  for (const id of ["blk_n1", "blk_n2", "blk_n3"]) {
    await harness.seedNote(USER, { id, title: id, markdown: OUTLINE })
  }
  await harness.seedNote(OWNER, { id: "blk_shared", title: "Shared", markdown: OUTLINE })
  await harness.seedNote(OWNER, { id: "blk_private", title: "Private", markdown: OUTLINE })
})

/** A block a few levels down in a seeded note. */
async function deepBlockOf(tenant: TenantDb, noteId: string): Promise<string> {
  const below = await linksBelow(tenant, [noteId], null)
  const leaf = below.nodes.find((node) => node.text === "one a ii")
  if (!leaf) throw new Error("fixture lost its leaf")
  return leaf.id
}

describe("the share slice", () => {
  it("is read through the closure, never by scanning the owner's partition", async () => {
    const owner = recordingTenant(OWNER)
    const grant = shareFromRow({
      id: "shr_test",
      owner_id: OWNER,
      grantee_email: "someone@example.com",
      view_id: "blk_shared",
      permissions: "read",
      created_at: 1,
      revoked_at: null,
    })
    let rows: Awaited<ReturnType<typeof sliceRows>> | undefined
    const scans = await scansOf(async () => {
      rows = await sliceRows(owner, grant)
    })
    expect(scans).toEqual([])
    // The read still answers: the shared note, and nothing of the other one.
    expect(rows?.nodes.length).toBe(8)
    expect(rows?.nodes.some((node) => node.text === "Private")).toBe(false)
  })
})

describe("the MCP loaders", () => {
  it("walk down from a note by seeking each node's links", async () => {
    const tenant = recordingTenant(USER)
    expect(await scansOf(() => linksBelow(tenant, ["blk_n1"], null))).toEqual([])
    expect(await scansOf(() => linksBelow(tenant, ["blk_n1"], 2))).toEqual([])
  })

  it("walk up from a block by seeking each node's parents", async () => {
    const tenant = recordingTenant(USER)
    const deep = await deepBlockOf(tenant, "blk_n2")
    expect(await scansOf(() => linksAbove(tenant, [deep]))).toEqual([])
  })

  it("derive a note scope from the granted notes outwards", async () => {
    const tenant = recordingTenant(USER)
    expect(await scansOf(() => scopeNodeIds(tenant, ["blk_n1", "blk_n3"]))).toEqual([])
  })

  it("make every point read an index seek", async () => {
    const tenant = recordingTenant(USER)
    const deep = await deepBlockOf(tenant, "blk_n1")
    expect(await scansOf(() => nodesByIds(tenant, [deep, "blk_n2"]))).toEqual([])
    expect(await scansOf(() => linksFrom(tenant, ["blk_n1", deep]))).toEqual([])
    expect(await scansOf(() => nodesWrittenIn(tenant, "blk_n1"))).toEqual([])
    // Every note is a partition-wide question by nature; the index it is
    // answered on narrows by type, which is what keeps it off the blocks.
    expect(await scansOf(() => noteNodes(tenant))).toEqual([])
  })
})

describe("the replica pull", () => {
  it("reads only the rows past the cursor", async () => {
    const tenant = recordingTenant(USER)
    expect(await scansOf(() => corpusPullSince(tenant, 5))).toEqual([])
  })
})

describe("the guard itself", () => {
  it("recognises the plan that spent the budget", async () => {
    // The share closure as it was written before 2026-09-15: a plain JOIN,
    // which the planner turns into a scan of the tenant's links per visited
    // node. If this stops being flagged, the guard above proves nothing.
    const before =
      "WITH RECURSIVE granted (id) AS ( " +
      "SELECT n.id FROM nodes n WHERE n.user_id = ?2 AND n.deleted_at IS NULL " +
      "AND n.id IN (?1) ), " +
      "visible (id) AS ( SELECT id FROM granted UNION " +
      "SELECT l.destination_id FROM visible v " +
      "JOIN link l ON l.user_id = ?2 AND l.source_id = v.id " +
      "AND l.kind = 'child' AND l.deleted_at IS NULL " +
      "JOIN nodes c ON c.user_id = ?2 AND c.id = l.destination_id " +
      "AND c.deleted_at IS NULL ) " +
      "SELECT l.source_id FROM link l " +
      "JOIN visible a ON a.id = l.source_id " +
      "JOIN visible b ON b.id = l.destination_id " +
      "WHERE l.user_id = ?2 AND l.deleted_at IS NULL AND l.kind = 'child'"
    const scans = await partitionScans(harness.control, before, ["blk_shared", OWNER])
    expect(scans.length).toBeGreaterThan(0)
    expect(scans.every((scan) => /^SEARCH l USING INDEX \w+ \(user_id=\?\)$/.test(scan))).toBe(true)
  })

  it("lets a bounded seek through", async () => {
    const seek = "SELECT id FROM nodes WHERE user_id = ?1 AND id = ?2 AND deleted_at IS NULL"
    expect(await partitionScans(harness.control, seek, [USER, "blk_n1"])).toEqual([])
  })
})
