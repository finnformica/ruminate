import { DurableObject } from "cloudflare:workers"
import migration0001 from "../migrations/0001_init.sql"
import migration0002 from "../migrations/0002_nodes.sql"
import { ensureCorpusSchema } from "../src/data/corpus-schema"
import type { SqlDriver } from "../src/data/sql-driver"
import { createDoSqlDriver } from "./do-sql-driver"
import {
  corpusPullFull,
  corpusPullSince,
  corpusPut,
  corpusStatus,
  type ReplicaPutResult,
} from "./handlers/replica-corpus"
import type {
  ReplicaChangesBody,
  ReplicaCorpusBody,
  ReplicaPutPayload,
  ReplicaStatusBody,
} from "./handlers/replica-payload"
import type { Env } from "./types"

/**
 * One user's whole corpus: a SQLite-backed Durable Object addressed by the
 * *server-verified* GitHub id (`env.CORPUS.getByName(String(verifiedId))` in
 * `handlers/replica.ts` — never by anything a client sent). Tenant isolation
 * is placement: no query in this class could return another user's rows,
 * because another user's rows live in a different object's private database.
 *
 * The class is deliberately a thin shell (docs/multi-tenant-design.md §10):
 * `createDoSqlDriver` adapts `ctx.storage.sql` to the same `SqlDriver` seam
 * the browser store and the test engine use, the constructor applies the same
 * `migrations/*.sql` ladder every other engine applies, and each RPC method
 * is one call into the shared, engine-agnostic corpus code
 * (`handlers/replica-corpus.ts`). HTTP concerns — auth, validation, JSON —
 * stay in the Worker; these methods speak already-validated typed payloads.
 */
export class UserCorpus extends DurableObject<Env> {
  private driver: SqlDriver

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.driver = createDoSqlDriver(ctx.storage)
    // Schema-only init: the ladder is a version check plus DDL on mismatch,
    // so a warm constructor rerun (after eviction/hibernation) is one SELECT.
    ctx.blockConcurrencyWhile(() =>
      ensureCorpusSchema(this.driver, { init: migration0001, nodes: migration0002 }),
    )
  }

  /** `GET /api/replica/notes` — every row of both tables, plus the cursor. */
  pullFull(): Promise<ReplicaCorpusBody> {
    return corpusPullFull(this.driver)
  }

  /** `GET /api/replica/notes?since=` — changed rows + full key lists. */
  pullSince(since: number): Promise<ReplicaChangesBody> {
    return corpusPullSince(this.driver, since)
  }

  /** `PUT /api/replica/notes` — one validated push, one atomic transaction. */
  put(payload: ReplicaPutPayload): Promise<ReplicaPutResult> {
    return corpusPut(this.driver, payload)
  }

  /** `GET /api/replica/status` — counts + schema version + cursor. */
  status(): Promise<ReplicaStatusBody> {
    return corpusStatus(this.driver)
  }
}
