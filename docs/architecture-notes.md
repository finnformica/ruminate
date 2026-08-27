# Architecture notes

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
  conflict when both devices fold the *same* note — and even then the pull
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

## Scale limits (current file-based model)

The binding constraint is the localStorage cache (~5 MB total across all files),
then full-reparse cost, then merge-conflict blast radius on large shared files.
Practical guidance: keep any single note under ~1 MB / ~15–20k lines and the
whole corpus under ~4 MB. For perspective, ~5 MB is roughly a million words — a
long way off for personal notes — and moving to SQLite removes these ceilings
entirely.

## Deferred (revisit when it bites; SQLite supersedes most)

- localStorage quota guard (graceful degradation instead of a thrown
  `setItem`).
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
