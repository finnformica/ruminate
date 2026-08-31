// Tenant #1 migration: copy the pre-multi-tenant corpus out of the shared D1
// database into the owner's `UserCorpus` Durable Object
// (docs/multi-tenant-design.md §6, step 3).
//
// Safety properties:
// - **Read-only on D1.** The source rows are never modified or deleted here
//   (§6 step 6, dropping them, is a much-later manual step) — so the whole
//   operation reverses by simply ignoring the DO copy.
// - **Empty-target only.** Nothing is imported unless the DO corpus has zero
//   nodes, so a live corpus can never be clobbered by a re-run.
// - **Idempotent & convergent.** The import goes through the exact same
//   `corpusPut` planner as a client push (per-row LWW upserts), so even a
//   racing double-import converges on the same rows.
// - **Engine-agnostic.** The D1 read is `corpusPullFull` over the D1
//   `SqlDriver`; zero migration-specific SQL exists to drift.
//
// Two callers, one function: the owner-only `POST /api/admin/migrate-corpus`
// endpoint (`admin.ts`), and the lazy fallback in `replica.ts` that runs the
// same import before the owner's first post-deploy sync touches an empty DO —
// closing the window where a pull against a not-yet-migrated corpus would
// report every note absent (and the client would delete them locally).

import type { SqlDriver } from "../../src/data/sql-driver"
import { corpusPullFull, type ReplicaPutResult } from "./replica-corpus"
import type { ReplicaPutPayload, ReplicaStatusBody } from "./replica-payload"

/** The slice of the `UserCorpus` RPC surface the migration needs. Structural,
 * so tests can drive it with a plain object over the test engine. */
export interface CorpusTarget {
  status(): Promise<ReplicaStatusBody>
  put(payload: ReplicaPutPayload): Promise<ReplicaPutResult>
}

export interface CorpusMigrationResult {
  migrated: boolean
  reason: "imported" | "corpus_not_empty" | "d1_empty" | "d1_unavailable"
  nodes: number
  links: number
}

/**
 * Import the D1 corpus (read via `source`, the D1 `SqlDriver`) into `corpus`
 * (the owner's DO) — if and only if the DO corpus is empty.
 */
export async function migrateCorpusFromD1(
  source: SqlDriver,
  corpus: CorpusTarget,
): Promise<CorpusMigrationResult> {
  const status = await corpus.status()
  if (status.counts.nodes > 0 || status.counts.links > 0) {
    return { migrated: false, reason: "corpus_not_empty", nodes: 0, links: 0 }
  }

  let exported
  try {
    exported = await corpusPullFull(source)
  } catch {
    // D1 corpus tables already dropped (§6 step 6) or never created: there is
    // nothing to migrate, which is fine.
    return { migrated: false, reason: "d1_unavailable", nodes: 0, links: 0 }
  }
  if (exported.nodes.length === 0 && exported.links.length === 0) {
    return { migrated: false, reason: "d1_empty", nodes: 0, links: 0 }
  }

  await corpus.put({
    nodes: exported.nodes,
    links: exported.links,
    cursor: exported.cursor ?? undefined,
  })
  return {
    migrated: true,
    reason: "imported",
    nodes: exported.nodes.length,
    links: exported.links.length,
  }
}
