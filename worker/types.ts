import type { UserCorpus } from "./corpus-do"

/**
 * Bindings and variables available to the Worker at runtime.
 *
 * - `ASSETS` serves the built SPA (Workers Static Assets, configured in
 *   wrangler.jsonc). The Worker delegates non-API requests to it.
 * - `DB` is the one database: the control plane (users + allowlist,
 *   docs/multi-tenant-design.md §3) AND every user's corpus, scoped by the
 *   `user_id` column (migration 0004). Nothing outside `worker/tenancy-db.ts`
 *   may touch this binding — a CI guard enforces it
 *   (`npm run check:queries`).
 * - `CORPUS` is the retiring per-user corpus Durable Object namespace, kept
 *   only until every live corpus has been imported into D1
 *   (`POST /api/admin/import-do-corpus`, plus the lazy per-tenant import in
 *   `handlers/replica.ts`). Optional so the follow-up release can drop the
 *   binding without a type change.
 * - `VITE_GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` drive the GitHub OAuth
 *   token exchange. The secret must be set with `wrangler secret put`, never
 *   committed.
 */
export interface Env {
  ASSETS: Fetcher
  DB: D1Database
  CORPUS?: DurableObjectNamespace<UserCorpus>
  VITE_GITHUB_CLIENT_ID: string
  /** Bootstrap owner id: seeds the allowlist, gates /api/admin/*, and keeps
   * auth fail-closed before/without the control-plane migration. */
  ALLOWED_GITHUB_ID: string
  /** Signup gate: "allowlist" | "open"; absent/unknown = bootstrap owner only
   * (fail closed). See worker/handlers/tenancy.ts. */
  SIGNUP_MODE?: string
  GITHUB_CLIENT_SECRET: string
}
