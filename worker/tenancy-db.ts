// The tenant-scoped data path — the ONE module that touches the raw D1
// binding, and the one place a tenant handle is minted.
//
// Column-scoped tenancy (docs/multi-tenant-design.md, "Decision reversal")
// trades the Durable Object's placement isolation for filter discipline. This
// module is that discipline made structural: request-handling code never
// receives `env.DB`, only a `TenantDb` bound to a *verified* GitHub id, and
// every statement that reaches D1 through it has been checked against the
// tenancy + soft-delete rules in `src/data/sql-tenancy-guard.ts` first.
//
// Three properties, in order of how much they matter:
//
// 1. **The tenant id is bound here, never passed in.** Statements name the
//    tenant with the token `:tenant`; `TenantDb` rewrites it to a positional
//    placeholder and appends the verified id itself. A caller cannot supply a
//    user id, because there is no parameter for one.
// 2. **Unscoped statements do not run.** A statement touching `nodes`, `link`
//    or `meta` without `user_id` + `:tenant` throws before it reaches the
//    database — as does a read of `nodes`/`link` that says nothing about
//    tombstones, and any `DELETE` from them (nothing is hard-deleted).
// 3. **The escapes are narrow and greppable.** `includingDeleted()` for reads
//    that genuinely want tombstones (replication, trash, audit);
//    `-- tenant-exempt: <reason>` for the rare statement with no tenant to
//    name; `controlPlaneDriver` for `users`/`allowlist`, which are not
//    tenant-scoped data at all.
//
// The `SqlDriver` seam is preserved underneath (docs/multi-tenant-design.md
// §10): planners stay engine-agnostic, and the worker test suites drive this
// exact code over `node:sqlite`.

import {
  CURRENT_DATA_VERSION,
  DATA_VERSION_KEY,
  toLinkRow,
  toNodeRow,
  type CorpusAccess,
} from "../src/data/data-version"
import type { SqlDriver, SqlStatement, SqlValue } from "../src/data/sql-driver"
import { checkStatement, explainRule } from "../src/data/sql-tenancy-guard"
import { createD1SqlDriver } from "./d1-sql-driver"
import type { VerifiedIdentity } from "./handlers/tenancy"
import type { Env } from "./types"

/** The corpus schema version the Worker expects in D1 (migrations/0004). */
const TENANT_SCHEMA_VERSION = "3"

/** The token a statement uses to name its tenant. Only `TenantDb` binds it. */
const TENANT_TOKEN = /:tenant\b/g

/**
 * A tenant-scoped handle on the corpus tables. Obtain one from `forTenant`;
 * there is no constructor and no way to widen it.
 */
export interface TenantDb {
  /** The verified GitHub id every statement is bound to. */
  readonly userId: number
  /** Run one statement, returning rows. */
  exec(sql: string, params?: SqlValue[]): Promise<Record<string, SqlValue>[]>
  /** Run statements atomically — one transaction, all or nothing. */
  batch(statements: SqlStatement[]): Promise<void>
  /**
   * A view of the same tenant that may read and update tombstoned rows. For
   * replication, trash and audit — the deliberate, greppable opt-out from the
   * `deleted_at`-predicate rule. It does NOT widen tenancy.
   */
  includingDeleted(): TenantDb
}

/** Thrown when a statement breaks the tenancy or soft-delete rules. */
export class TenantScopeError extends Error {
  constructor(reason: string, sql: string) {
    super(`TenantDb refused a statement: ${reason}\n  ${sql}`)
    this.name = "TenantScopeError"
  }
}

function bindTenant(
  sql: string,
  params: SqlValue[],
  userId: number,
): { sql: string; params: SqlValue[] } {
  if (!TENANT_TOKEN.test(sql)) return { sql, params }
  TENANT_TOKEN.lastIndex = 0
  const position = params.length + 1
  return { sql: sql.replace(TENANT_TOKEN, `?${position}`), params: [...params, userId] }
}

function makeTenantDb(driver: SqlDriver, userId: number, includingDeleted: boolean): TenantDb {
  const guard = (sql: string) => {
    const broken = checkStatement(sql, { mode: "tenant", includingDeleted })
    if (broken.length > 0) throw new TenantScopeError(explainRule(broken[0]), sql)
  }
  return {
    userId,
    // Both methods return a rejected promise rather than throwing
    // synchronously: a refusal is an ordinary failed query as far as every
    // caller (and every `await`) is concerned.
    exec: async (sql, params = []) => {
      guard(sql)
      const bound = bindTenant(sql, params, userId)
      return driver.exec(bound.sql, bound.params)
    },
    batch: async (statements) => {
      // Guard the whole batch before running any of it, so a refusal leaves
      // nothing half-applied.
      const bound = statements.map((statement) => {
        guard(statement.sql)
        return bindTenant(statement.sql, statement.params ?? [], userId)
      })
      await driver.batch(bound)
    },
    includingDeleted: () => makeTenantDb(driver, userId, true),
  }
}

/**
 * Mint a tenant handle from a **verified** identity — the identity type only
 * `requireSession` produces, from GitHub's answer to our own token check. This
 * is the single mint on the request path; grep for it and you have found every
 * way a corpus is addressed.
 */
export function forTenant(driver: SqlDriver, identity: VerifiedIdentity): TenantDb {
  if (!Number.isSafeInteger(identity.id)) {
    throw new TenantScopeError("verified identity has a non-integer id", String(identity.id))
  }
  return makeTenantDb(driver, identity.id, false)
}

/**
 * The ONE non-session mint: the owner-gated DO→D1 import
 * (`handlers/corpus-migration.ts`) has to write into *other* users' partitions,
 * because it is moving their corpora for them. It is reachable only from
 * `POST /api/admin/import-do-corpus`, which requires the bootstrap owner's own
 * verified session, and the ids it may name come from the control plane's
 * `users` table — never from a request. Delete this with the import.
 */
export function forAdminImport(driver: SqlDriver, userId: number): TenantDb {
  if (!Number.isSafeInteger(userId)) {
    throw new TenantScopeError("admin import got a non-integer user id", String(userId))
  }
  return makeTenantDb(driver, userId, false)
}

/** The corpus database, behind the shared `SqlDriver` seam. The only read of
 * `env.DB` for tenant data — everything downstream goes through `forTenant`. */
export const corpusDriver = (env: Env): SqlDriver => createD1SqlDriver(env.DB)

/**
 * The control plane (`users`, `allowlist`) — identity and signup gating, which
 * are deliberately NOT tenant-scoped: `resolveTenancy` has to be able to look
 * up an id that is not yet a tenant. Narrow by construction: the tables it
 * reaches have no corpus rows in them.
 */
export const controlPlaneDriver = (env: Env): SqlDriver => createD1SqlDriver(env.DB)

// -----------------------------------------------------------------------------
// Per-tenant corpus bootstrap
// -----------------------------------------------------------------------------

/**
 * `meta` is per-tenant, so a brand-new user starts with no rows in it at all
 * (migration 0004 only stamps the owner's). Seed the two keys the protocol
 * reads, idempotently. `data_version` is deliberately NOT seeded — the
 * transform's empty-corpus rule wants it unset until there is data.
 */
export async function ensureTenantMeta(tenant: TenantDb): Promise<void> {
  await tenant.batch([
    {
      sql:
        "INSERT INTO meta (user_id, key, value) VALUES (:tenant, 'schema_version', ?1) " +
        "ON CONFLICT (user_id, key) DO NOTHING",
      params: [TENANT_SCHEMA_VERSION],
    },
    {
      sql:
        "INSERT INTO meta (user_id, key, value) VALUES (:tenant, 'replica_cursor', '') " +
        "ON CONFLICT (user_id, key) DO NOTHING",
      params: [],
    },
  ])
}

/**
 * The tenant-scoped half of the data-version transform (see the port docs in
 * `src/data/data-version.ts`). Every statement is written out in full, with
 * its tenant predicate — the shape the guard checks, not a stitched fragment.
 */
export function tenantCorpus(tenant: TenantDb): CorpusAccess {
  return {
    readVersion: async () => {
      const rows = await tenant.exec(
        "SELECT value FROM meta WHERE user_id = :tenant AND key = ?1",
        [DATA_VERSION_KEY],
      )
      return rows[0]?.value == null ? null : String(rows[0].value)
    },
    readNodes: async () =>
      (
        await tenant.exec(
          "SELECT id, type, text, props, updated_at FROM nodes " +
            "WHERE user_id = :tenant AND deleted_at IS NULL",
        )
      ).map(toNodeRow),
    readLinks: async () =>
      (
        await tenant.exec(
          "SELECT source_id, destination_id, kind, sort_key, updated_at FROM link " +
            "WHERE user_id = :tenant AND deleted_at IS NULL",
        )
      ).map(toLinkRow),
    write: async (nodes, stampVersion) => {
      const statements: SqlStatement[] = nodes.map((node) => ({
        sql:
          "INSERT INTO nodes (user_id, id, type, text, props, updated_at, deleted_at) " +
          "VALUES (:tenant, ?1, ?2, ?3, ?4, ?5, NULL) " +
          "ON CONFLICT (user_id, id) DO UPDATE SET type = excluded.type, text = excluded.text, " +
          "props = excluded.props, updated_at = excluded.updated_at, " +
          "deleted_at = excluded.deleted_at",
        params: [node.id, node.type, node.text, node.props, node.updated_at],
      }))
      if (stampVersion) {
        statements.push({
          sql:
            "INSERT INTO meta (user_id, key, value) VALUES (:tenant, ?1, ?2) " +
            "ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value",
          params: [DATA_VERSION_KEY, String(CURRENT_DATA_VERSION)],
        })
      }
      if (statements.length > 0) await tenant.batch(statements)
    },
  }
}
