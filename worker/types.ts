/**
 * Bindings and variables available to the Worker at runtime.
 *
 * - `ASSETS` serves the built SPA (Workers Static Assets, configured in
 *   wrangler.jsonc). The Worker delegates non-API requests to it.
 * - `VITE_GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` drive the GitHub OAuth
 *   token exchange. The secret must be set with `wrangler secret put`, never
 *   committed.
 * - `DB` is the D1 database holding the note-graph replica (graph storage
 *   phase 3 — see docs/graph-storage.md), served via /api/replica/*.
 */
export interface Env {
  ASSETS: Fetcher
  DB: D1Database
  VITE_GITHUB_CLIENT_ID: string
  /** GitHub numeric user id allowed to use the replica API (fail-closed). */
  ALLOWED_GITHUB_ID: string
  GITHUB_CLIENT_SECRET: string
}
