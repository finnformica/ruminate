# Architecture notes

> **Superseded by [graph-storage.md](./graph-storage.md).** The database this
> document anticipated has shipped: notes now live in a local SQLite store
> replicated to D1, and the git/markdown storage described below has been
> removed from the app. This file is kept as the historical record of the
> data-model decisions — the parts about block ids, multi-homing, the
> `src/data` seam, and view state are still load-bearing and are referenced
> from the current doc.

A running record of the data-model decisions behind Ruminate's block/note
storage, and why they were made. The goal is to keep the app simple today while
leaving a clean path to a block-level graph (and eventually a database) later.

## Storage model

- **One Markdown file per note is the source of truth.** Notes are page-level
  `.md` files in a GitHub repo; git history gives us versioning, audit, and
  time-travel for free. We deliberately do **not** split storage finer (no
  block-per-file, header-per-file, or subtree-per-file): more files worsen the
  git / lightning-fs / localStorage cost, and none of them deliver "a block that
  exists in multiple places" — the filesystem is a tree, the data is a graph.
- **Blocks are the logical unit, files are the physical unit.** A note parses
  into a block tree (`src/blocks/`). Every block carries a stable id persisted
  inline as an `id::` line, reused across edits/commits (`parse.ts`,
  `serialize.ts`). This is the one property that is expensive to add
  retroactively, so it is already in place — it keeps a future migration a clean
  re-key rather than an archaeology project.
- **Multi-homing is by reference, not by identity.** A block has one canonical
  home; appearing elsewhere is a reference/embed, not a second physical copy.
  "Work" vs "personal" is a namespace/tag concern, never a folder a block is
  trapped in.

## Block ids

- Format is `blk_` + 10 url/markdown-safe chars (`src/blocks/id.ts`). We are
  **not** migrating to UUID: a database keys fine on any `TEXT` primary key, the
  current ids are already globally unique and stable, and shorter ids matter for
  large files. If time-sortable ids (ULID/UUIDv7) are ever wanted, that belongs
  at a DB migration, not before.
- **Duplicate-id protection:** `parse.ts` regenerates any repeated `id::` within
  a document. Without this, a duplicated id (e.g. copy-pasting a block, id line
  and all, in an external editor) would overwrite the earlier block in the
  blocks map and silently lose it. Scope is intra-document; cross-file
  uniqueness is handled at the eventual DB migration.

## Storage seam (`src/data`)

`src/data` is the single module that knows notes are persisted as `<id>.md`
files driven through the XState machine. Everything above it works in terms of
note ids and note content:

- `useWriteNotes` / `useDeleteNoteFile` — note-id-keyed writes/deletes.
- `noteContentsAtom` / `useGetNoteContents` — note content keyed by id,
  excluding non-note files.
- `useWriteFiles` — low-level path-keyed primitive, **for use inside
  `src/data` only**.

The note/tag/task hooks build on this seam rather than touching the machine or
the `.md` convention directly. Swapping the backing store (e.g. to SQLite) means
reimplementing `src/data`; callers do not change. (Follow-up: a few components
still read `notesAtom` directly — fine, since those already survive a swap.)

## View state (collapse) — the `.ruminate/` sidecar

Collapse state is **per-note UI state, not content**, so it lives in
`.ruminate/view-state/<noteId>.json` — one file per note (`src/data/view-state.ts`,
`view-state-parse.ts`, `paths.ts`), separate from note files:

- It rides the same git sync as notes (persists across reloads and devices) but
  is filtered out of the note pipeline (`notesAtom`, `noteContentsAtom`), so
  folding a block never rewrites a note file.
- **One file per note**, not one global file: the old single
  `.ruminate/view-state.json` was rewritten wholesale on every fold burst and
  was the main cross-device merge-conflict hot spot. Per-note files only
  conflict when both devices fold the _same_ note — and even then the pull
  merge driver resolves sidecars ours-wins. The legacy single file is migrated
  lazily: the first view-state write splits it into per-note files and deletes
  it, all in that same commit (`buildViewStateWrite`), so the migration runs
  exactly once.
- Toggles update local state immediately and persist debounced (1s) — a burst of
  folds becomes one commit; a pending write is flushed on note unmount. Content
  is serialized canonically (sorted, de-duplicated) and the write is skipped
  when the bytes are unchanged, so fold-then-unfold produces no commit at all.
- Malformed/missing JSON degrades to empty (`parseViewState` /
  `parseNoteViewState`), so a corrupt sidecar can never break the editor.
- Keeping view state out of content also means it folds cleanly into a future
  SQLite `view_state` table instead of needing to be extracted from note files.

## Sync hardening (git layer)

- **Pull never dead-ends on content conflicts.** `gitPull` is fetch + merge +
  checkout with a custom merge driver (`src/utils/merge-driver.ts`): notes get
  a real diff3 merge where non-overlapping edits from both sides survive and
  each genuinely conflicting hunk takes ours; non-note files (view-state
  sidecars, binary/unknown) merge ours-wins. For every note with a real
  conflicting hunk, the full remote version is preserved as a conflicted-copy
  note (`<id>-conflict-<yyyymmdd-hhmm>`) committed right after the merge —
  nothing is silently lost.
- **Full clones.** `gitClone` no longer uses `depth: 1`; shallow history made
  the merge base unresolvable after divergence (`MergeNotSupportedError`).
  Legacy shallow clones recover in `gitPull` by unshallowing and retrying the
  merge once.
- **Push rejections recover.** A rejected push (someone else pushed first)
  transitions back to pulling, bounded to 3 pull→push attempts per sync cycle
  (`syncAttempts` in the machine context); the checking-status → pulling loop
  shares the same cap. Network/auth errors go straight to the error state.
- **No racing regions.** The commit path and each pull/push hold one exclusive
  `navigator.locks` lock (`src/utils/mutex.ts`, name `ruminate-git`), so a
  commit can never land mid-merge/checkout. Web Locks also span tabs — a free
  partial multi-tab fix.
- **No empty commits.** `writeFiles` skips the commit when `git.statusMatrix`
  (scoped to the written paths) shows nothing staged, and only a real commit
  schedules a sync cycle.

## Sync hardening (auth, UI propagation, error visibility, multi-tab)

- **Refreshed tokens persist.** After every successful `/github-refresh`, the
  new access token + expiries are written back into `localStorage.github_user`
  (`persistRefreshedSession` in `src/utils/github-session.ts` — the single
  write point besides sign-in). Page loads no longer start with a stale expiry
  that blocks the first git op on a refresh round-trip.
- **Proactive refresh is non-fatal.** `ensureFreshToken` swallows a failed
  refresh while the current token is _near_ expiry but not yet expired — the
  op proceeds with the current token and `withAuthRetry`'s 401 path handles
  true expiry. It hard-fails only when the token is already past its expiry.
- **Pulled content reaches the open note.** Pulls update machine context →
  `notesAtom` → note lists/sidebar automatically, but the open note's editor
  holds local state. `useEditorValue` (`src/hooks/editor-value.ts`) re-seeds
  the editor value when the note changes externally and there are no unsaved
  local edits; `BlockNoteEditor` re-parses external `value` changes in place
  (tracking the last value it produced, so live typing is never re-parsed).
  With unsaved edits, the local value is preserved and a non-blocking "note
  updated on another device" notice offers "Show latest" (explicitly discards
  the unsaved edits) or "Dismiss".
- **Sync errors are visible and categorized.** The error entering the sync
  error state is stored in machine context as `{ message, category }`
  (`toSyncError`/`categorizeSyncError` in `src/utils/sync.ts`; categories:
  auth / network / conflict / push-rejected / unknown). The sidebar shows a
  category-specific label ("Sync failed: network"), the tooltip carries the
  message, and clicking the status retries (the error state handles SYNC).
- **"Reset local copy" is safe (and exists).** Settings has an explicit
  re-clone button; both it and the change-repo path run through `cloneRepo`,
  which now backs up unpushed work first: if local `main` differs from
  `origin/main`, notes whose content differs from origin are stashed into
  localStorage (bounded to 2 MB, smallest-first; skipped on quota) and, after
  the clone, restored as conflicted-copy notes and committed
  (`src/utils/local-backup.ts`, reusing the merge driver's copy builder). A
  post-clone sync pushes the restored copies.
- **Multi-tab: one sync leader.** Tabs elect a leader via a
  `ruminate-sync-leader` Web Lock plus BroadcastChannel("ruminate-sync")
  (`src/utils/sync-leader.ts`, started in `_appRoot.tsx`). Only the leader
  does network pulls/pushes; follower tabs re-walk the shared worktree on
  pull, forward pushes as `request-sync` messages, and refresh in-memory notes
  (machine event `REFRESH_FILES` → `refreshing` state) when the leader
  broadcasts `synced`. Fail-open: without BroadcastChannel/locks every tab
  syncs itself, and a new tab starts as leader until it observes another
  holder (safe — the git mutex serializes actual git work across tabs).
- **localStorage quota degrades gracefully.** All writes of the
  `markdown_files` cache go through `src/utils/markdown-cache.ts`: a quota
  failure clears the cache key (so `resolveRepo` falls through to the worktree
  walk instead of serving a stale cache) and raises a one-time warning banner
  via `storageWarningAtom`.

## Note version history (read-only over git; restore is forward-only)

Per-note history is reconstructed on demand from the local repo — no extra
storage or network. `src/utils/note-history.ts` walks commits newest-first
from HEAD toward the root across ALL parents, comparing the note file's blob
oid against its first parent's in each commit and keeping only the commits
where they differ (created, deleted, and modified transitions). Commits that
touched other files — view-state sidecars, other notes — are dropped without
inflating any blobs.

The walk is merge-aware because it has to be: sync resolves cross-device
conflicts newest-wins via real merge commits, so the losing device's version
of a note exists only on a merge's second-parent chain. Versions reachable
only through a second parent are included and flagged `mergeSide` (rendered
"Merged from another device"), which is exactly the version a user needs to
recover after a merge replaced their edit. The first-parent chain (the local
timeline, the "spine") stays unlabeled, and the "Current" marker follows the
newest spine version even when a merge-side entry sorts above it.

Pages are cursor-based — `nextCursor` serializes the walk frontier (commits
seen but not yet examined, with their spine flags), so long histories load
incrementally and diamond-shaped history resumes without gaps or duplicates.
Pages are cached keyed by filepath + HEAD, so a sync invalidates the cache
naturally. The isomorphic-git wiring lives in `src/data/note-history.ts` and,
like the other git read paths, doesn't take the git lock — reads are safe
against the object store, and a concurrent sync just moves HEAD.

The dialog can be opened programmatically at a specific version: pass
`initialSha` to `NoteHistoryDialog`, or from anywhere set
`openNoteHistoryDialogAtom` (`note-history-dialog-state.ts`) with `{ sha }` —
the dialog fetches up to 10 pages looking for it, preselects and scrolls to it,
and falls back to the newest version with a "version not found" note. This is
the hook for routing sync-conflict banners into history instead of creating
conflicted-copy notes.

History is strictly read-only: nothing in the feature ever rewrites commits.
"Restore this version" in `note-history-dialog.tsx` is a normal forward save
through `useSaveNote` (new `updated_at`, new commit, synced like any edit), so
the restored content becomes the newest version and every prior version stays
reachable. The +N/−M summaries are exact line-level LCS counts for normal note
sizes, falling back to an order-insensitive multiset count (flagged `≈`) only
for enormous diffs.

## Scale limits (current file-based model)

The binding constraint is the localStorage cache (~5 MB total across all files),
then full-reparse cost, then merge-conflict blast radius on large shared files.
Practical guidance: keep any single note under ~1 MB / ~15–20k lines and the
whole corpus under ~4 MB. For perspective, ~5 MB is roughly a million words — a
long way off for personal notes — and moving to SQLite removes these ceilings
entirely.

## Deferred (revisit when it bites; SQLite supersedes most)

- ~~localStorage quota guard~~ — done: quota-guarded `markdown_files` cache
  with fs fallback (see "Sync hardening" above).
- Incremental reparse (only reparse changed notes in `notesAtom`).
- ~~View-state sync hardening~~ — done: per-note sidecar files + ours-wins
  merge driver (see "Sync hardening" above). Still deferred within it:
  delete-vs-modify and same-path add/add merges (isomorphic-git's `mergeTree`
  handles neither via the merge driver; they surface as sync errors), and
  union-merging two devices' folds of the same note (ours-wins today).
- Cross-file block-id dedup.
- The block-level graph / event-sourced store / SQLite itself. Git already
  provides audit and time-travel; persisted block ids keep the migration a clean
  re-key when the time comes.
