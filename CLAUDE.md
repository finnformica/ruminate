# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Ruminate is a note-taking web application built with React and TypeScript. Notes are outlines of typed blocks (a Logseq-style block editor) held in a graph: nodes plus child links, stored in SQLite in the browser and replicated to Cloudflare D1 behind a Worker. GitHub is used for identity only. Features include block search with a query language, daily and weekly notes, maths, links (inline, and as cards with a page preview), and (behind a switch) images.

## Development Commands

### Core Development

- `npm run dev` - Start the Vite dev server (frontend only)
- `npm run dev:worker` - Build and serve the full app + API via `wrangler dev`
- `npm run build` - Build for production (includes TypeScript compilation; regenerates the route tree)
- `npm run preview` - Preview production build locally
- `npm run deploy` - Deploy the Worker
- `npm run migrate:remote` - Apply D1 migrations remotely

### Testing

- `npm test` - Run all tests once
- `npm run test:watch` - Run tests in watch mode
- `npm run test:vr` - Visual regression against the committed baselines (CI's platform is authoritative; see docs/visual-regression.md)
- `npm run test:fold` / `npm run test:select` - The fold's motion, and the multi-block selection's keys, in a real browser over the Storybook build (`e2e/`)

### Code Quality

- `npm run lint` - Run ESLint on source files
- `npm run format` - Format code with Prettier
- `npm run knip` - Find unused files, dependencies and exports
- `npm run check:queries` / `npm run check:worker` - Worker-side checks
- `npm run check:changelog` - Check every file under `changelog/`

### Storybook

- `npm run dev:storybook` - Start Storybook development server
- `npm run build:storybook` - Build Storybook for production
- `npm run test:storybook` - Run Storybook tests
- `npm run test:storybook:watch` - Run Storybook tests in watch mode

## Architecture

### Data

- **The graph is truth** (docs/graph-schema-v2.md, docs/graph-storage.md): `nodes` (id, type, text, props) and `link` rows (source, destination, fractional sort key). A page is a node of type `page`; its title is its `text` and its metadata is its `props` (docs/metadata.md). There is no frontmatter: markdown is only an import/export format (`src/blocks/parse.ts`, `src/blocks/serialize.ts`).
- **Store** (`src/data/note-store.ts`, `sql-note-store.ts`): eight methods — `getGraph`, `applyOps`, `getAllRows`, `applyPull`, `clear`, `getMeta`, `setMeta`, `close` — over a `SqlDriver` (sqlite-wasm with OPFS in the browser, `node:sqlite` in tests). The store never sees markdown.
- **Ops** (`src/data/ops.ts`): every edit is a batch of ops (`create`, `setText`, `setType`, `setProps`, `link`, `unlink`, `delete`) applied to the in-memory `GraphSnapshot` and persisted verbatim. `docToOps` diffs an edited doc against the snapshot; `deleteBlockOps` / `deletePageOps` carry the delete-rescue rules.
- **Runtime** (`src/data/database-mode.ts`): holds the live graph atom, coalesces pending ops, and pushes/pulls row diffs to the D1 replica through the Worker (`worker/handlers/replica.ts`).
- **Notes as metadata** (`src/data/note-meta.ts`): `Note` objects (title, dates, props) are derived from the graph for lists, search and the calendar.
- **Shared notes** (`src/data/shared-mode.ts`, docs/sharing.md): slices of other users' corpora, fetched whole and held in memory, merged into `graphSnapshotAtom`; the write seam (`src/data/store.ts`) routes a batch of ops to the share it names.

### State

- **Global state** is Jotai atoms (`src/global-state.ts`). The GitHub identity is resolved at boot by the auth atoms there (`signInAtom`, `signOutAtom`, `githubUserAtom`); signed out, the app serves the in-memory sample graph.

### Editor

- **Block editor** (`src/components/block-editor/`, `src/blocks/`): each note is a `BlockDoc` walked out of the graph (`pageDoc`). Block types are declared once in `src/blocks/registry.ts` (markers, markdown lines, slash-menu and search entries) with their presentation in `block-editor/block-kinds.tsx`. Block bodies render through `block-content.tsx`: inline markdown only (bold, italic, links, code spans, `$$…$$` maths), with the stored text otherwise shown as is. Images and link blocks are **figures** (`src/blocks/figure.ts`, `figure-frame.tsx`): one shared layout (`align`/`size`) and frame, with the picture (`image-figure.tsx`) or the card (`link-card.tsx`) inside it.
- **Search** (`src/utils/search.ts`, `block-search.ts`, `search-notes.ts`): the query language in docs/query-language.md, over notes and blocks, with the one query box (input, qualifier popover, scope pills) in `components/query-box.tsx` and the results block in `components/results-list.tsx`, shared by the notes page and the ⌘K palette.

### Routing and Worker

- **Changelog** (docs/changelog.md): a folder of per-change files rather than one document, collated at read time by `src/utils/changelog.ts` — the same module the CI gate uses. The `/changelog` page and the what's-new card are both built from it.
- **Routing**: TanStack Router, file-based under `src/routes/` (`routeTree.gen.ts` is generated by the Vite plugin; never edit it by hand).
- **Worker** (`worker/`): serves the SPA and the API routes — GitHub OAuth (`/github-auth`, `/github-refresh`), the replica (`/api/replica/*`), sharing (`/api/shares/*`, docs/sharing.md), the MCP server (`/mcp`, docs/mcp-server.md), images (`/api/images`, R2, behind `VITE_IMAGES_ENABLED`), link previews for link blocks (`/api/unfurl`, docs/links.md).

### Core Technologies

- **Frontend**: React 18, TypeScript, Vite, Tailwind CSS
- **State**: Jotai
- **Storage**: sqlite-wasm (OPFS) locally, Cloudflare D1 remotely, replicated per row with last-writer-wins
- **Routing**: TanStack Router (file-based)
- **UI**: Base UI (headless) under the app's own primitives in `src/components/ui/` — every raised surface is `Surface` (docs/design-principles.md, Elevation)
- **Markdown**: react-markdown with remark-gfm and remark-math/rehype-katex, inline-only, for block bodies

### File Structure

- `src/blocks/` - Block types (`registry.ts`), parse/serialize, doc operations, keymap and commands
- `src/components/ui/` - The primitives everything else is built from: `Surface` (every card, popup and modal), `Sheet` (the phone's drawers), the Base UI wrappers (Dialog, DropdownMenu, Tooltip, HoverCard, Checkbox), the atoms (Button, AsyncButton, IconButton, PillButton, TextInput, SearchField, Keys, Skeleton, Details) and the list recipes (`listRow`, `listHeading`). Variants are `cva`, and the axis is always `variant`/`size`. Nothing outside `ui/` spells out a control's own classes. A control that starts a request is busy until it settles: `loading` on Button and IconButton, `AsyncButton` for a click that is the request, `usePending` (`src/hooks/pending.ts`) to hold a flight (docs/design-principles.md, Busy controls).
- `src/components/block-editor/` - The block/outline editor
- `src/components/` - React components with Storybook stories
- `src/data/` - Graph, ops, store, database runtime, note metadata
- `src/hooks/` - Custom React hooks
- `src/routes/` - TanStack Router route definitions
- `src/shortcuts/` - The keyboard shortcut registry (docs/keyboard-shortcuts.md)
- `src/utils/` - Utility functions and helpers
- `src/styles/` - CSS files and styling
- `worker/` - Cloudflare Worker (serves the SPA + API routes)
- `changelog/` - The changelog: one file per change, under the week it was written in (docs/changelog.md)
- `migrations/` - D1 migrations, shared with the local store's schema ladder
- `docs/` - Living design and reference docs
- `e2e/` - Visual regression baselines and runner

## Development Notes

### Testing

- Uses Vitest for unit tests (jsdom where a test needs the DOM: `// @vitest-environment jsdom`)
- Storybook for component testing and documentation; visual regression baselines come from CI
- Test files should be co-located with source files using `.test.ts` / `.test.tsx` suffix

### Code Style

- Prettier configuration: no semicolons, trailing commas, 100 character line length
- ESLint rules enforced for TypeScript, React, and accessibility

### Before Committing

- Run `npm run format` to format code
- Run `npm run lint` to check for errors
- Run `npm run knip` to check for dead code (unused files, dependencies, exports)
- Record user-facing changes in `changelog/<week>/<branch>.md`, one file per branch (docs/changelog.md, `.claude/skills/changelog`)
- Run `npm run check:changelog` to check every changelog file

### Performance

- Bundle analysis available via `npm run build` (generates stats.html in the repo root — kept out of `dist/` so it is never deployed or precached)
- PWA configuration for offline functionality
- Lazy loading and code splitting implemented
