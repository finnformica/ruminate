// Moving live corpora out of the Durable Objects and back into D1
// (docs/multi-tenant-design.md, "Decision reversal" → deploy-day runbook).
//
// The owner and every user who signed up during the DO era have a corpus
// inside `UserCorpus`. This module copies one such corpus into that user's
// `user_id`-scoped partition of D1, through the exact same per-row LWW planner
// a client push uses.
//
// Safety properties:
// - **Read-only on the DO.** The source object is never modified, so the whole
//   operation reverses by ignoring the D1 copy and redeploying the DO route.
// - **Empty-target by default.** Nothing is imported into a non-empty
//   partition unless the caller asks for `merge` — which the OWNER's partition
//   needs, because migration 0004 preserved their *pre-DO* rows there and
//   those are the stale ones.
// - **Merging cannot lose data.** `corpusPut` upserts with
//   `excluded.updated_at >= …`, so a merge can only replace a row with one
//   that is not older. It never deletes.
// - **Idempotent, and marked.** A completed import stamps the tenant's
//   `do_import_at` meta key; a second run is a no-op unless forced. That
//   marker is also what makes the lazy path (below) cost one meta read.
//
// Two callers, one function:
// - the owner-only `POST /api/admin/import-do-corpus` (`admin.ts`), the
//   deliberate, observable run across every known user;
// - the lazy per-tenant check in `replica.ts`, which runs the same import
//   (in `merge` mode) before a user's first post-deploy request is served.
//   Without it, that user's first since-pull would answer with the stale
//   pre-DO key lists and their client would delete everything written during
//   the DO era. That is the destructive failure this closes.

import { corpusPut, corpusStatus, type CorpusRows } from "./replica-corpus"
import type { TenantDb } from "../tenancy-db"

/** The meta key marking that this tenant's DO corpus has been imported. */
export const DO_IMPORT_KEY = "do_import_at"

/** The slice of the retiring `UserCorpus` RPC surface the import needs.
 * Structural, so tests drive it with a plain object. */
export interface DoCorpusSource {
  exportRows(): Promise<(CorpusRows & { cursor: string | null }) | null>
}

export interface CorpusImportResult {
  userId: number
  imported: boolean
  reason: "imported" | "already_imported" | "corpus_not_empty" | "do_empty" | "do_unavailable"
  nodes: number
  links: number
}

export interface CorpusImportOptions {
  /** LWW-merge into a non-empty partition instead of refusing it. */
  merge?: boolean
  /** Re-run even though the tenant is already marked imported. */
  force?: boolean
  /** Injectable clock (the marker's value). */
  now?: () => number
}

async function readMarker(tenant: TenantDb): Promise<string | null> {
  const rows = await tenant.exec("SELECT value FROM meta WHERE user_id = :tenant AND key = ?1", [
    DO_IMPORT_KEY,
  ])
  return rows[0]?.value == null ? null : String(rows[0].value)
}

async function writeMarker(tenant: TenantDb, at: number): Promise<void> {
  await tenant.batch([
    {
      sql:
        "INSERT INTO meta (user_id, key, value) VALUES (:tenant, ?1, ?2) " +
        "ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value",
      params: [DO_IMPORT_KEY, String(at)],
    },
  ])
}

/**
 * Import one user's DO corpus into their D1 partition. `source` is null when
 * the DO binding is gone (the follow-up release) — then there is nothing to
 * import and the tenant is marked done.
 */
export async function importDoCorpus(
  source: DoCorpusSource | null,
  tenant: TenantDb,
  options: CorpusImportOptions = {},
): Promise<CorpusImportResult> {
  const empty = { userId: tenant.userId, imported: false, nodes: 0, links: 0 }
  const now = options.now?.() ?? Date.now()

  if (options.force !== true && (await readMarker(tenant)) !== null) {
    return { ...empty, reason: "already_imported" }
  }
  if (!source) return { ...empty, reason: "do_unavailable" }

  const exported = await source.exportRows()
  if (!exported || (exported.nodes.length === 0 && exported.links.length === 0)) {
    // Nothing there, and there never will be: mark it so this costs one meta
    // read per isolate from here on.
    await writeMarker(tenant, now)
    return { ...empty, reason: "do_empty" }
  }

  if (options.merge !== true) {
    const status = await corpusStatus(tenant)
    if (status.counts.nodes > 0 || status.counts.links > 0) {
      return { ...empty, reason: "corpus_not_empty" }
    }
  }

  await corpusPut(
    tenant,
    {
      nodes: exported.nodes,
      links: exported.links,
      cursor: exported.cursor ?? undefined,
    },
    now,
  )
  await writeMarker(tenant, now)
  return {
    userId: tenant.userId,
    imported: true,
    reason: "imported",
    nodes: exported.nodes.length,
    links: exported.links.length,
  }
}
