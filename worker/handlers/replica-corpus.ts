// The engine-agnostic half of the replica API: every corpus query and write,
// expressed against the `SqlDriver` seam (`src/data/sql-driver.ts`) so the
// exact same code serves the per-user `UserCorpus` Durable Object
// (`worker/corpus-do.ts`, over `ctx.storage.sql`), the D1 export read used by
// the tenant-#1 migration (`worker/d1-sql-driver.ts`), and the `node:sqlite`
// test engine. This module is deliberately pure of platform types — no
// Cloudflare imports — which is what keeps the Cloudflare-specific surface a
// thin adapter (docs/multi-tenant-design.md §10).
//
// The wire format, validation, and SQL planning stay in `replica-payload.ts`,
// shared with the client; this module only *runs* those plans and the pull /
// status reads that used to live inline (D1-specific) in `replica.ts`.

import type { SqlDriver } from "../../src/data/sql-driver"
import {
  planReplicaPut,
  type LinkKey,
  type LinkRow,
  type NodeRow,
  type ReplicaChangesBody,
  type ReplicaCorpusBody,
  type ReplicaPutPayload,
  type ReplicaStatusBody,
} from "./replica-payload"

/** The body of a successful `PUT /api/replica/notes` — applied row counts. */
export interface ReplicaPutResult {
  ok: true
  nodes: number
  links: number
  deletes: number
}

async function readCursor(driver: SqlDriver): Promise<string | null> {
  const rows = await driver.exec("SELECT value FROM meta WHERE key = 'replica_cursor'")
  return (rows[0]?.value as string | null | undefined) ?? null
}

/** Full pull: every row of both tables, plus the replica cursor. */
export async function corpusPullFull(driver: SqlDriver): Promise<ReplicaCorpusBody> {
  const nodes = (await driver.exec(
    "SELECT id, type, text, props, updated_at FROM nodes",
  )) as unknown as NodeRow[]
  const links = (await driver.exec(
    "SELECT source_id, destination_id, kind, sort_key, updated_at FROM link",
  )) as unknown as LinkRow[]
  return { nodes, links, cursor: await readCursor(driver) }
}

/**
 * Incremental pull: rows with `updated_at > since`, plus the FULL key list of
 * each table — the replica keeps no tombstones, so deletions are detectable
 * only by absence from these lists.
 */
export async function corpusPullSince(
  driver: SqlDriver,
  since: number,
): Promise<ReplicaChangesBody> {
  const nodes = (await driver.exec(
    "SELECT id, type, text, props, updated_at FROM nodes WHERE updated_at > ?1",
    [since],
  )) as unknown as NodeRow[]
  const links = (await driver.exec(
    "SELECT source_id, destination_id, kind, sort_key, updated_at FROM link WHERE updated_at > ?1",
    [since],
  )) as unknown as LinkRow[]
  const nodeIds = (await driver.exec("SELECT id FROM nodes")) as unknown as { id: string }[]
  const linkKeys = (await driver.exec(
    "SELECT source_id, destination_id, kind FROM link",
  )) as unknown as { source_id: string; destination_id: string; kind: string }[]
  return {
    nodes,
    links,
    nodeIds: nodeIds.map((row) => row.id),
    linkKeys: linkKeys.map((row): LinkKey => [row.source_id, row.destination_id, row.kind]),
    cursor: await readCursor(driver),
  }
}

/**
 * Apply one validated push as a single atomic batch (per-row LWW — see
 * `planReplicaPut`). The payload must already have passed
 * `parseReplicaPayload`; validation stays at the HTTP boundary.
 */
export async function corpusPut(
  driver: SqlDriver,
  payload: ReplicaPutPayload,
): Promise<ReplicaPutResult> {
  const statements = planReplicaPut(payload)
  if (statements.length > 0) await driver.batch(statements)
  return {
    ok: true,
    nodes: payload.nodes.length,
    links: payload.links.length,
    deletes: (payload.deleteNodes?.length ?? 0) + (payload.deleteLinks?.length ?? 0),
  }
}

/** Row counts + schema version + cursor, for diagnostics and sync repair. */
export async function corpusStatus(driver: SqlDriver): Promise<ReplicaStatusBody> {
  const rows = await driver.exec(
    "SELECT " +
      "(SELECT COUNT(*) FROM nodes) AS nodes, " +
      "(SELECT COUNT(*) FROM link) AS links, " +
      "(SELECT COUNT(*) FROM nodes WHERE type = 'page') AS pages, " +
      "(SELECT value FROM meta WHERE key = 'schema_version') AS schema_version, " +
      "(SELECT value FROM meta WHERE key = 'replica_cursor') AS replica_cursor",
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
