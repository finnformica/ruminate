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
 * - `IMAGE_LINK_SECRET` signs the download links the MCP `get_image` tool
 *   mints (worker/handlers/image-links.ts).
 */
import type { RateLimiter } from "./mcp/rate-limit"

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
  /** Overrides the code default in replica.ts — raise to shut out old clients. */
  MIN_REPLICA_PROTOCOL?: string
  GITHUB_CLIENT_SECRET: string
  /** Image bytes (docs/images.md). Absent until the bucket is bound. */
  IMAGES?: R2Bucket
  /** "true" switches the image routes on; the same variable, at build time,
   * switches the client's upload paths on. Anything else = off. */
  VITE_IMAGES_ENABLED?: string
  /**
   * Signs the fifteen-minute download links `get_image` hands an MCP agent
   * (worker/handlers/image-links.ts). A secret, set with `wrangler secret
   * put IMAGE_LINK_SECRET`. Without it the tool refuses and says what to
   * set.
   */
  IMAGE_LINK_SECRET?: string
  /**
   * The burst half of the MCP rate limit (docs/mcp-rate-limiting.md) —
   * Cloudflare's rate-limiting binding, keyed by token id, configured in
   * wrangler.jsonc. Optional: a deployment without it is still limited daily,
   * just more slowly, which is the right reading of a binding that has not
   * been rolled out yet.
   */
  MCP_BURST?: RateLimiter
}
