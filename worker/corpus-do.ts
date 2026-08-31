import { DurableObject } from "cloudflare:workers"
import type { LinkRow, NodeRow } from "./handlers/replica-payload"
import type { Env } from "./types"

/**
 * The retiring per-user corpus Durable Object, kept in this release for one
 * job only: **handing its rows back to D1**.
 *
 * Ruminate's corpus lived here between PR #15 and this change; the storage
 * decision was reversed for data visibility (docs/multi-tenant-design.md,
 * "Decision reversal"), so each user's rows move into their `user_id`-scoped
 * partition of D1. Until every live corpus has been imported, the class must
 * keep existing — a `deleted_classes` wrangler migration deletes an object's
 * storage along with the class, so tearing it down early would destroy exactly
 * the data being rescued.
 *
 * What is left is therefore a read-only export shell: no schema ladder (the
 * object already holds a v2 corpus, and writing to it now would only create a
 * second truth), no put path, no cursor writes. The deploy-day order and the
 * follow-up that removes this file are in docs/multi-tenant-design.md.
 */
export class UserCorpus extends DurableObject<Env> {
  /**
   * Every row this object holds. Returns null when the object has no corpus
   * tables at all — a user who signed up after the D1 cutover, or an object
   * that was never written to.
   */
  async exportRows(): Promise<{
    nodes: NodeRow[]
    links: LinkRow[]
    cursor: string | null
  } | null> {
    const sql = this.ctx.storage.sql
    try {
      // tenant-exempt: a DO's private database IS one tenant — placement, not
      // a column. This is the last read before the class is deleted.
      const nodes = sql
        .exec("SELECT id, type, text, props, updated_at FROM nodes")
        .toArray() as unknown as NodeRow[]
      // tenant-exempt: as above — the retiring DO has no user_id column.
      const links = sql
        .exec("SELECT source_id, destination_id, kind, sort_key, updated_at FROM link")
        .toArray() as unknown as LinkRow[]
      // tenant-exempt: as above.
      const cursor = sql
        .exec("SELECT value FROM meta WHERE key = 'replica_cursor'")
        .toArray() as unknown as { value: string }[]
      return { nodes, links, cursor: cursor[0]?.value ?? null }
    } catch {
      return null
    }
  }
}
