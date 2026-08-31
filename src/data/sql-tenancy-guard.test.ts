// tenant-guard: exempt — every SQL literal below is a specimen fed TO the
// guard, not a query this app runs.
import { describe, expect, it } from "vitest"
import { checkSource, checkStatement, corpusTablesIn, scanSource } from "./sql-tenancy-guard"

const tenant = { mode: "tenant" } as const
const single = { mode: "single" } as const

describe("checkStatement — tenancy", () => {
  it("accepts a fully scoped read", () => {
    expect(
      checkStatement("SELECT id FROM nodes WHERE user_id = :tenant AND deleted_at IS NULL", tenant),
    ).toEqual([])
  })

  it("rejects a corpus read with no tenant predicate", () => {
    expect(checkStatement("SELECT id FROM nodes WHERE deleted_at IS NULL", tenant)).toEqual([
      "missing-tenant-predicate",
    ])
  })

  it("rejects a `user_id` that is not bound by the :tenant token", () => {
    // The whole point: a caller supplying its own id must not satisfy the rule.
    expect(
      checkStatement("SELECT id FROM nodes WHERE user_id = ?1 AND deleted_at IS NULL", tenant),
    ).toEqual(["missing-tenant-predicate"])
  })

  it("does not ask the single-tenant shape for a column it does not have", () => {
    expect(checkStatement("SELECT id FROM nodes WHERE deleted_at IS NULL", single)).toEqual([])
  })

  it("leaves statements that touch no corpus table alone", () => {
    expect(checkStatement("SELECT github_id FROM users WHERE github_id = ?1", tenant)).toEqual([])
    expect(checkStatement("SELECT name FROM sqlite_master WHERE type = 'table'", tenant)).toEqual(
      [],
    )
  })

  it("leaves DDL alone (schema lives in migrations)", () => {
    expect(checkStatement("DROP TABLE IF EXISTS nodes", tenant)).toEqual([])
    expect(checkStatement("CREATE INDEX nodes_type ON nodes (user_id, type)", tenant)).toEqual([])
  })
})

describe("checkStatement — soft deletes", () => {
  it("rejects a read of nodes/link that says nothing about tombstones", () => {
    expect(checkStatement("SELECT id FROM nodes WHERE user_id = :tenant", tenant)).toEqual([
      "missing-deleted-at-predicate",
    ])
  })

  it("is not fooled by `deleted_at` appearing only in the SELECT list", () => {
    expect(
      checkStatement("SELECT id, deleted_at FROM nodes WHERE user_id = :tenant", tenant),
    ).toEqual(["missing-deleted-at-predicate"])
  })

  it("accepts a read that opts in to tombstones, either way", () => {
    const sql = "SELECT id FROM nodes WHERE user_id = :tenant"
    expect(checkStatement(sql, { ...tenant, includingDeleted: true })).toEqual([])
    expect(checkStatement(sql + " /* includes-deleted: replication */", tenant)).toEqual([])
    expect(checkStatement(sql, tenant, "// includes-deleted: replication")).toEqual([])
  })

  it("requires an INSERT into nodes/link to state the row's tombstone state", () => {
    expect(
      checkStatement(
        "INSERT INTO nodes (user_id, id, updated_at) VALUES (:tenant, ?1, ?2)",
        tenant,
      ),
    ).toEqual(["missing-deleted-at-column"])
    expect(
      checkStatement(
        "INSERT INTO nodes (user_id, id, updated_at, deleted_at) VALUES (:tenant, ?1, ?2, ?3)",
        tenant,
      ),
    ).toEqual([])
  })

  it("refuses a hard DELETE from nodes/link outright", () => {
    expect(checkStatement("DELETE FROM nodes WHERE user_id = :tenant AND id = ?1", tenant)).toEqual(
      ["hard-delete"],
    )
  })

  it("does not ask `meta` about tombstones — it has no such column", () => {
    expect(
      checkStatement("SELECT value FROM meta WHERE user_id = :tenant AND key = ?1", tenant),
    ).toEqual([])
    expect(checkStatement("DELETE FROM meta WHERE user_id = :tenant AND key = ?1", tenant)).toEqual(
      [],
    )
  })

  it("reports every broken rule, not just the first", () => {
    expect(checkStatement("SELECT id FROM nodes", tenant).sort()).toEqual([
      "missing-deleted-at-predicate",
      "missing-tenant-predicate",
    ])
  })
})

describe("checkStatement — the escape hatch", () => {
  it("waives both rules, in the SQL or in a comment above it", () => {
    expect(checkStatement("DELETE FROM nodes -- tenant-exempt: local store wipe", tenant)).toEqual(
      [],
    )
    expect(
      checkStatement("DELETE FROM nodes", tenant, "// tenant-exempt: local store wipe"),
    ).toEqual([])
  })
})

describe("corpusTablesIn", () => {
  it("finds the corpus tables a statement names, and no others", () => {
    expect(corpusTablesIn("SELECT * FROM link JOIN nodes ON 1 = 1").sort()).toEqual([
      "link",
      "nodes",
    ])
    expect(corpusTablesIn("SELECT * FROM users")).toEqual([])
    // A table whose name merely starts with a corpus name is not one.
    expect(corpusTablesIn("SELECT * FROM nodes_v3")).toEqual([])
  })
})

describe("scanSource", () => {
  it("keeps strings and comments apart, and merges runs of line comments", () => {
    const scan = scanSource(["// one", "// two", 'const a = "SELECT 1" // trailing'].join("\n"))
    expect(scan.literals.map((literal) => literal.text)).toEqual(["SELECT 1"])
    expect(scan.comments[0].text).toBe("// one\n// two")
    expect(scan.comments[0].endLine).toBe(2)
  })

  it("does not mistake a comment's contents for code", () => {
    const scan = scanSource("// SELECT id FROM nodes\nconst a = 1")
    expect(scan.literals).toEqual([])
  })
})

describe("checkSource", () => {
  const violating = ['const sql = "SELECT id FROM nodes WHERE deleted_at IS NULL"', ""].join("\n")

  const compliant = [
    "const sql =",
    '  "SELECT id, type FROM nodes " +',
    '  "WHERE user_id = :tenant AND deleted_at IS NULL"',
    "",
  ].join("\n")

  it("flags an unscoped statement with its line", () => {
    expect(checkSource(violating, { mode: "tenant" })).toEqual([
      {
        line: 1,
        rule: "missing-tenant-predicate",
        statement: "SELECT id FROM nodes WHERE deleted_at IS NULL",
      },
    ])
  })

  it("passes a compliant statement split across concatenated literals", () => {
    expect(checkSource(compliant, { mode: "tenant" })).toEqual([])
  })

  it("finds an annotation on the lines just above a multi-line statement", () => {
    const source = [
      "// tenant-exempt: mirroring a purge, not performing a delete —",
      "// the row is gone from the replica entirely.",
      "statements.push({",
      '  sql: "DELETE FROM link WHERE source_id = ?",',
      "})",
      "",
    ].join("\n")
    expect(checkSource(source, { mode: "tenant" })).toEqual([])
  })

  it("bans the raw D1 binding outside the tenancy module", () => {
    const source = "const driver = createD1SqlDriver(env.DB)\n"
    expect(checkSource(source, { mode: "tenant" })).toEqual([
      { line: 1, rule: "env-db-outside-tenancy-module", statement: "env.DB" },
    ])
    expect(checkSource(source, { mode: "tenant", allowEnvDb: true })).toEqual([])
  })

  it("skips a file that opts out near the top, and only near the top", () => {
    expect(
      checkSource("// tenant-guard: exempt — a spec\n" + violating, { mode: "tenant" }),
    ).toHaveLength(0)
    const late = new Array(70).fill("//").join("\n") + "\n// tenant-guard: exempt\n" + violating
    expect(checkSource(late, { mode: "tenant" })).toHaveLength(1)
  })

  it("ignores prose that merely mentions SQL", () => {
    const source = "/** Reads `SELECT id FROM nodes` — prose, not a query. */\nconst a = 1\n"
    expect(checkSource(source, { mode: "tenant" })).toEqual([])
  })
})
