# Ruminate

A note-taking app that stores your notes as markdown files in a GitHub repository you own.

Ruminate is built by [Finn Formica](https://github.com/finnformica) on the
foundation of [**Lumen**](https://github.com/lumen-notes/lumen) by Cole Bemis &
contributors (MIT). It began as a fork and has since diverged substantially:

- **From Lumen:** the design system (Tailwind theme, Radix / Base UI component
  layer, typography, icons), the markdown/remark pipeline, the app shell and
  routing, the calendar, command menu, tags and templates, and GitHub OAuth
  login. State stays in **Jotai** + **XState**; schemas in **Zod**.
- **Rewritten since:** the storage layer, the block/outline editor, and sync are
  Ruminate's own work — Lumen's git-backed markdown files gave way to a local
  database that replicates to Cloudflare D1.
- **Removed:** the Supabase database and all AI features. Vercel is replaced by a
  **Cloudflare Worker** that serves the app and the small set of API endpoints.

## Stack

- React 18 + Vite + TypeScript
- Tailwind CSS v4 + Radix / Base UI, `motion`
- Custom block/outline editor (Logseq-style, `src/components/block-editor/`)
- TanStack Router (file-based; `routeTree.gen.ts` is generated)
- Jotai (+ jotai-xstate) and XState for the sync state machine
- Zod for schema validation
- `isomorphic-git` + LightningFS for GitHub-backed storage
- **Cloudflare Workers** (Static Assets) for hosting + API routes

## How auth works

Notes live in your GitHub repo, so the app needs a GitHub token:

- **Production:** the OAuth flow. The sign-in button sends you to GitHub; GitHub
  redirects back to the Worker's `/github-auth` route, which exchanges the
  `code` for an access token using your **client secret** (a Worker secret,
  never in the frontend bundle). The token is returned to the app and used for
  git.
- **Local dev:** set `VITE_GITHUB_PAT` in `.env` to sign in directly with a
  personal access token (skips OAuth).

## Local development

```bash
npm install
cp .env.example .env            # frontend build vars (VITE_*)
npm run dev                     # http://localhost:5173 — UI only, no API
```

`npm run dev` doesn't run the Worker, so **git sync won't work** (the cors-proxy
lives in the Worker). For the full app locally, run it through Wrangler:

```bash
cp .dev.vars.example .dev.vars  # Worker vars/secrets for local dev
npm run dev:worker              # builds, then serves app + API via wrangler dev
```

## Deploying to Cloudflare

```bash
# One-time: set the OAuth client id (public) and secret
#   - add VITE_GITHUB_CLIENT_ID under "vars" in wrangler.jsonc (or the dashboard)
npx wrangler secret put GITHUB_CLIENT_SECRET

npm run deploy                  # tsc + vite build, then wrangler deploy
```

Then point your GitHub OAuth app's **Authorization callback URL** at
`https://<your-worker-domain>/github-auth`.

### Worker routes

The Worker (`worker/index.ts`) serves the built SPA from `dist/` and handles:

| Route           | Purpose                                                     |
| --------------- | ----------------------------------------------------------- |
| `/cors-proxy/*` | Relays git-over-http so the browser can talk to GitHub      |
| `/github-auth`  | OAuth `code` → access-token exchange                        |
| `/file-proxy`   | Proxies binary files (Git LFS blobs)                        |
| `/git-lfs-file` | Resolves/uploads Git LFS objects                            |
| `/share/*`      | OG meta tags for shared-note link previews (SPA for humans) |

## Scripts

```bash
npm run dev          # Vite dev server (frontend only)
npm run dev:worker   # build + wrangler dev (full app with API)
npm run build        # tsc + vite build
npm run deploy       # build + wrangler deploy
npm run check:worker # typecheck the Worker
npm run lint         # eslint
npm run knip         # dead-code check (unused files, deps, exports)
npm run format       # prettier --write
npm run test         # vitest
```

## Credits & license

Ruminate is by [Finn Formica](https://github.com/finnformica), derived from
[Lumen](https://github.com/lumen-notes/lumen) by [Cole Bemis](https://colebemis.com)
& contributors (MIT © 2024 Lumen). Lumen's copyright notice is preserved
alongside Ruminate's in [`LICENSE`](./LICENSE). Ruminate is likewise
MIT-licensed.
