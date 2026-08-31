-- Migration number: 0001    2026-08-29
--
-- Graph storage, phase 1: the shared schema for the block/note graph.
--
-- One dialect, two engines: this file must run unchanged on Cloudflare D1
-- (the replica, applied via `wrangler d1 migrations apply ruminate`) and on
-- the Phase 2 local SQLite runtime store (wa-sqlite). Keep it to plain SQLite
-- DDL — no engine-specific pragmas or extensions.
--
-- Design notes (see docs/graph-storage.md for the full rationale):
-- * Ids are the app's existing TEXT ids: note ids as-is, block ids in the
--   `blk_` format (`src/blocks/id.ts`). No UUID migration — the ids are
--   already globally unique, stable, and persisted inline in the markdown.
-- * `blocks` stores the outline tree relationally: `(note_id, parent_id,
--   position)` reconstructs the tree; `parent_id` is NULL for root blocks.
--   No FK on parent_id so a note's blocks can be replaced in any order.
-- * `links` is the graph. Edges may point at notes/blocks that do not (yet)
--   exist — a wikilink to an uncreated note is normal — so link targets are
--   deliberately unconstrained (no FKs). For kind = 'tag', `to_note` holds
--   the tag name (tags are name-keyed nodes); for block references
--   (`((blk_x))`), `to_note` is NULL and `to_block` is set.
-- * `view_state` mirrors the `.ruminate/view-state/<id>.json` sidecars:
--   per-note UI state, one row per note, `collapsed` a JSON array of ids.
-- * `meta` carries `schema_version` and `replica_cursor` (the client-supplied
--   marker of the last replicated repo state).

CREATE TABLE notes (
  id TEXT PRIMARY KEY,
  -- Full raw markdown, frontmatter included, byte-for-byte. Git stays the
  -- source of truth in the trial; keeping the verbatim note here makes the
  -- replica independently useful and every block row re-derivable.
  content TEXT NOT NULL,
  -- Milliseconds since epoch (frontmatter `updated_at` when present).
  updated_at INTEGER
);

CREATE TABLE blocks (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  parent_id TEXT,
  position INTEGER NOT NULL,
  -- Raw markdown for this block only (no children, no `id::` line).
  content TEXT NOT NULL
);

-- Outline reads: all of a note's blocks in tree order.
CREATE INDEX blocks_note_position ON blocks (note_id, position);

CREATE TABLE links (
  from_block TEXT NOT NULL,
  to_note TEXT,
  to_block TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('wikilink', 'transclusion', 'tag'))
);

-- One edge per (source, kind, target). COALESCE because SQLite treats NULLs
-- as distinct in unique indexes; the ingest transform already de-duplicates,
-- this makes replays idempotent at the schema level too.
CREATE UNIQUE INDEX links_edge ON links (
  from_block,
  kind,
  COALESCE(to_note, ''),
  COALESCE(to_block, '')
);

-- Backlinks: who points at this note (or tag — kind disambiguates).
CREATE INDEX links_to_note ON links (to_note);
-- Block-level backlinks: who transcludes this block.
CREATE INDEX links_to_block ON links (to_block);
-- Outgoing edges of a block (and cleanup when a note's blocks are replaced).
CREATE INDEX links_from_block ON links (from_block);

CREATE TABLE view_state (
  note_id TEXT PRIMARY KEY,
  -- JSON array of collapsed block ids, canonical (sorted, de-duplicated) —
  -- the same bytes as the `.ruminate/view-state/<id>.json` sidecar.
  collapsed TEXT NOT NULL
);

CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT INTO meta (key, value) VALUES ('schema_version', '1');
INSERT INTO meta (key, value) VALUES ('replica_cursor', '');
