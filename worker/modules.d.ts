// Module declarations for the worker compilation (`npm run check:worker`).
//
// `*.sql` — wrangler bundles these as Text modules (the `rules` stanza in
// wrangler.jsonc); the import yields the file's contents as a string. This is
// the worker-side equivalent of Vite's `?raw` suffix, which the client store
// uses on the very same migration files.
declare module "*.sql" {
  const content: string
  export default content
}

// `*.sql?raw` — Vite's raw-text import, used by worker *test* files (they run
// under vitest, which is Vite) on the same migration files. Never imported
// from code wrangler bundles.
declare module "*.sql?raw" {
  const content: string
  export default content
}
