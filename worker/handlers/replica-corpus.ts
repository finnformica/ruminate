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
// **Tombstones and replication.** Since soft deletes, a deleted entity is
// still an entity: it carries `deleted_at` and replicates like any other
// change, which is how a delete reaches another device. So every replica
// READ here carries tombstones (`cache-reads.ts`, each statement saying so
// in a `/* includes-deleted */` comment the CI guard reads too). Only
// `corpusStatus`, which answers "how big is my corpus", counts live rows.
//
// The rows are the cache of the log (docs/events-log-cache.md). A device
// pulls the cache itself (`corpusCachePage`) and the log; the row door
// (`corpusPut`) stays for the writers that cannot speak events — MCP, a
// share's grantee — and no route serves rows to a browser any more.
//
// Every statement is written out in full rather than assembled from fragments:
// the guard checks the string that actually runs, so the string that actually
// runs is the one a reader sees.

import type { TenantDb } from "../tenancy-db"
import { NOTE_TYPES } from "../../src/data/graph"
import { appendClientEvents, appendClientKeyEvents, writeRows } from "./event-log"
import { cacheSeqOf, readCachePage } from "./cache-reads"
import type { EventsPutPayload, EventsPutResult } from "../../src/data/events"
import type { KeyEventsPutPayload, KeyEventsPutResult } from "../../src/data/key-events"
import type {
  CachePageBody,
  CachePageCursor,
  ReplicaPutPayload,
  ReplicaPutResult,
  ReplicaStatusBody,
} from "./replica-payload"

/** The most rows one page of the cache carries. */
export const MAX_CACHE_PAGE = 20_000

/**
 * One page of the cache of the log, in primary-key order after `after`:
 * what a new device takes, page by page, before it pulls the log
 * (docs/events-log-cache.md, "Sync is the log, and nothing else").
 */
export async function corpusCachePage(
  tenant: TenantDb,
  after: CachePageCursor | null,
  limit: number = MAX_CACHE_PAGE,
): Promise<Omit<CachePageBody, "replica_id">> {
  const seq = await cacheSeqOf(tenant)
  const rows = await readCachePage(tenant, after, limit)
  const last = rows.length === limit ? rows[rows.length - 1] : undefined
  return {
    rows,
    seq,
    cursor: last === undefined ? null : [last.entity, last.entity_id, last.key],
  }
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
  await writeRows(
    tenant,
    payload,
    { actor: tenant.userId, origin: "replica", now, ...writer },
    cursorStatements(payload.cursor),
  )
  return {
    ok: true,
    nodes: payload.nodes.length,
    links: payload.links.length,
    deletes: (payload.deleteNodes?.length ?? 0) + (payload.deleteLinks?.length ?? 0),
    cursor: payload.cursor ?? null,
  }
}

/** The browser's `replica_cursor` stamp, to ride in a push's transaction. */
const cursorStatements = (cursor: string | undefined) =>
  cursor === undefined
    ? []
    : [
        {
          sql:
            "INSERT INTO meta (user_id, key, value) VALUES (:tenant, 'replica_cursor', ?1) " +
            "ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value",
          params: [cursor],
        },
      ]

/**
 * Apply one validated push of EVENTS — a client of this build's own account
 * of what it did (`opsToEvents`; docs/event-sourcing.md) — as a single atomic
 * batch: stale events dropped, the rest appended and projected
 * (`appendClientEvents`, event-log.ts). The payload must already have passed
 * `parseEventsPayload`; validation stays at the HTTP boundary. The browser's
 * `replica_cursor` stamp rides in the same transaction.
 */
export async function corpusPutEvents(
  tenant: TenantDb,
  payload: EventsPutPayload,
  now: number = Date.now(),
  writer: { device?: string; client?: string | null } = {},
): Promise<EventsPutResult> {
  const landed = await appendClientEvents(
    tenant,
    payload.events,
    { actor: tenant.userId, origin: "replica", now, ...writer },
    cursorStatements(payload.cursor),
  )
  return { ok: true, ...landed, cursor: payload.cursor ?? null }
}

/** `corpusPutEvents` for a push of KEY EVENTS (`opsToKeyEvents`,
 * docs/event-sourcing.md, "Per-key events"), through `appendClientKeyEvents`. */
export async function corpusPutKeyEvents(
  tenant: TenantDb,
  payload: KeyEventsPutPayload,
  now: number = Date.now(),
  writer: { device?: string; client?: string | null } = {},
): Promise<KeyEventsPutResult> {
  const landed = await appendClientKeyEvents(
    tenant,
    payload.events,
    { actor: tenant.userId, origin: "replica", now, ...writer },
    cursorStatements(payload.cursor),
  )
  return { ok: true, ...landed, cursor: payload.cursor ?? null }
}

/**
 * LIVE row counts + schema version + cursor, for diagnostics and sync repair.
 *
 * Over the cache of the log: a live block is one whose `deleted` row says
 * `null`; a live link is one whose own `deleted` row and both ends' say so
 * (read-time discard applies to counts too: a retained link into a
 * tombstoned node is not part of the graph anyone can see), four
 * primary-key seeks per link; a page is a live block whose `type` row names
 * a note type, on the `type` index.
 */
export async function corpusStatus(
  tenant: TenantDb,
): Promise<Omit<ReplicaStatusBody, "replica_id">> {
  const rows = await tenant.exec(
    "SELECT " +
      "(SELECT COUNT(*) FROM events_log_cache WHERE user_id = :tenant AND entity = 'block' " +
      "AND key = 'deleted' AND value = 'null') AS nodes, " +
      "(SELECT COUNT(*) FROM events_log_cache ld " +
      "CROSS JOIN events_log_cache s ON s.user_id = :tenant AND s.entity = 'link' " +
      "AND s.entity_id = ld.entity_id AND s.key = 'source_id' " +
      "CROSS JOIN events_log_cache sl ON sl.user_id = :tenant AND sl.entity = 'block' " +
      "AND sl.entity_id = json_extract(s.value, '$') AND sl.key = 'deleted' AND sl.value = 'null' " +
      "CROSS JOIN events_log_cache d ON d.user_id = :tenant AND d.entity = 'link' " +
      "AND d.entity_id = ld.entity_id AND d.key = 'destination_id' " +
      "CROSS JOIN events_log_cache dl ON dl.user_id = :tenant AND dl.entity = 'block' " +
      "AND dl.entity_id = json_extract(d.value, '$') AND dl.key = 'deleted' AND dl.value = 'null' " +
      "WHERE ld.user_id = :tenant AND ld.entity = 'link' AND ld.key = 'deleted' " +
      "AND ld.value = 'null') AS links, " +
      "(SELECT COUNT(*) FROM json_each(?1) AS j " +
      "CROSS JOIN events_log_cache t ON t.user_id = :tenant AND t.key = 'type' " +
      "AND t.value = json_quote(j.value) " +
      "CROSS JOIN events_log_cache l ON l.user_id = :tenant AND l.entity = 'block' " +
      "AND l.entity_id = t.entity_id AND l.key = 'deleted' AND l.value = 'null') AS pages, " +
      "(SELECT value FROM meta WHERE user_id = :tenant AND key = 'schema_version') " +
      "AS schema_version, " +
      "(SELECT value FROM meta WHERE user_id = :tenant AND key = 'replica_cursor') " +
      "AS replica_cursor " +
      "/* reads-corpus: live counts over the whole cache, read once per session */",
    [JSON.stringify([...NOTE_TYPES])],
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
