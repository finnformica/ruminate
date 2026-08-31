import type { UserCorpus } from "./corpus-do"

/**
 * Bindings and variables available to the Worker at runtime.
 *
 * - `ASSETS` serves the built SPA (Workers Static Assets, configured in
 *   wrangler.jsonc). The Worker delegates non-API requests to it.
 * - `DB` is the control-plane D1 database: users + allowlist
 *   (docs/multi-tenant-design.md §3) — plus, until the tenant-#1 migration
 *   has soaked, the legacy pre-multi-tenant corpus rows.
 * - `CORPUS` is the per-user corpus Durable Object namespace; each user's
 *   note graph lives in the object addressed by their verified GitHub id
 *   (worker/corpus-do.ts), served via /api/replica/*.
 * - `VITE_GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` drive the GitHub OAuth
 *   token exchange. The secret must be set with `wrangler secret put`, never
 *   committed.
 */
export interface Env {
  ASSETS: Fetcher
  DB: D1Database
  CORPUS: DurableObjectNamespace<UserCorpus>
  VITE_GITHUB_CLIENT_ID: string
  /** Bootstrap owner id: seeds the allowlist, gates /api/admin/*, and keeps
   * auth fail-closed before/without the control-plane migration. */
  ALLOWED_GITHUB_ID: string
  /** Signup gate: "allowlist" | "open"; absent/unknown = bootstrap owner only
   * (fail closed). See worker/handlers/tenancy.ts. */
  SIGNUP_MODE?: string
  GITHUB_CLIENT_SECRET: string
}
