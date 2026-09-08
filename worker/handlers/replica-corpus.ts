// Every corpus query and write, expressed against a `TenantDb`
// (worker/tenancy-db.ts) — which is itself a thin scope over the shared
// `SqlDriver` seam (`src/data/sql-driver.ts`), so this module stays pure of
// platform types (no Cloudflare imports) and the worker test suites run it on
// `node:sqlite` (docs/multi-tenant-design.md §10).
//
// The wire format, validation, and SQL planning stay in `replica-payload.ts`,
// shared with the client; this module only *runs* those plans and the pull /
// status reads.
//
// **Tombstones and replication.** Since soft deletes, a deleted row is still a
// row: it carries `deleted_at` and replicates like any other change, which is
// how a delete reaches another device. So every replica READ here is an
// `includingDeleted()` read — replication is exactly the audit-shaped case
// that opt-out exists for, and each statement says so in a `/* includes-deleted
// */` comment the CI guard reads too. Only `corpusStatus`, which answers "how
// big is my corpus", counts live rows.
//
// Every statement is written out in full rather than assembled from fragments:
// the guard checks the string that actually runs, so the string that actually
// runs is the one a reader sees.

import type { TenantDb } from "../tenancy-db"
import {
  planReplicaPut,
  toLinkRow,
  toNodeRow,
  type LinkKey,
  type LinkRow,
  type NodeRow,
  type ReplicaChangesBody,
  type ReplicaCorpusBody,
  type ReplicaPutPayload,
  type ReplicaPutResult,
  type ReplicaStatusBody,
} from "./replica-payload"

async function readCursor(tenant: TenantDb): Promise<string | null> {
  const rows = await tenant.exec(
    "SELECT value FROM meta WHERE user_id = :tenant AND key = 'replica_cursor'",
  )
  return (rows[0]?.value as string | null | undefined) ?? null
}

/** Full pull: every row of both tables, plus the replica cursor. */
export async function corpusPullFull(tenant: TenantDb): Promise<ReplicaCorpusBody> {
  const all = tenant.includingDeleted()
  const nodes = (
    await all.exec(
      "SELECT id, type, text, props, updated_at, deleted_at FROM nodes " +
        "WHERE user_id = :tenant /* includes-deleted: replication carries tombstones */",
    )
  ).map(toNodeRow)
  const links = (
    await all.exec(
      "SELECT source_id, destination_id, kind, sort_key, updated_at, deleted_at FROM link " +
        "WHERE user_id = :tenant /* includes-deleted: replication carries tombstones */",
    )
  ).map(toLinkRow)
  return { nodes, links, cursor: await readCursor(tenant) }
}

/**
 * Incremental pull: rows with `updated_at > since` (tombstones included — a
 * delete bumps `updated_at`, so it arrives as an ordinary change), and nothing
 * else. Two index scans over `nodes_tenant_updated` / `link_tenant_updated`,
 * so a quiet pull reads a handful of rows rather than the corpus.
 *
 * This used to answer with the full key list of both tables as well, so the
 * client could delete local rows absent from them. That predates tombstones,
 * and it cost O(corpus) rows read on **every** pull — every focus, every
 * visibility change, every `online` event, per device. A tombstoned row is an
 * ordinary changed row, so the deletion already travels here; the lists said
 * nothing a client could act on except "purged", and nothing purges
 * (docs/graph-storage.md).
 */
export async function corpusPullSince(
  tenant: TenantDb,
  since: number,
): Promise<ReplicaChangesBody> {
  const all = tenant.includingDeleted()
  const nodes = (
    await all.exec(
      "SELECT id, type, text, props, updated_at, deleted_at FROM nodes " +
        "WHERE user_id = :tenant AND updated_at > ?1 " +
        "/* includes-deleted: a tombstoned row IS the change being pulled */",
      [since],
    )
  ).map(toNodeRow)
  const links = (
    await all.exec(
      "SELECT source_id, destination_id, kind, sort_key, updated_at, deleted_at FROM link " +
        "WHERE user_id = :tenant AND updated_at > ?1 " +
        "/* includes-deleted: a tombstoned row IS the change being pulled */",
      [since],
    )
  ).map(toLinkRow)
  return { nodes, links, cursor: await readCursor(tenant) }
}

/**
 * Apply one validated push as a single atomic batch (per-row LWW — see
 * `planReplicaPut`). The payload must already have passed
 * `parseReplicaPayload`; validation stays at the HTTP boundary. `now` stamps
 * the legacy delete channel: one timestamp for the whole push, so the rows a
 * single delete retires share a stamp and can be revived together.
 */
export async function corpusPut(
  tenant: TenantDb,
  payload: ReplicaPutPayload,
  now: number = Date.now(),
): Promise<ReplicaPutResult> {
  const statements = planReplicaPut(payload, now)
  if (statements.length > 0) await tenant.batch(statements)
  return {
    ok: true,
    nodes: payload.nodes.length,
    links: payload.links.length,
    deletes: (payload.deleteNodes?.length ?? 0) + (payload.deleteLinks?.length ?? 0),
    cursor: payload.cursor ?? null,
  }
}

/**
 * LIVE row counts + schema version + cursor, for diagnostics and sync repair.
 *
 * The link count is **joined**, not filtered with `IN (SELECT …)`. The
 * subquery form re-scanned `nodes` per link row — O(links × nodes), measured
 * at 188k rows read on a 442-node corpus, which is what put a barely-used app
 * at 82% of the D1 free-tier daily read limit. Each join is a primary-key
 * lookup on `(user_id, id)`, so the same answer now costs ~1.8k rows: one pass
 * over the tenant's rows plus two seeks per link.
 */
export async function corpusStatus(tenant: TenantDb): Promise<ReplicaStatusBody> {
  const rows = await tenant.exec(
    "SELECT " +
      "(SELECT COUNT(*) FROM nodes WHERE user_id = :tenant AND deleted_at IS NULL) AS nodes, " +
      // Read-time discard applies to counts too: a retained link into a
      // tombstoned node is not part of the graph anyone can see, and counting
      // it would make these figures disagree with the client's.
      "(SELECT COUNT(*) FROM link " +
      "JOIN nodes AS src ON src.user_id = link.user_id AND src.id = link.source_id " +
      "AND src.deleted_at IS NULL " +
      "JOIN nodes AS dst ON dst.user_id = link.user_id AND dst.id = link.destination_id " +
      "AND dst.deleted_at IS NULL " +
      "WHERE link.user_id = :tenant AND link.deleted_at IS NULL) AS links, " +
      "(SELECT COUNT(*) FROM nodes WHERE user_id = :tenant AND deleted_at IS NULL " +
      "AND type = 'page') AS pages, " +
      "(SELECT value FROM meta WHERE user_id = :tenant AND key = 'schema_version') " +
      "AS schema_version, " +
      "(SELECT value FROM meta WHERE user_id = :tenant AND key = 'replica_cursor') " +
      "AS replica_cursor",
  )
  const row = rows[0] as
    | {
        nodes: number
        links: number
        pages: number
        schema_version: string | null
        replica_cursor: string | null
      }
    | undefined
  return {
    counts: {
      nodes: row?.nodes ?? 0,
      links: row?.links ?? 0,
      pages: row?.pages ?? 0,
    },
    schema_version: row?.schema_version ?? null,
    replica_cursor: row?.replica_cursor ?? null,
  }
}
