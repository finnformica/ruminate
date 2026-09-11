# Ruminate

A note-taking app built around an outline of blocks. Every note is a tree of typed blocks (text, headings, bullets, to-dos, quotes, code, images) held in a graph of nodes and links, stored in SQLite in your browser and replicated to Cloudflare D1 behind a Worker. Search runs over blocks as well as notes, with a small query language; daily and weekly notes sit on a calendar; tags, maths and (behind a switch) pictures round it out.

Ruminate is built by [Finn Formica](https://github.com/finnformica). It began as a fork of [Lumen](https://github.com/lumen-notes/lumen) by Cole Bemis & contributors (MIT) and has since been rewritten: the storage, sync, editor, search and state layers are Ruminate's own, and Lumen's git-backed markdown files, markdown renderer and note conventions are gone. What remains from Lumen is the design system (Tailwind theme, Radix / Base UI component layer, typography, icons), the app shell and routing, and the calendar.

## How it works

- **The graph is truth.** `nodes` (id, type, text, props) and `link` rows (parent, child, fractional sort key). A page is a node of type `page`; its title is its text and its metadata is its props. Markdown is only an import and export format — see [docs/graph-schema-v2.md](./docs/graph-schema-v2.md) and [docs/graph-storage.md](./docs/graph-storage.md).
- **Every edit is a batch of ops** (`create`, `setText`, `setType`, `setProps`, `link`, `unlink`, `delete`) applied to the in-memory graph and persisted verbatim to a local SQLite database (sqlite-wasm on OPFS), then pushed row by row to D1 with last-writer-wins per row. Other devices pull the rows back. Offline works; the local store is a full replica.
- **GitHub is identity only.** Signing in with GitHub names your tenant; your notes never touch a repository.

## Stack

- React 18 + Vite + TypeScript, Tailwind CSS v4, Radix / Base UI
- Custom block/outline editor (`src/components/block-editor/`, `src/blocks/`)
- Jotai for state, Zod for schemas
- sqlite-wasm (OPFS) locally, Cloudflare D1 remotely, R2 for pictures
- TanStack Router (file-based; `routeTree.gen.ts` is generated)
- Cloudflare Workers (Static Assets) for hosting + the API routes

## Auth

- **Production:** the sign-in button sends you to GitHub; GitHub redirects back to the Worker's `/github-auth` route, which exchanges the `code` for tokens using the **client secret** (a Worker secret, never in the frontend bundle). The access token authenticates the replica API; the refresh token lives in an HttpOnly cookie and `/github-refresh` mints new access tokens silently.
- **Local dev:** set `VITE_GITHUB_PAT` in `.env` to sign in directly with a personal access token (skips OAuth).
- **Who may sign up** is decided by the Worker (`SIGNUP_MODE` in `wrangler.jsonc`): the bootstrap owner, an allowlist, or open. See [docs/multi-tenant-design.md](./docs/multi-tenant-design.md).

## Local development

```bash
npm install
cp .env.example .env            # frontend build vars (VITE_*)
npm run dev                     # http://localhost:5173 — UI only, no API
```

`npm run dev` doesn't run the Worker, so signing in and syncing won't work. For the full app locally, run it through Wrangler with a local D1:

```bash
cp .dev.vars.example .dev.vars               # Worker vars/secrets for local dev
npx wrangler d1 migrations apply ruminate --local
npm run dev:worker                           # builds, then serves app + API via wrangler dev
```

## Deploying to Cloudflare

```bash
# One-time: set the OAuth client id (public) and secret
#   - add VITE_GITHUB_CLIENT_ID under "vars" in wrangler.jsonc (or the dashboard)
npx wrangler secret put GITHUB_CLIENT_SECRET

npm run deploy                  # migrate D1, tsc + vite build, then wrangler deploy
```

Then point your GitHub OAuth app's **Authorization callback URL** at `https://<your-worker-domain>/github-auth`. Pictures need an R2 bucket and `VITE_IMAGES_ENABLED=true` on both sides; see [docs/images.md](./docs/images.md).

### Worker routes

The Worker (`worker/index.ts`) serves the built SPA from `dist/` and handles:

| Route             | Purpose                                                       |
| ----------------- | ------------------------------------------------------------- |
| `/github-auth`    | OAuth `code` → token exchange                                 |
| `/github-refresh` | Mints a fresh access token from the refresh-token cookie      |
| `/api/replica/*`  | Row push / pull for the signed-in tenant's corpus (D1)        |
| `/api/images`     | Picture upload and download (R2), when images are switched on |

## Scripts

```bash
npm run dev            # Vite dev server (frontend only)
npm run dev:worker     # build + wrangler dev (full app with API)
npm run build          # tsc + vite build
npm run deploy         # migrate + build + wrangler deploy
npm run check:worker   # typecheck the Worker
npm run check:queries  # every D1 query goes through the tenancy seam
npm run lint           # eslint
npm run knip           # dead-code check (unused files, deps, exports)
npm run format         # prettier --write
npm run test           # vitest
npm run test:vr        # visual regression (docs/visual-regression.md)
```

## Docs

- [docs/graph-schema-v2.md](./docs/graph-schema-v2.md) — the schema and why
- [docs/graph-storage.md](./docs/graph-storage.md) — the store, sync and migrations
- [docs/block-editor-architecture.md](./docs/block-editor-architecture.md) and [docs/design-principles.md](./docs/design-principles.md) — the editor
- [docs/markdown-syntax.md](./docs/markdown-syntax.md), [docs/metadata.md](./docs/metadata.md), [docs/query-language.md](./docs/query-language.md), [docs/keyboard-shortcuts.md](./docs/keyboard-shortcuts.md) — using the app
- [docs/multi-tenant-design.md](./docs/multi-tenant-design.md), [docs/scaling-thresholds.md](./docs/scaling-thresholds.md) — the server side and its limits

## Credits & license

Ruminate is by [Finn Formica](https://github.com/finnformica), derived from
[Lumen](https://github.com/lumen-notes/lumen) by [Cole Bemis](https://colebemis.com)
& contributors (MIT © 2024 Lumen). Lumen's copyright notice is preserved
alongside Ruminate's in [`LICENSE`](./LICENSE). Ruminate is likewise
MIT-licensed.
