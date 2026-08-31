// Module declarations for the worker compilation (`npm run check:worker`).
//
// `*.sql?raw` — Vite's raw-text import, used by worker *test* files (they run
// under vitest, which is Vite) to build the real D1 corpus shape on
// `node:sqlite` from the very files `wrangler d1 migrations apply` runs.
// Nothing wrangler bundles imports SQL any more: D1 applies the ladder itself.
declare module "*.sql?raw" {
  const content: string
  export default content
}
