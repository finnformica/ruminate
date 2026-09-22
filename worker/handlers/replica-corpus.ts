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
import { writeRows } from "./event-log"
import {
  toLinkRow,
  toNodeRow,
  toViewRow,
  type LinkRow,
  type NodeRow,
  type ReplicaChangesBody,
  type ReplicaCorpusBody,
  type ReplicaPutPayload,
  type ReplicaPutResult,
  type ReplicaStatusBody,
  type ViewRow,
} from "./replica-payload"

/**
 * The cursor a pull answers with: the highest `seq` among the rows it is
 * returning, or null when it returns none.
 *
 * Derived from the rows THEMSELVES rather than read separately, and that is
 * the whole safety argument. A separate `SELECT MAX(seq)` could observe a
 * write that landed after the row queries ran, and the client would store a
 * cursor for rows it never received — skipping them permanently. A maximum
 * taken over the delivered rows can only ever name something the client has.
 *
 * Null means "nothing new": the client keeps the cursor it already had, which
 * is exactly right, and the next `seq > ?` stays a single index seek.
 */
function cursorOf(nodes: NodeRow[], links: LinkRow[], views: ViewRow[]): string | null {
  let max = 0
  for (const node of nodes) if ((node.seq ?? 0) > max) max = node.seq ?? 0
  for (const link of links) if ((link.seq ?? 0) > max) max = link.seq ?? 0
  for (const view of views) if ((view.seq ?? 0) > max) max = view.seq ?? 0
  return max === 0 ? null : String(max)
}

/** Full pull: every row of all three tables, plus the sequence they reach. */
export async function corpusPullFull(tenant: TenantDb): Promise<ReplicaCorpusBody> {
  const all = tenant.includingDeleted()
  const nodes = (
    await all.exec(
      "SELECT id, type, text, props, updated_at, deleted_at, notes_id, seq FROM nodes " +
        "WHERE user_id = :tenant /* includes-deleted: replication carries tombstones */",
    )
  ).map(toNodeRow)
  const links = (
    await all.exec(
      "SELECT source_id, destination_id, kind, sort_key, updated_at, deleted_at, seq " +
        "FROM link " +
        "WHERE user_id = :tenant /* includes-deleted: replication carries tombstones */",
    )
  ).map(toLinkRow)
  const views = (
    await all.exec(
      "SELECT id, root_id, filter, sort, pinned, sort_key, updated_at, deleted_at, seq " +
        "FROM views " +
        "WHERE user_id = :tenant /* includes-deleted: replication carries tombstones */",
    )
  ).map(toViewRow)
  return { nodes, links, views, cursor: cursorOf(nodes, links, views) }
}

/**
 * Incremental pull: rows with `seq > since` (tombstones included — a delete
 * takes a sequence value like any other write, so it arrives as an ordinary
 * change), and nothing else. Two index seeks on `nodes_tenant_seq` /
 * `link_tenant_seq` / `views_tenant_seq`, so a quiet pull reads one row per
 * table.
 *
 * `seq` is assigned by the replica (`planEventAppend`), so `>` is EXACT: no
 * device clock is involved, nothing can land with a stamp behind the cursor,
 * and the client no longer asks for a ten-minute overlap to cover the
 * possibility. That window was costing a full re-read of every row the device
 * had written in the preceding ten minutes, on every pull.
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
      "SELECT id, type, text, props, updated_at, deleted_at, notes_id, seq FROM nodes " +
        "WHERE user_id = :tenant AND seq > ?1 " +
        "/* includes-deleted: a tombstoned row IS the change being pulled */",
      [since],
    )
  ).map(toNodeRow)
  const links = (
    await all.exec(
      "SELECT source_id, destination_id, kind, sort_key, updated_at, deleted_at, seq " +
        "FROM link " +
        "WHERE user_id = :tenant AND seq > ?1 " +
        "/* includes-deleted: a tombstoned row IS the change being pulled */",
      [since],
    )
  ).map(toLinkRow)
  const views = (
    await all.exec(
      "SELECT id, root_id, filter, sort, pinned, sort_key, updated_at, deleted_at, seq " +
        "FROM views " +
        "WHERE user_id = :tenant AND seq > ?1 " +
        "/* includes-deleted: a tombstoned row IS the change being pulled */",
      [since],
    )
  ).map(toViewRow)
  return { nodes, links, views, cursor: cursorOf(nodes, links, views) }
}

/**
 * Apply one validated push as a single atomic batch: the rows become events
 * (per-row LWW — see `rowsToEvents`), the events are appended, and the tables
 * follow from them (`writeRows`, event-log.ts). The payload must already have
 * passed `parseReplicaPayload`; validation stays at the HTTP boundary. `now`
 * stamps the legacy delete channel: one timestamp for the whole push, so the
 * rows a single delete retires share a stamp and can be revived together.
 *
 * The browser's `replica_cursor` stamp rides in the same transaction.
 */
export async function corpusPut(
  tenant: TenantDb,
  payload: ReplicaPutPayload,
  now: number = Date.now(),
  writer: { device?: string; client?: string | null } = {},
): Promise<ReplicaPutResult> {
  const cursor =
    payload.cursor === undefined
      ? []
      : [
          {
            sql:
              "INSERT INTO meta (user_id, key, value) VALUES (:tenant, 'replica_cursor', ?1) " +
              "ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value",
            params: [payload.cursor],
          },
        ]
  await writeRows(
    tenant,
    payload,
    { actor: tenant.userId, origin: "replica", now, ...writer },
    cursor,
  )
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
      "AND type = 'note') AS pages, " +
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
