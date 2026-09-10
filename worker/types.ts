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
 * - `VITE_GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` drive the GitHub OAuth
 *   token exchange. The secret must be set with `wrangler secret put`, never
 *   committed.
 * - `IMAGES` (an R2 bucket) and `VITE_IMAGES_ENABLED` switch on image
 *   uploads (worker/handlers/images.ts, docs/images.md). Both optional: with
 *   either missing the image routes answer 501 and the feature is a no-op.
 */
export interface Env {
  ASSETS: Fetcher
  DB: D1Database
  VITE_GITHUB_CLIENT_ID: string
  /** Bootstrap owner id: seeds the allowlist, and keeps auth fail-closed
   * before/without the control-plane migration. */
  ALLOWED_GITHUB_ID: string
  /** Signup gate: "allowlist" | "open"; absent/unknown = bootstrap owner only
   * (fail closed). See worker/handlers/tenancy.ts. */
  SIGNUP_MODE?: string
  GITHUB_CLIENT_SECRET: string
  /** Image bytes (docs/images.md). Absent until the bucket is bound. */
  IMAGES?: R2Bucket
  /** "true" switches the image routes on; the same variable, at build time,
   * switches the client's upload paths on. Anything else = off. */
  VITE_IMAGES_ENABLED?: string
}
