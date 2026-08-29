-- Migration number: 0002    2026-08-29
--
-- Graph schema v2: blocks-first storage (docs/graph-schema-v2.md).
--
-- The inversion: the block graph becomes truth and markdown becomes a rendered
-- projection (the rollup). The v1 tables (notes/blocks/links/view_state) are
-- dropped — no production users, D1 is re-seedable from a notes checkout.
--
-- One dialect, two engines, same as 0001: this file must run unchanged on
-- Cloudflare D1 and on the local sqlite-wasm store. Plain SQLite DDL only.

CREATE TABLE nodes (
  id TEXT PRIMARY KEY,       -- blk_ ids as-is; page nodes use the note id
  type TEXT NOT NULL,        -- type registry in docs/graph-schema-v2.md; no CHECK
                             -- so new types never need a migration
  text TEXT NOT NULL,        -- marker-free content; for pages, the title
  props TEXT,                -- JSON or NULL; pages: frontmatter; code: language
  updated_at INTEGER NOT NULL  -- ms epoch, drives LWW + since-cursor pulls
);

CREATE INDEX nodes_type ON nodes (type);
CREATE INDEX nodes_updated ON nodes (updated_at);

CREATE TABLE link (
  source_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  destination_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'child',  -- 'child' = containment; room for more
  sort_key TEXT NOT NULL,    -- fractional index; sibling order under a source
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (source_id, destination_id, kind)
);

-- Downstream: a node's children in order.
CREATE INDEX link_source ON link (source_id, kind, sort_key);
-- Upstream: who contains this node (multi-parent lookup, delete-rescue).
CREATE INDEX link_destination ON link (destination_id);

-- Since-cursor pulls read changed link rows the same way as changed nodes.
CREATE INDEX link_updated ON link (updated_at);

DROP TABLE IF EXISTS links;
DROP TABLE IF EXISTS blocks;
DROP TABLE IF EXISTS view_state;
DROP TABLE IF EXISTS notes;

INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '2');
